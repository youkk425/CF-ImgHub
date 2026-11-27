// GET/HEAD /file/<key>：Cache API → R2（占位对象则从 Telegram 取）→ Telegram 备份 → HuggingFace 归档 → 回源旧图床（取回后写入 R2）
// 原样返回字节，不做任何转换；no-transform 让 Polish 等功能不处理图片（HDR 增益图要靠这个保住）
import { isPassive, mimeFromName } from './mime.js';
import { configStore, storesFor, writeStore } from './stores.js';
import { getSettings } from './settings.js';
import { SIDECAR, isPlaceholder, isStub, realSize, tgReady, tgStream } from './telegram.js';
import { SIDECAR as HF_SIDECAR, hfGet, hfHead, hfPath, hfReady, isHfStub } from './huggingface.js';

const LONG_CACHE = 'public, max-age=31536000, immutable, no-transform';
const MISS_CACHE = 'public, max-age=60';
// 可执行类型（SVG/HTML 等）一律沙箱化，防止图床同源变成 XSS 跳板；R2 与归档两条读路共用这一份定义
const SANDBOX_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const CACHE_PUT_LIMIT = 512 * 1024 * 1024; // Cache API 单个对象上限
const LEGACY_LIMIT = 100 * 1024 * 1024; // 回源迁移时整个读进内存，超过就只转发不迁移
// 防盗链内建放行的网页版 RSS 阅读器（含所有子域名）：它们会带自己域名的 Referer（App 版通常不带，本来就放行）。
// 设置里 rss=false 时不放行这份名单。博客等其他网站由设置页填写（allow）；图床自己的域名另外放行
export const RSS_READERS = [
  'feedly.com', 'inoreader.com', 'innoreader.com', 'newsblur.com', 'theoldreader.com', 'feedbin.com', 'bazqux.com',
  'follow.is', 'folo.is', 'feeder.co', 'netvibes.com', 'qireader.com', 'commafeed.com', 'readwise.io', 'feedspot.com',
];

export async function serveFile(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  let key;
  try {
    key = decodeURIComponent(url.pathname.slice('/file/'.length));
  } catch {
    return plain(400, 'Bad file key');
  }
  if (!key || key.startsWith('.')) return plain(404, 'Not Found'); // . 开头是内部对象（设置等）

  // 防盗链放在查缓存之前：缓存里的回应不分来源，判断只看 Referer 和设置（设置在内存里缓存，不额外耗时）
  const settings = await getSettings(env);
  // 已删除：其他机房的 Cache API 里可能还有，先挡掉；也不再回源旧图床
  if (settings.goneSet.has(key)) return notFound();
  if (settings.hotlink && !settings.exemptSet.has(key) && !refererAllowed(request, url, settings)) {
    return plain(403, 'Hotlinking not allowed');
  }

  // 缓存键只取路径，忽略查询串，防止被人用 ?x=1 刷穿缓存
  const cacheUrl = url.origin + url.pathname;
  const cache = caches.default;
  const hit = await cache.match(new Request(cacheUrl, { headers: conditionalHeaders(request) }));
  if (hit) return request.method === 'HEAD' ? withoutBody(hit) : hit;

  const bg = { ctx, cache, cacheUrl };
  for (const store of storesFor(env, key)) {
    const res = await fromStore(env, store.bucket, key, request, bg);
    if (res) {
      if (res.status === 200 && request.method === 'GET') maybeCache(ctx, cache, cacheUrl, res);
      return res;
    }
  }

  // R2 里没有、但 Telegram 里有备份（R2 对象被误删等）：直接从 Telegram 读
  const backup = await fromBackup(env, key, request, bg);
  if (backup) {
    if (backup.status === 200 && request.method === 'GET') maybeCache(ctx, cache, cacheUrl, backup);
    return backup;
  }

  // 再往后是 HuggingFace 归档：清单在主桶 .hf/<key>，丢了就按 key 的纯函数路径直接问桶
  const archived = await fromArchive(env, key, request, bg);
  if (archived) {
    if (archived.status === 200 && request.method === 'GET') maybeCache(ctx, cache, cacheUrl, archived);
    return archived;
  }

  return fromLegacy(request, env, ctx, key, cache, cacheUrl);
}

// 读 R2：找不到返回 null；支持 Range、If-None-Match/If-Modified-Since。
// 占位对象（只存 Telegram 的文件）正文是清单，按清单去 Telegram 取
async function fromStore(env, bucket, key, request, bg) {
  if (request.method === 'HEAD') {
    const obj = await bucket.head(key);
    if (!obj) return null;
    const headers = objectHeaders(obj, key);
    headers.set('Content-Length', String(realSize(obj)));
    return new Response(null, { status: 200, headers });
  }

  let obj;
  let err;
  try {
    obj = await bucket.get(key, { range: request.headers, onlyIf: request.headers });
  } catch (e) {
    err = e; // 范围越界等情况 R2 会抛错
  }
  // 占位对象（Telegram / HuggingFace）：Range 指的是真实文件，不是清单，所以重新整个读出清单
  if (err || (isPlaceholder(obj) && obj.range && request.headers.has('Range'))) {
    const head = await bucket.head(key);
    if (!head) return null;
    if (isPlaceholder(head)) obj = await bucket.get(key, { onlyIf: request.headers });
    else if (request.headers.has('Range')) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    } else throw err;
  }
  if (obj === null) return null;

  const headers = objectHeaders(obj, key);
  if (!('body' in obj)) return new Response(null, { status: 304, headers }); // 条件请求命中
  if (isStub(obj)) return fromTelegram(env, request, headers, await obj.json(), bg);
  // 实验主存：字节只在 HuggingFace，清单在占位对象正文里（侧车 .hf/<key> 是同一份）
  if (isHfStub(obj)) return fromBucket(env, request, headers, await obj.json(), bg);

  if (obj.range && request.headers.has('Range')) {
    const { start, end } = rangeOf(obj.range, obj.size);
    headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// Telegram 备份的清单与原对象的 httpMetadata 一起存在主桶 .tg/<key>
async function fromBackup(env, key, request, bg) {
  if (!tgReady(env)) return null;
  const side = await configStore(env).bucket.get(SIDECAR + key);
  if (!side) return null;
  const manifest = await side.json();
  const headers = objectHeaders(side, key);
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(manifest.size));
    return new Response(null, { status: 200, headers });
  }
  return fromTelegram(env, request, headers, manifest, bg);
}

async function fromTelegram(env, request, headers, manifest, bg) {
  if (!tgReady(env)) return plain(503, 'Telegram storage not configured');
  const size = manifest.size;
  const range = parseRange(request.headers.get('Range'), size);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  let body;
  try {
    body = await tgStream(env, manifest, start, end);
  } catch (err) {
    console.warn(JSON.stringify({ event: 'tg-read-failed', error: err.message }));
    return plain(502, 'Telegram unavailable');
  }
  // Range 回应不进缓存：后台把整个文件取一遍放进缓存，之后的 Range 请求由 Cache API 直接切
  if (range && size <= CACHE_PUT_LIMIT) {
    const full = new Headers(headers);
    full.delete('Content-Range');
    full.set('Content-Length', String(size));
    bg.ctx.waitUntil(
      tgStream(env, manifest)
        .then((b) => bg.cache.put(new Request(bg.cacheUrl), new Response(b, { status: 200, headers: full })))
        .catch((err) => console.warn('tg cache fill failed', err.message)),
    );
  }
  return new Response(body, { status: range ? 206 : 200, headers });
}

// HuggingFace 归档：清单在主桶 .hf/<key>（连同原对象的 httpMetadata）。
// 清单丢了（主桶整桶出事）就按 key 的纯函数路径直接问桶——路径由 hfPath() 决定，所以备份本身不依赖 R2。
async function fromArchive(env, key, request, bg) {
  if (!hfReady(env)) return null;
  const side = await configStore(env).bucket.get(HF_SIDECAR + key);
  let manifest;
  let headers;
  if (side) {
    manifest = await side.json();
    headers = objectHeaders(side, key);
  } else {
    const path = await hfPath(env, key);
    const head = await hfHead(env, path).catch(() => null);
    if (!head) return null;
    manifest = { v: 1, path, size: head.size };
    headers = archiveHeaders(key, head);
  }
  if (!manifest.size) return null;
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(manifest.size));
    return new Response(null, { status: 200, headers });
  }
  return fromBucket(env, request, headers, manifest, bg);
}

// 从桶里取字节：网关的 GetObject 通常 302 到 HF CDN，fetch 默认跟随，访客看不见也不会带上本站 Cookie。
// Range 交给上游判：回 206 就照它的 Content-Range 透传；上游若不认 Range（回 200 全量）就老实回 200，
// 绝不自己编 Content-Range——那会让视频拖动读到错位的字节。
async function fromBucket(env, request, headers, manifest, bg) {
  const size = manifest.size;
  const range = parseRange(request.headers.get('Range'), size);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  let res;
  try {
    res = await hfGet(env, manifest.path, range ? `bytes=${range.start}-${range.end}` : null);
  } catch (err) {
    console.warn(JSON.stringify({ event: 'hf-read-failed', error: err.message }));
    return plain(502, 'Archive unavailable');
  }
  if (!res) return null; // 清单还在、对象没了：继续往下走（回源旧图床 / 404）
  if (range && res.status === 206) {
    headers.set('Content-Range', res.headers.get('Content-Range') || `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    if (size <= CACHE_PUT_LIMIT) fillCacheFromBucket(env, bg, manifest, headers, size);
    return new Response(res.body, { status: 206, headers });
  }
  if (res.status !== 200) return null;
  headers.set('Content-Length', String(Number(res.headers.get('Content-Length')) || size));
  return new Response(res.body, { status: 200, headers });
}

// Range 回应不进缓存：后台再取一整份塞进缓存，之后的 Range 请求由 Cache API 直接切（与 Telegram 备份同处理）
function fillCacheFromBucket(env, bg, manifest, headers, size) {
  const full = new Headers(headers);
  full.delete('Content-Range');
  full.set('Content-Length', String(size));
  bg.ctx.waitUntil(
    hfGet(env, manifest.path)
      .then((r) => r && bg.cache.put(new Request(bg.cacheUrl), new Response(r.body, { status: 200, headers: full })))
      .catch((err) => console.warn('hf cache fill failed', err.message)),
  );
}

// 没有侧车清单时的响应头：Content-Type 来自上游 HEAD，其余与 objectHeaders 同一套安全策略
function archiveHeaders(key, head) {
  const h = new Headers();
  h.set('Content-Type', head.ct || mimeFromName(key));
  h.set('Content-Disposition', 'inline');
  h.set('Cache-Control', LONG_CACHE);
  h.set('Accept-Ranges', 'bytes');
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, ETag');
  h.set('X-Content-Type-Options', 'nosniff');
  if (!isPassive(h.get('Content-Type'))) h.set('Content-Security-Policy', SANDBOX_CSP);
  return h;
}

// 只认单段 bytes=a-b / a- / -n。没有或看不懂返回 null（按整个文件回应），无法满足返回 false
function parseRange(h, size) {
  const m = h && /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2]) || !size) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    return n ? { start: Math.max(0, size - n), end: size - 1 } : false;
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start < size && start <= end ? { start, end } : false;
}

// 回源旧图床：取整个文件 → 写入当前桶 → 再按原请求（可能带 Range）从 R2 返回
async function fromLegacy(request, env, ctx, key, cache, cacheUrl) {
  // 旧图床只有「13 位时间戳_文件名」格式，且只有切换之前的；新 key 被删后不该再回源
  const ts = Number(/^(\d{13})_/.exec(key)?.[1]);
  const before = Number(env.LEGACY_BEFORE) || Infinity;
  if (!env.LEGACY_ORIGIN || !(ts < before)) return notFound();

  let upstream;
  try {
    upstream = await fetch(`${env.LEGACY_ORIGIN}/file/${encodeURIComponent(key)}`, { redirect: 'manual' });
  } catch {
    return plain(502, 'Legacy origin unreachable');
  }
  const type = upstream.headers.get('Content-Type') || '';
  // 旧图床找不到时返回 404，被拦截时可能重定向或返回 HTML；都当作不存在。
  // 404 缓存 60 秒，免得同一个不存在的地址每次都回源
  if (upstream.status !== 200 || /^text\/html/i.test(type)) {
    const res = notFound();
    if (request.method === 'GET') ctx.waitUntil(cache.put(new Request(cacheUrl), res.clone()).catch(() => {}));
    return res;
  }

  const length = Number(upstream.headers.get('Content-Length'));
  if (length > LEGACY_LIMIT) {
    const headers = new Headers(upstream.headers);
    headers.set('Cache-Control', 'public, max-age=86400, no-transform');
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers });
  }

  const body = await upstream.arrayBuffer();
  const store = writeStore(env);
  await store.bucket.put(key, body, {
    httpMetadata: { contentType: type || mimeFromName(key), contentDisposition: 'inline' },
    customMetadata: { source: 'legacy' },
  });
  console.log(JSON.stringify({ event: 'legacy-migrated', key, size: body.byteLength, store: store.binding }));

  const res = await fromStore(env, store.bucket, key, request, { ctx, cache, cacheUrl });
  if (res && res.status === 200 && request.method === 'GET') maybeCache(ctx, cache, cacheUrl, res);
  return res ?? notFound();
}

function objectHeaders(obj, key) {
  const h = new Headers();
  obj.writeHttpMetadata(h);
  if (!h.has('Content-Type')) h.set('Content-Type', mimeFromName(key));
  if (!h.has('Content-Disposition')) h.set('Content-Disposition', 'inline');
  h.set('Cache-Control', LONG_CACHE);
  h.set('ETag', obj.httpEtag);
  h.set('Last-Modified', obj.uploaded.toUTCString());
  h.set('Accept-Ranges', 'bytes');
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, ETag');
  h.set('X-Content-Type-Options', 'nosniff');
  // SVG、HTML 等可以带脚本：禁止执行，防止被当成 XSS 跳板（同域的 /api 会带上管理员的 Cookie）
  if (!isPassive(h.get('Content-Type'))) h.set('Content-Security-Policy', SANDBOX_CSP);
  return h;
}

// 没有 Referer（直接打开、RSS 阅读器、大部分 App）放行；来自博客、图床自身的放行
function refererAllowed(request, url, settings) {
  const ref = request.headers.get('Referer');
  if (!ref) return true;
  let host;
  try {
    host = new URL(ref).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === url.hostname) return true;
  if (settings.domainSet.has(host)) return true;
  const match = (d) => host === d || host.endsWith(`.${d}`);
  return settings.allow.some(match) || (settings.rss && RSS_READERS.some(match));
}

function rangeOf(range, size) {
  if ('suffix' in range && range.suffix !== undefined) {
    const len = Math.min(range.suffix, size);
    return { start: size - len, end: size - 1 };
  }
  const start = range.offset ?? 0;
  const len = range.length ?? size - start;
  return { start, end: Math.min(start + len, size) - 1 };
}

function maybeCache(ctx, cache, cacheUrl, res) {
  if (Number(res.headers.get('Content-Length')) > CACHE_PUT_LIMIT) return;
  ctx.waitUntil(
    cache.put(new Request(cacheUrl), res.clone()).catch((err) => console.warn('cache.put failed', err.message)),
  );
}

// 只把条件请求和 Range 头带进缓存查询，Cache API 会据此返回 304 / 206
function conditionalHeaders(request) {
  const h = new Headers();
  for (const name of ['Range', 'If-None-Match', 'If-Modified-Since']) {
    const v = request.headers.get(name);
    if (v) h.set(name, v);
  }
  return h;
}

function withoutBody(res) {
  return new Response(null, { status: res.status, headers: res.headers });
}

function notFound() {
  return plain(404, 'Not Found', MISS_CACHE);
}

function plain(status, text, cacheControl = 'no-store') {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': cacheControl },
  });
}
