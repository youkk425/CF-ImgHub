// HuggingFace 归档：用 HF Storage Buckets（S3 兼容对象存储）给图片做第三份拷贝，与 Telegram 备份平级。
// 设计见 docs/Huggingface-集成方案.md；只当备份盘，不做主存：bucket 里的对象必须带签名才能读，
// 公开外链与边缘缓存都得靠 Worker 代读，所以它排在读路径末端（Cache API → R2 → Telegram 备份 → 这里）。
//
// 为什么选 bucket（路线 B）而不是私有 git 仓库（路线 A）：
//   路线 A 每次写都是一次 commit，而且删指针不释放 LFS 空间（要联系官方清理，最长 36 h）——
//   图床会反复增删，归档盘只涨不消不能接受。路线 B 语义就是"小号 R2"：删除立即回收、支持 ListObjects。
//   代价是认证走 AWS SigV4 而不是一个 Bearer 头：本文件用 WebCrypto 手写签名，src/ 仍零依赖。
//
// 清单照旧写在主桶（.hf/<key>）：HF bucket 明确不存 x-amz-meta-*（官方文档），customMetadata 无处安放；
// 好处是读回时 Content-Type / Content-Disposition 直接从 R2 侧车对象还原，与 .tg/<key> 同构。
//
// 桶的硬事实（docs/Huggingface-集成方案.md §3 已查证）：
//   · 只认 path-style：https://<namespace>.s3.hf.co/<bucket>/<key>；区域固定 us-east-1；
//   · GetObject 通常返回 302 到 HF CDN，fetch 默认跟随，访客看不到也不会带本站 Cookie；
//   · 不支持 If-None-Match/If-Modified-Since（条件请求会当普通请求处理），所以读回只用 Range；
//   · x-amz-meta-* 被丢弃；Content-Type / Content-Disposition / Cache-Control 会存下来。
//
// 密钥（wrangler secret put）：
//   HF_S3_ACCESS_KEY  HF「Access Tokens」页对某个 token「Generate S3 credentials」得到的 AK（HFAK…）
//   HF_S3_SECRET         同一处生成的 SK；权限等于该 token，务必用只授权这一个桶的 write token
// 变量（wrangler.jsonc vars 或面板）：
//   HF_NAMESPACE  HF 用户名或组织名（桶的归属者）
//   HF_BUCKET     桶名
//   HF_PREFIX     桶内顶层前缀，默认 images
//   HF_ENDPOINT   可选，默认 https://<namespace>.s3.hf.co；只在本机冒烟时才需要改
// 没配齐时 hfReady 为假：本模块一个请求都不发、不打日志，主链路零影响（与 telegram.js 一致）。

import { keyTime } from './stores.js';

const REGION = 'us-east-1';
const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED = 'UNSIGNED-PAYLOAD'; // 流式 PUT 的载荷哈希：整份读进内存算哈希不划算
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 空正文的 SHA-256

export const SIDECAR = '.hf/'; // 备份清单（连同原对象 httpMetadata）写在主桶
export const QUEUE = '.hfq/'; // 太大 / 这次没备份成的待处理标记
export const MAX_HF_BYTES = 30 * 1024 * 1024; // 熔断，不是魔法数：内存 128 MB 与 waitUntil 30 s 双重约束
export const BACKUP_BATCH = 20; // 单次 /api/hf/backup 的文件数（每张 ≈2 次外呼）
export const HF_QUOTA = 100 * 1024 ** 3; // 免费档私有存储 100 GB，用来算配额百分比
export const MAX_SWEEP_BYTES = 200 * 1024 * 1024; // 补备份/cron 的放宽上限：流式拷贝不受 30 秒 waitUntil 约束
const LIST_PAGES = 5; // 用量统计最多扫 5 页 ×1000 个对象，扫不完就标 partial
const QUOTA_TTL = 6 * 3600 * 1000; // 配额检查结果的 per-isolate 缓存
const HF_TIMEOUT = 25 * 1000; // 单次外呼超时：给 waitUntil 的 30 秒留余量

export const hfReady = (env) =>
  Boolean(env.HF_S3_ACCESS_KEY && env.HF_S3_SECRET && env.HF_BUCKET && (env.HF_NAMESPACE || env.HF_ENDPOINT));

// 实验主存 'hf' 的占位对象标记：R2 里只留清单 + 缩略图，字节只在 bucket
export const isHfStub = (obj) => obj?.customMetadata?.stub === 'hf';

export class HfError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter; // S3 的 503 Slow Down 可能带 Retry-After
  }
}

// ---------- 端点与路径 ----------

let endpointWarned = false;

// 带着密钥的主机必须是 HF 官方域名：指到第三方镜像等于把 AK/SK 交给别人
function endpoint(env) {
  let base = String(env.HF_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (!base) base = `https://${String(env.HF_NAMESPACE).trim().toLowerCase()}.s3.hf.co`;
  if (!endpointWarned) {
    let host = '';
    try {
      host = new URL(base).hostname;
    } catch {
      host = '(invalid)';
    }
    if (host !== 's3.hf.co' && !host.endsWith('.s3.hf.co')) {
      endpointWarned = true;
      console.warn(JSON.stringify({ event: 'hf-insecure-endpoint', host })); // 只打主机名，不打密钥
    }
  }
  return base;
}

// 桶内对象路径（不带前导 /）：前缀/年/月/文件名，按 keyTime 的 UTC+8 分月。
// 分月是为了人工浏览友好，也顺手避开 HF「每目录 ≤10k 文件」的上限；解析不出时间的 key 落 unknown/。
// key 已由 stdName()/sanitizeName() 约束（无 /、无 ..），这里仍再过一次白名单——路径必须服务端拼接。
// 非 ASCII 文件名替换成下划线后可能与别的 key 撞车，所以只要改动过就补一段 key 自身摘要的前 8 位。
export async function hfPath(env, key) {
  const prefix = String(env.HF_PREFIX || 'images').replace(/^\/+|\/+$/g, '');
  const ts = keyTime(key);
  const d = Number.isFinite(ts) ? new Date(ts + 8 * 3600 * 1000) : null;
  const dir = d ? `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}` : 'unknown';
  const clean = String(key).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'file';
  const name = clean === key ? clean : `${clean}-${(await sha256hex(key)).slice(0, 8)}`;
  return `${prefix}/${dir}/${name}`;
}

// ---------- SigV4 ----------

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = (data) => crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data).then(hex);
// key 可以是字符串（'AWS4'+secret 这一步）或上一步签出来的 ArrayBuffer；WebCrypto 只收 BufferSource
const hmac = async (key, msg) =>
  crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(msg));

// S3 的 URI 编码：保留 A-Za-z0-9-._~ 与分隔用的 /；~ 不编码，! ' ( ) * 要编码
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const canonPath = (p) => p.split('/').map(uriEncode).join('/');
const canonQuery = (pairs) =>
  pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

const signingKeys = new Map(); // `${date}:${region}:${service}:${ak}` → 派生密钥；一天一份，同 isolate 复用
async function signingKey(secret, date, region, service, ak) {
  const memo = `${date}:${region}:${service}:${ak}`;
  let k = signingKeys.get(memo);
  if (!k) {
    k = await hmac(await hmac(await hmac(await hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
    if (signingKeys.size > 8) signingKeys.delete(signingKeys.keys().next().value);
    signingKeys.set(memo, k);
  }
  return k;
}

// 规范请求 → 待签串 → Authorization 头。
// headers 是「要签的头」，键必须小写、值必须与真正发出的一致，否则一律 403 SignatureDoesNotMatch；
// x-amz-date 由这里补（调用方显式给了就用调用方的，官方 SigV4 测试向量就自己带）。
// 单独导出是为了让 scripts/hf-s3-smoke.mjs 能拿 AWS 官方向量自检——region/service 平时不会覆盖。
export async function sigV4(env, {
  method, path, query = [], headers = {}, payload = EMPTY_SHA, date = new Date(), region = REGION, service = SERVICE,
}) {
  const amzDate = headers['x-amz-date'] || `${date.toISOString().slice(0, 19).replaceAll(/[-:]/g, '')}Z`;
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const signed = { 'x-amz-date': amzDate, ...headers };
  const names = Object.keys(signed).sort();
  const canonical = [
    method,
    canonPath(path),
    canonQuery(query),
    names.map((k) => `${k}:${String(signed[k]).trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'),
    payload,
  ].join('\n');
  const stringToSign = [ALGORITHM, amzDate, scope, await sha256hex(canonical)].join('\n');
  const signature = hex(await hmac(await signingKey(env.HF_S3_SECRET, day, region, service, env.HF_S3_ACCESS_KEY), stringToSign));
  return {
    amzDate,
    scope,
    canonical,
    stringToSign,
    signature,
    headers: signed,
    authorization: `${ALGORITHM} Credential=${env.HF_S3_ACCESS_KEY}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

// 统一出口：拼 URL → 签名 → fetch。GetObject 通常被网关 302 到 HF CDN，fetch 默认跟随，
// 访客既看不到桶名，也不会把本站的 Cookie 带到 huggingface.co。
async function call(env, method, keyPath, { query = [], headers = {}, body = null, payload = EMPTY_SHA } = {}) {
  const path = `/${env.HF_BUCKET}${keyPath ? `/${keyPath}` : ''}`;
  const url = `${endpoint(env)}${canonPath(path)}${query.length ? `?${canonQuery(query)}` : ''}`;
  const { authorization, headers: signed } = await sigV4(env, {
    method,
    path,
    query,
    payload,
    headers: { host: new URL(url).host, 'x-amz-content-sha256': payload, ...headers },
  });
  const sent = { ...signed };
  delete sent.host; // Host 参与签名但不发出去：Workers 按 URL 自己写，值与签名里一致
  const res = await fetch(url, {
    method,
    headers: { ...sent, Authorization: authorization },
    body: method === 'GET' || method === 'HEAD' ? null : body,
    duplex: body instanceof ReadableStream ? 'half' : undefined, // Node 里流式正文必须声明；Workers 忽略
    signal: AbortSignal.timeout(HF_TIMEOUT),
  });
  if (!res.ok && res.status !== 404) throw await asError(method, res); // 404 交调用方判（读路径要落到下一个来源）
  return res;
}

async function asError(method, res) {
  // 只取错误码，绝不把响应头/正文整份写进日志（里面可能有密钥回显）
  const text = res.status === 429 || res.status === 503 ? '' : await res.text().catch(() => '');
  const code = /<Code>([^<]*)</.exec(text)?.[1] || `HTTP ${res.status}`;
  return new HfError(`hf ${method}: ${code}`, res.status, Number(res.headers.get('Retry-After')) || undefined);
}

// ---------- 对象操作 ----------

// 写一个对象。body 可以是 Uint8Array，也可以是 R2 的流：
// 流的情况用 FixedLengthStream 定长转发（Workers 据此写 Content-Length），载荷签名用 UNSIGNED-PAYLOAD，
// 这样 30 MB 的文件也不会整份进内存；已在内存里的（冒烟脚本）就用真哈希，让网关顺手校验完整性。
export async function hfPut(env, key, body, size, contentType) {
  const path = await hfPath(env, key);
  let payload = UNSIGNED;
  let stream = body;
  if (body instanceof Uint8Array) {
    payload = await sha256hex(body);
  } else if (typeof FixedLengthStream === 'function') {
    const fixed = new FixedLengthStream(size);
    void pump(body, fixed.writable, size).catch(() => {}); // 读失败由 fetch 侧报错，这里不留未处理的 rejection
    stream = fixed.readable;
  } else {
    stream = new Uint8Array(await new Response(body).arrayBuffer()); // Node 里没有 FixedLengthStream：冒烟脚本退化成整份缓冲
    payload = await sha256hex(stream);
  }
  await call(env, 'PUT', path, { headers: contentType ? { 'content-type': contentType } : {}, body: stream, payload });
  return { v: 1, path, size, ct: contentType || 'application/octet-stream' };
}

async function pump(src, writable, n) {
  const reader = src.getReader();
  const writer = writable.getWriter();
  let left = n;
  try {
    while (left > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.byteLength > left ? value.subarray(0, left) : value;
      await writer.write(chunk);
      left -= chunk.byteLength;
    }
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => {});
    throw err;
  }
}

// 取回：Range 形如 "bytes=0-1023"，传 null 取整份。找不到返回 null（404 不抛错）。
// 上游支持 Range 时是 206，不支持时是 200 + 整份正文——调用方按 res.status 区分，别硬填 Content-Range。
export async function hfGet(env, path, range) {
  const res = await call(env, 'GET', path, { headers: range ? { range } : {} });
  return res.status === 404 ? null : res;
}

// 只问存在与大小：清单丢失时（主桶整桶出事）按 key 的纯函数路径兜底
export async function hfHead(env, path) {
  const res = await call(env, 'HEAD', path, {});
  if (res.status === 404) return null;
  return { size: Number(res.headers.get('Content-Length')) || 0, ct: res.headers.get('Content-Type') || '' };
}

// 删除会立即释放空间（这正是选路线 B 的理由）。DeleteObject 幂等，404 也算删掉了。
export async function hfDelete(env, paths) {
  let deleted = 0;
  for (const path of paths) {
    await call(env, 'DELETE', path, {});
    deleted++;
  }
  return deleted;
}

// ---------- 用量与配额 ----------

const xmlUnescape = (s) =>
  s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");

// 列桶（ListObjectsV2；HF 不支持 V1），翻页靠 NextContinuationToken
async function hfListPage(env, prefix, token) {
  const query = [['list-type', '2'], ['prefix', prefix], ['max-keys', '1000']];
  if (token) query.push(['continuation-token', token]);
  const xml = await (await call(env, 'GET', '', { query })).text();
  return {
    objects: [...xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)].map((m) => ({
      key: xmlUnescape(m[1]),
      size: Number(m[2]),
    })),
    truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml),
    token: /<NextContinuationToken>([^<]*)</.exec(xml)?.[1],
  };
}

let usage = null;
let usageAt = 0;

// 归档里有多少对象、占多少字节；结果缓存在 isolate 内存（上传链路每条都查配额就太浪费外呼了）
export async function hfUsage(env, { fresh = false } = {}) {
  if (!fresh && usage && Date.now() - usageAt < QUOTA_TTL) return usage;
  const prefix = `${String(env.HF_PREFIX || 'images').replace(/^\/+|\/+$/g, '')}/`;
  let files = 0;
  let bytes = 0;
  let token;
  let pages = 0;
  let partial = false;
  do {
    const page = await hfListPage(env, prefix, token);
    for (const o of page.objects) {
      files++;
      bytes += o.size;
    }
    partial = page.truncated;
    token = page.token;
  } while (token && ++pages < LIST_PAGES);
  usage = { files, bytes, partial };
  usageAt = Date.now();
  return usage;
}

// 配额熔断：写满就停手，剩下的等清理或扩容后再补；统计本身失败时照常备份（别因查不到用量而丢备份）
export async function hfQuotaBlocked(env) {
  try {
    return (await hfUsage(env)).bytes >= HF_QUOTA;
  } catch (err) {
    console.warn(JSON.stringify({ event: 'hf-usage-failed', error: err.message }));
    return false;
  }
}
