// GET/HEAD /file/<key>：Cache API → KV manifest（决定字节在 TG 还是 HF）→ 回源旧图床（取回后写入当前后端）
// 原样返回字节，不做任何转换；no-transform 让 Polish 等功能不处理图片（HDR 增益图要靠这个保住）
// R2 移除后（docs/重构方案-移除R2.md）：字节只在 Telegram / HuggingFace，清单（manifest）在 KV。
// 不再有 R2 占位对象、.tg/ .hf/ 侧车、多桶时间路由——manifest.loc 一个字段决定读哪条字节路。
import { isPassive, mimeFromName } from './mime.js';
import { getManifest } from './meta.js';
import { getSettings } from './settings.js';
import { tgReady, tgStream } from './telegram.js';
import { hfGet, hfReady } from './huggingface.js';

const LONG_CACHE = 'public, max-age=31536000, immutable, no-transform';
const MISS_CACHE = 'public, max-age=60';
// 可执行类型（SVG/HTML 等）一律沙箱化，防止图床同源变成 XSS 跳板
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
  if (!key || key.startsWith('.')) return plain(404, 'Not Found'); // . 开头是内部 key，不对外

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
  const manifest = await getManifest(env, key);
  if (manifest) {
    const res = await readBytes(env, key, manifest, request, bg);
    if (res) {
      if (res.status === 200 && request.method === 'GET') maybeCache(ctx, cache, cacheUrl, res);
      return res;
    }
    // 主存读不到，回退另一份（tg+hf 容灾：主存挂了从备份取）
    const alt = await readAlternate(env, key, manifest, request, bg);
    if (alt) {
      if (alt.status === 200 && request.method === 'GET') maybeCache(ctx, cache, cacheUrl, alt);
      return alt;
    }
  }

  // 没有清单（或清单指向的字节都没了）：尝试从旧图床回源迁移
  return fromLegacy(request, env, ctx, key, cache, cacheUrl);
}

// 按 manifest.loc 读字节。返回 Response 或 null（字节真没了才 null，读失败抛错则回 502 由调用方分流）。
async function readBytes(env, key, m, request, bg) {
  if (m.loc === 'hf') return fromHf(env, key, m, request, bg);
  return fromTg(env, key, m, request, bg);
}

// tg+hf 容灾：主存读不到时从另一份取。仅当 manifest 同时记录了两份字节时才有得回退。
async function readAlternate(env, key, m, request, bg) {
  if (m.loc === 'tg' && m.hf) return fromHf(env, key, m, request, bg);
  if (m.loc === 'hf' && m.tg) return fromTg(env, key, m, request, bg);
  return null;
}

// 从 Telegram 取字节：清单里有分片信息（m.tg.chunks），按 Range 用 tgStream 切。
async function fromTg(env, key, m, request, bg) {
  if (!tgReady(env) || !m.tg) return null;
  const size = m.size;
  const etag = etagFor(m);
  if (request.method === 'HEAD') {
    const headers = manifestHeaders(m, key, etag);
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }
  const cond = conditionalHit(request, etag);
  if (cond) return new Response(null, { status: 304, headers: manifestHeaders(m, key, etag) });

  const range = parseRange(request.headers.get('Range'), size);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const headers = manifestHeaders(m, key, etag);
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  headers.set('Content-Length', String(end - start + 1));
  let body;
  try {
    body = await tgStream(env, m.tg, start, end);
  } catch (err) {
    console.warn(JSON.stringify({ event: 'tg-read-failed', error: err.message }));
    return plain(502, 'Telegram unavailable');
  }
  // Range 回应不进缓存：后台把整个文件取一遍放进缓存，之后的 Range 请求由 Cache API 直接切
  if (range && size <= CACHE_PUT_LIMIT) fillCacheFromTg(env, bg, m, key, headers, size);
  return new Response(body, { status: range ? 206 : 200, headers });
}

// 从 HuggingFace 取字节：网关的 GetObject 通常 302 到 HF CDN，fetch 默认跟随，访客看不见也不会带上本站 Cookie。
// Range 交给上游判：回 206 就照它的 Content-Range 透传；上游若不认 Range（回 200 全量）就老实回 200，
// 绝不自己编 Content-Range——那会让视频拖动读到错位的字节。
async function fromHf(env, key, m, request, bg) {
  if (!hfReady(env) || !m.hf) return null;
  const size = m.size;
  const etag = etagFor(m);
  const headers = manifestHeaders(m, key, etag);
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }
  if (conditionalHit(request, etag)) return new Response(null, { status: 304, headers });

  const range = parseRange(request.headers.get('Range'), size);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  let res;
  try {
    res = await hfGet(env, m.hf.path, range ? `bytes=${range.start}-${range.end}` : null);
  } catch (err) {
    console.warn(JSON.stringify({ event: 'hf-read-failed', error: err.message }));
    return plain(502, 'Archive unavailable');
  }
  if (!res) return null; // 清单还在、对象没了：回 404（调用方分流）
  if (range && res.status === 206) {
    headers.set('Content-Range', res.headers.get('Content-Range') || `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    if (size <= CACHE_PUT_LIMIT) fillCacheFromHf(env, bg, m, key, headers, size);
    return new Response(res.body, { status: 206, headers });
  }
  if (res.status !== 200) return null;
  headers.set('Content-Length', String(Number(res.headers.get('Content-Length')) || size));
  return new Response(res.body, { status: 200, headers });
}

// manifest 统一响应头：Content-Type / Disposition 从清单还原，ETag 由清单派生（KV 没有 R2 的 httpEtag）。
function manifestHeaders(m, key, etag) {
  const h = new Headers();
  const ct = m.httpMetadata?.contentType || mimeFromName(key);
  h.set('Content-Type', ct);
  h.set('Content-Disposition', m.httpMetadata?.contentDisposition || 'inline');
  h.set('Cache-Control', LONG_CACHE);
  h.set('ETag', etag);
  h.set('Accept-Ranges', 'bytes');
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, ETag');
  h.set('X-Content-Type-Options', 'nosniff');
  if (!isPassive(ct)) h.set('Content-Security-Policy', SANDBOX_CSP);
  return h;
}

// 条件请求命中（If-None-Match 对上 ETag）→ 304。KV 没有 R2 的 uploaded 时间，只用 ETag，不认 If-Modified-Since。
function conditionalHit(request, etag) {
  const inm = request.headers.get('If-None-Match');
  return Boolean(inm) && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*');
}

function etagFor(m) {
  return `"${m.size}-${(m.httpMetadata?.contentType || '').length}-${m.loc}"`;
}

// Range 回应不进缓存：后台再取一整份塞进缓存，之后的 Range 请求由 Cache API 直接切
function fillCacheFromTg(env, bg, m, key, headers, size) {
  const full = new Headers(headers);
  full.delete('Content-Range');
  full.set('Content-Length', String(size));
  bg.ctx.waitUntil(
    tgStream(env, m.tg)
      .then((b) => bg.cache.put(new Request(bg.cacheUrl), new Response(b, { status: 200, headers: full })))
      .catch((err) => console.warn('tg cache fill failed', err.message)),
  );
}

function fillCacheFromHf(env, bg, m, key, headers, size) {
  const full = new Headers(headers);
  full.delete('Content-Range');
  full.set('Content-Length', String(size));
  bg.ctx.waitUntil(
    hfGet(env, m.hf.path)
      .then((r) => r && bg.cache.put(new Request(bg.cacheUrl), new Response(r.body, { status: 200, headers: full })))
      .catch((err) => console.warn('hf cache fill failed', err.message)),
  );
}

// 回源旧图床：取整个文件 → 写进当前字节后端 + KV 清单 → 再按原请求（可能带 Range）返回
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
  const { importLegacy } = await import('./api.js');
  const manifest = await importLegacy(env, key, body, type || mimeFromName(key));
  console.log(JSON.stringify({ event: 'legacy-migrated', key, size: body.byteLength, loc: manifest.loc }));

  const res = await readBytes(env, key, manifest, request, { ctx, cache, cacheUrl });
  if (res && res.status === 200 && request.method === 'GET') maybeCache(ctx, cache, cacheUrl, res);
  return res ?? notFound();
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
