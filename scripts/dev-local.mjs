// 零安装的本地预览运行时：内存版 R2 + 内存版 Cache API + public/ 静态资源 + 登录限速
// +（--hf 时）一个假的 HuggingFace Storage Buckets 网关，用来在本地跑通归档/实验主存的线路。
//
// 用途：这台机器上不想 `npm install`（wrangler 与浏览器端编码器都在依赖里）时，仍能在浏览器里
// 点完上传、管理、设置。它不是 workerd 的替代品：R2/Cache 都在内存里，重启即清空，也没有 Durable Objects。
// 标准做法仍然是 `npm install` + `npm run dev`（见 RunLocal.md 第 2 节）。
//
//   node scripts/dev-local.mjs                       # 只存 R2，端口 8787
//   node scripts/dev-local.mjs --hf                  # 再接一个假 HF 网关（端口 8788），可试「实验：仅 HuggingFace」
//
// 凭据优先级：命令行 > .dev.vars > 内置开发默认值（会在启动时打印）。

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// .dev.vars 是 KEY=VALUE 的简单文件，不引 dotenv
const readDevVars = async () => {
  const file = join(ROOT, '.dev.vars');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const bytesOf = async (v) => {
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  return new Uint8Array(await new Response(v).arrayBuffer()); // ReadableStream（上传正文）
};

// R2 的够用子集：put / get(opts.range、opts.onlyIf) / head / delete / list(prefix、cursor、include)
class Bucket {
  #map = new Map();

  async put(key, value, opts = {}) {
    const bytes = await bytesOf(value);
    const etag = crypto.randomUUID().replaceAll('-', '');
    const rec = {
      key,
      bytes,
      size: bytes.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: new Date(),
      httpMetadata: opts.httpMetadata ?? {},
      customMetadata: opts.customMetadata,
    };
    this.#map.set(key, rec);
    return this.#view(rec, false);
  }

  async head(key) {
    const rec = this.#map.get(key);
    return rec ? this.#view(rec, false) : null;
  }

  async get(key, opts = {}) {
    const rec = this.#map.get(key);
    if (!rec) return null;
    const inm = opts.onlyIf?.get?.('if-none-match');
    if (inm && inm.split(',').map((s) => s.trim()).includes(rec.httpEtag)) return this.#view(rec, false); // 条件命中：无 body
    const h = opts.range?.get?.('range');
    const m = h && /^bytes=(\d*)-(\d*)$/.exec(h.trim());
    if (m) {
      const { size } = rec;
      const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
      const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      if (start > end || start >= size) throw new Error('range not satisfiable'); // 与 R2 一致：越界抛错
      return this.#view(rec, true, { offset: start, length: end - start + 1 });
    }
    return this.#view(rec, true);
  }

  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.#map.delete(k);
    return list.length;
  }

  async list({ prefix = '', limit = 1000, cursor, include = [] } = {}) {
    const all = [...this.#map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = cursor ? all.indexOf(cursor) + 1 : 0;
    const page = all.slice(from, from + limit);
    return {
      objects: page.map((k) => this.#view(this.#map.get(k), false, null, include)),
      truncated: from + page.length < all.length,
      cursor: page.length ? page[page.length - 1] : undefined,
    };
  }

  #view(rec, withBody, range = null, include = ['httpMetadata', 'customMetadata']) {
    const view = {
      key: rec.key,
      size: rec.size,
      etag: rec.etag,
      httpEtag: rec.httpEtag,
      uploaded: rec.uploaded,
      range,
      writeHttpMetadata(headers) {
        const md = rec.httpMetadata || {};
        if (md.contentType) headers.set('Content-Type', md.contentType);
        if (md.contentDisposition) headers.set('Content-Disposition', md.contentDisposition);
        if (md.contentLanguage) headers.set('Content-Language', md.contentLanguage);
        if (md.cacheControl) headers.set('Cache-Control', md.cacheControl);
      },
    };
    if (include.includes('httpMetadata')) view.httpMetadata = rec.httpMetadata;
    if (include.includes('customMetadata')) view.customMetadata = rec.customMetadata;
    if (withBody) {
      const part = range ? rec.bytes.subarray(range.offset, range.offset + range.length) : rec.bytes;
      view.body = new Response(part).body;
      view.arrayBuffer = async () => part.slice().buffer;
      view.text = async () => new TextDecoder().decode(part);
      view.json = async () => JSON.parse(new TextDecoder().decode(part));
    }
    return view;
  }
}

// Cache API 的够用子集：match（含 If-None-Match → 304、Range → 206）/ put / delete
class Cache {
  #map = new Map();

  async match(req) {
    const e = this.#map.get(req.url);
    if (!e) return null;
    const inm = req.headers.get('if-none-match');
    if (inm && inm.split(',').map((s) => s.trim()).includes(e.headers.get('etag'))) {
      return new Response(null, { status: 304, headers: e.headers });
    }
    const r = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get('range') || '').trim());
    if (r && e.body.byteLength) {
      const { byteLength } = e.body;
      const start = r[1] === '' ? Math.max(0, byteLength - Number(r[2])) : Number(r[1]);
      const end = r[2] === '' ? byteLength - 1 : Math.min(Number(r[2]), byteLength - 1);
      const h = new Headers(e.headers);
      h.set('Content-Range', `bytes ${start}-${end}/${byteLength}`);
      h.set('Content-Length', String(end - start + 1));
      return new Response(e.body.slice(start, end + 1), { status: 206, headers: h });
    }
    return new Response(e.body.slice(0), { status: 200, headers: e.headers });
  }

  async put(req, res) {
    this.#map.set(req.url, { body: new Uint8Array(await res.arrayBuffer()), headers: new Headers(res.headers) });
  }

  async delete(reqOrUrl) {
    this.#map.delete(typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url);
    return true;
  }
}

// env.ASSETS.fetch：public/ 静态资源；/admin、/settings 解析到对应 .html（与 Workers Assets 的行为对齐）
const assets = async (request) => {
  const url = new URL(request.url);
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p.endsWith('/')) p += 'index.html';
  if (p === '/admin') p = '/admin.html';
  if (p === '/settings') p = '/settings.html';
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(normalize(PUBLIC))) return new Response('Not found', { status: 404 });
  try {
    return new Response(await readFile(file), {
      headers: { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};

// LOGIN_LIMITER：5 次 / 分钟 / key（本地按进程内存计数）
const loginHits = new Map();
const limiter = {
  async limit({ key }) {
    const now = Date.now();
    const hits = (loginHits.get(key) || []).filter((t) => now - t < 60_000);
    hits.push(now);
    loginHits.set(key, hits);
    return { success: hits.length <= 5 };
  },
};

// 两个 Workers 专有 API 的垫片：FixedLengthStream（Telegram/HF 流式上传用）与 timingSafeEqual（登录比对用）
globalThis.FixedLengthStream ??= class FixedLengthStream {
  constructor(len) {
    this.expected = len;
    const { readable, writable } = new TransformStream();
    this.readable = readable;
    this.writable = writable;
  }
};
if (!crypto.subtle.timingSafeEqual) {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    value(a, b) {
      const [x, y] = [new Uint8Array(a), new Uint8Array(b)];
      if (x.byteLength !== y.byteLength) return false;
      let diff = 0;
      for (let i = 0; i < x.byteLength; i++) diff |= x[i] ^ y[i];
      return diff === 0;
    },
  });
}

// ---------- 假 HuggingFace 网关（--hf）：不验签，只验线路（PUT/GET/HEAD/DELETE/ListObjectsV2 + Range）----------
const fakeHf = new Map(); // `${bucket}/${key}` → { bytes, ct }
const HF_PORT = Number(flag('hf-port', 8788));

function startFakeHf() {
  createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${HF_PORT}`);
    const parts = decodeURIComponent(url.pathname).replace(/^\//, '').split('/');
    const bucket = parts.shift();
    const key = parts.join('/');
    const send = (status, headers = {}, body = null) => {
      res.writeHead(status, headers);
      res.end(body ?? undefined);
    };
    if (!key) {
      const prefix = url.searchParams.get('prefix') || '';
      const items = [...fakeHf.entries()].filter(([id]) => id.startsWith(`${bucket}/${prefix}`));
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
        `<Name>${bucket}</Name><IsTruncated>false</IsTruncated>` +
        items
          .map(([id, o]) => `<Contents><Key>${id.slice(bucket.length + 1)}</Key><Size>${o.bytes.byteLength}</Size></Contents>`)
          .join('') +
        '</ListBucketResult>';
      return send(200, { 'Content-Type': 'application/xml' }, xml);
    }
    const id = `${bucket}/${key}`;
    if (req.method === 'PUT') {
      const bytes = new Uint8Array(await new Response(Readable.toWeb(req)).arrayBuffer());
      fakeHf.set(id, { bytes, ct: req.headers['content-type'] || 'application/octet-stream' });
      return send(200, { ETag: '"local"' });
    }
    if (req.method === 'DELETE') {
      fakeHf.delete(id);
      return send(204);
    }
    const o = fakeHf.get(id);
    if (!o) return send(404, { 'Content-Type': 'application/xml' }, '<Error><Code>NoSuchKey</Code></Error>');
    const headers = { 'Content-Type': o.ct, 'Accept-Ranges': 'bytes', 'Content-Length': String(o.bytes.byteLength) };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] === '' ? Math.max(0, o.bytes.byteLength - Number(m[2])) : Number(m[1]);
      const end = m[2] === '' ? o.bytes.byteLength - 1 : Math.min(Number(m[2]), o.bytes.byteLength - 1);
      const body = o.bytes.slice(start, end + 1);
      return send(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${o.bytes.byteLength}`, 'Content-Length': String(body.byteLength) }, Buffer.from(body));
    }
    return send(200, headers, Buffer.from(o.bytes));
  }).listen(HF_PORT, () => console.log(`假 HF 网关：http://127.0.0.1:${HF_PORT}（不验签，只验线路）`));
}

// ---------- 起服务 ----------

const vars = await readDevVars();
const hfEnabled = has('hf');
if (hfEnabled) startFakeHf();

const env = {
  SESSION_SECRET: flag('session-secret', vars.SESSION_SECRET || 'local-dev-session-secret'),
  UPLOAD_PASSWORD: flag('upload-pass', vars.UPLOAD_PASSWORD || 'dev-upload'),
  ADMIN_USER: flag('admin-user', vars.ADMIN_USER || 'admin'),
  ADMIN_PASSWORD: flag('admin-pass', vars.ADMIN_PASSWORD || 'dev-admin'),
  UPLOAD_TOKEN: flag('token', vars.UPLOAD_TOKEN || 'dev-token'),
  STORES: [{ binding: 'R2_MAIN', from: 0 }],
  R2_MAIN: new Bucket(),
  LOGIN_LIMITER: limiter,
  ASSETS: { fetch: assets },
};
if (hfEnabled) {
  Object.assign(env, {
    HF_S3_ACCESS_KEY: 'local-test',
    HF_S3_SECRET: 'local-test',
    HF_NAMESPACE: 'test',
    HF_BUCKET: 'testbucket',
    HF_PREFIX: 'images',
    HF_ENDPOINT: `http://127.0.0.1:${HF_PORT}`,
  });
}
if (vars.TG_BOT_TOKEN && vars.TG_CHAT_ID) Object.assign(env, { TG_BOT_TOKEN: vars.TG_BOT_TOKEN, TG_CHAT_ID: vars.TG_CHAT_ID });

globalThis.caches ??= { default: new Cache() };
const worker = (await import(new URL(`file:///${ROOT.replaceAll('\\', '/')}/src/index.js`))).default;
const PORT = Number(flag('port', 8787));

const server = createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || `localhost:${PORT}`}${req.url}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
    });
    const pending = [];
    const ctx = {
      waitUntil: (p) => pending.push(Promise.resolve(p).catch((e) => console.warn('waitUntil:', e.message))),
      passThroughOnException() {},
    };
    const response = await worker.fetch(request, env, ctx);
    const headers = {};
    for (const [k, v] of response.headers) if (k.toLowerCase() !== 'content-length') headers[k] = v; // Node 自己算
    res.writeHead(response.status, headers);
    if (!response.body || req.method === 'HEAD') return res.end();
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + err.message);
  }
});

// 浏览器端编码器（AVIF/WebP）是 `npm run vendor` 从 node_modules 复制来的；没装依赖时这里只提示，不阻塞
const vendorMissing = !(await readdir(PUBLIC, { withFileTypes: true }).catch(() => [])).some(
  (d) => d.name === 'vendor',
);

server.listen(PORT, () => {
  console.log(`CF-ImgHub 本地：http://localhost:${PORT}`);
  console.log(`  管理员 ${env.ADMIN_USER} / ${env.ADMIN_PASSWORD}   → /admin、/settings`);
  console.log(`  上传密码 ${env.UPLOAD_PASSWORD}   → / 首页`);
  console.log(`  Bearer token ${env.UPLOAD_TOKEN}   → 脚本上传`);
  console.log(
    hfEnabled
      ? `  HF 假网关：${env.HF_NAMESPACE}/${env.HF_BUCKET} → ${env.HF_ENDPOINT}（存储页可试「实验：仅 HuggingFace」）`
      : '  HF / Telegram 未配置：相关卡片隐藏（只存 R2）',
  );
  if (vendorMissing) console.log('  提示：public/vendor 不存在 → 浏览器端压缩会不可用（上传仍可用，原图直传）');
  console.log('  数据在内存里：Ctrl+C 停止后上传的图片会清空');
});
