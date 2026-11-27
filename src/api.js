// /api/*：登录、上传、删除、列表。权限见 auth.js：upload 角色可上传、可撤回 24 小时内的上传；admin 角色全部可做
// 错误只返回代码（error 字段），由前端按语言翻译
// R2 移除后（docs/重构方案-移除R2.md）：图片字节写 Telegram / HuggingFace，清单（manifest）写 KV。
// 清单是唯一事实来源：{loc, size, name, httpMetadata, tg?, hf?}——loc 记主存，tg/hf 记各自后端的取回信息。
import { pickContentType } from './mime.js';
import { hasRole, identify, login, logoutCookie, sameOrigin } from './auth.js';
import { getSettings, saveSettings, publicSettings, normBgUrl, normLink, normName, normSite, normThemeColor, siteInfo, isFileKey, splitStorage, STORAGE_MODES, MAX_BG, MAX_DOMAINS, MAX_LINKS, MAX_SITES, THEME_MODES, BG_INTERVALS } from './settings.js';
import { BRAND, keyTime } from './stores.js';
import { tgDelete, tgPut, tgReady, tgStream } from './telegram.js';
import {
  BACKUP_BATCH, HF_QUOTA, MAX_HF_BYTES, MAX_SWEEP_BYTES,
  hfDelete, hfGet, hfPut, hfQuotaBlocked, hfReady, hfUsage,
} from './huggingface.js';
import { RSS_READERS } from './serve.js';

// 只对 Bearer 调用开放跨域；Cookie 会话是 SameSite=Strict，跨域请求本来就带不上
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const UNDO_WINDOW = 24 * 3600 * 1000;

export async function handleApi(request, env, ctx, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const path = url.pathname;
  const method = request.method;
  if (path === '/api/ping' && method === 'GET') return json({ ok: true });
  if (path === '/api/login' && method === 'POST') {
    const r = await login(request, env, url);
    return json(r.body, r.status, r.cookie);
  }
  if (path === '/api/logout' && method === 'POST') return json({ ok: true }, 200, logoutCookie(url));
  // 登录页也要用：背景图与页脚链接（不含任何需要保密的设置）
  if (path === '/api/site' && method === 'GET') return json(siteInfo(await getSettings(env)));

  const role = await identify(request, env);
  if (path === '/api/session' && method === 'GET') {
    // domains：已登录时告诉前端还能用哪些域名生成链接
    const domains = role ? (await getSettings(env)).domains : undefined;
    return json({ role, user: role === 'admin' ? env.ADMIN_USER : undefined, domains });
  }
  if (!role) return json({ error: 'unauthorized' }, 401);
  if (method !== 'GET' && !sameOrigin(request, url)) return json({ error: 'bad_origin' }, 403);

  if (path === '/api/upload' && method === 'POST') return upload(request, env, ctx, url);
  if (path.startsWith('/api/file/') && method === 'DELETE') {
    let key;
    try {
      key = decodeURIComponent(path.slice('/api/file/'.length));
    } catch {
      return json({ error: 'bad_key' }, 400);
    }
    if (!key) return json({ error: 'bad_key' }, 400);
    if (!hasRole(role, 'admin') && !recent(key)) return json({ error: 'forbidden' }, 403);
    await removeKeys(env, url, [key]);
    return json({ ok: true, key });
  }

  // 缩略图（浏览器生成的 WebP，见 public/thumb.js）：登录即可读；上传角色只能给 24 小时内的文件写
  if (path.startsWith('/api/thumb/') && (method === 'GET' || method === 'POST')) {
    let key;
    try {
      key = decodeURIComponent(path.slice('/api/thumb/'.length));
    } catch {
      return json({ error: 'bad_key' }, 400);
    }
    if (!isFileKey(key)) return json({ error: 'bad_key' }, 400);
    if (method === 'GET') return getThumbRoute(env, key);
    if (!hasRole(role, 'admin') && !recent(key)) return json({ error: 'forbidden' }, 403);
    return putThumbRoute(env, key, request);
  }

  if (!hasRole(role, 'admin')) return json({ error: 'forbidden' }, 403);
  if (path === '/api/list' && method === 'GET') return list(env, url);
  if (path === '/api/stats' && method === 'GET') return stats(env);
  if (path === '/api/settings' && method === 'GET') return json(settingsOut(env, await getSettings(env)));
  if (path === '/api/settings' && method === 'POST') {
    const body = await request.json().catch(() => null);
    const next = {};
    for (const f of ['hotlink', 'rss']) {
      if (!(f in (body ?? {}))) continue;
      if (typeof body[f] !== 'boolean') return json({ error: 'bad_request' }, 400);
      next[f] = body[f];
    }
    if ('name' in (body ?? {})) {
      const name = normName(body.name);
      if (name === null) return json({ error: 'bad_request' }, 400);
      next.name = name;
    }
    if ('storage' in (body ?? {})) {
      if (!STORAGE_MODES.includes(body.storage)) return json({ error: 'bad_request' }, 400);
      const plan = splitStorage(body.storage);
      // 选了没配密钥的后端就报错，别悄悄降级——用户以为有备份其实没有
      if (plan.primary === 'tg' && !tgReady(env)) return json({ error: 'tg_not_configured' }, 400);
      if (plan.primary === 'hf' && !hfReady(env)) return json({ error: 'hf_not_configured' }, 400);
      if (plan.backup === 'hf' && !hfReady(env)) return json({ error: 'hf_not_configured' }, 400);
      next.storage = body.storage;
    }
    for (const f of ['allow', 'domains', 'exempt', 'links']) {
      if (!(f in (body ?? {}))) continue;
      if (!Array.isArray(body[f])) return json({ error: 'bad_request' }, 400);
      next[f] = body[f];
    }
    if ('bg' in (body ?? {})) {
      if (typeof body.bg !== 'object' || !body.bg) return json({ error: 'bad_request' }, 400);
      next.bg = body.bg;
    }
    if ('theme' in (body ?? {})) {
      if (typeof body.theme !== 'object' || !body.theme) return json({ error: 'bad_request' }, 400);
      next.theme = body.theme;
    }
    if (!Object.keys(next).length) return json({ error: 'bad_request' }, 400);
    const cur = await getSettings(env, { fresh: true });
    if (next.theme?.color !== undefined) {
      const c = normThemeColor(next.theme.color);
      if (c === null && next.theme.color !== null) return json({ error: 'bad_request' }, 400);
      next.theme.color = c;
    }
    if (next.theme && !THEME_MODES.includes(next.theme.mode)) delete next.theme.mode;
    if (next.bg?.interval !== undefined && !BG_INTERVALS.includes(next.bg.interval)) return json({ error: 'bad_request' }, 400);
    if (next.bg?.urls) {
      if (next.bg.urls.length > MAX_BG) return json({ error: 'bad_request' }, 400);
      next.bg.urls = next.bg.urls.map(normBgUrl).filter(Boolean);
    }
    if (next.links) {
      if (next.links.length > MAX_LINKS) return json({ error: 'bad_request' }, 400);
      next.links = next.links.map(normLink).filter(Boolean);
    }
    if (next.allow) {
      if (next.allow.length > MAX_SITES) return json({ error: 'bad_request' }, 400);
      next.allow = [...new Set(next.allow.map(normSite).filter(Boolean))];
    }
    if (next.domains) {
      if (next.domains.length > MAX_DOMAINS) return json({ error: 'bad_request' }, 400);
      next.domains = [...new Set(next.domains.map(normSite).filter(Boolean))];
    }
    return json(await saveSettings(env, { ...cur, ...next }).then((s) => settingsOut(env, s)));
  }
  if (path === '/api/exempt' && method === 'POST') {
    // 单张图放行/取消放行防盗链：{key, exempt: boolean}
    const body = await request.json().catch(() => null);
    if (!body || typeof body.key !== 'string' || !isFileKey(body.key) || typeof body.exempt !== 'boolean') {
      return json({ error: 'bad_request' }, 400);
    }
    const cur = await getSettings(env, { fresh: true });
    const exempt = new Set(cur.exempt);
    if (body.exempt) exempt.add(body.key);
    else exempt.delete(body.key);
    await saveSettings(env, { ...cur, exempt: [...exempt] });
    return json({ ok: true, exempt: body.exempt });
  }
  if (path === '/api/delete' && method === 'POST') {
    // 批量删除：{keys: string[]}，一次最多 1000 个
    const body = await request.json().catch(() => null);
    const keys = Array.isArray(body?.keys) ? [...new Set(body.keys)] : [];
    if (!keys.length || keys.length > 1000 || keys.some((k) => typeof k !== 'string' || !isFileKey(k))) {
      return json({ error: 'bad_key' }, 400);
    }
    await removeKeys(env, url, keys);
    return json({ ok: true, count: keys.length });
  }
  if (path === '/api/tg/status' && method === 'GET') return tgStatus(env);
  if (path === '/api/tg/backup' && method === 'POST') {
    // 把还没 TG 备份的文件补备份到 Telegram（一次最多 20 个，前端循环调用）
    const body = await request.json().catch(() => null);
    const keys = Array.isArray(body?.keys) ? [...new Set(body.keys)] : [];
    if (!keys.length || keys.length > 20 || keys.some((k) => typeof k !== 'string' || !isFileKey(k))) {
      return json({ error: 'bad_key' }, 400);
    }
    if (!tgReady(env)) return json({ error: 'tg_not_configured' }, 400);
    const results = await Promise.all(keys.map((k) => backupTgKey(env, k).catch((err) => 'error')));
    return json({ results });
  }
  if (path === '/api/hf/status' && method === 'GET') return hfStatus(env);
  // POST /api/hf/backup {keys}：把还没归档的文件补归档到 HuggingFace（一次最多 BACKUP_BATCH 个）
  if (path === '/api/hf/backup' && method === 'POST') {
    const body = await request.json().catch(() => null);
    const keys = Array.isArray(body?.keys) ? [...new Set(body.keys)] : [];
    if (!keys.length || keys.length > BACKUP_BATCH || keys.some((k) => typeof k !== 'string' || !isFileKey(k))) {
      return json({ error: 'bad_key' }, 400);
    }
    if (!hfReady(env)) return json({ error: 'hf_not_configured' }, 400);
    const results = await Promise.all(keys.map((k) => hfBackupKey(env, k).catch((err) => 'error')));
    return json({ results });
  }

  return json({ error: 'not_found' }, 404);
}

const settingsOut = (env, s) => ({ ...publicSettings(s), rssReaders: RSS_READERS, tgReady: tgReady(env), hfReady: hfReady(env) });

// 解析 storage 模式 → { primary, backup }，不可用的后端自动去掉。primary: 'tg' | 'hf'。
// 降级路径要一致：主存不可用就落回可用的那个，绝不把字节放到读不出来的地方。
async function storagePlan(env) {
  const { primary, backup } = splitStorage((await getSettings(env)).storage);
  const ready = (t) => (t === 'tg' ? tgReady(env) : hfReady(env));
  const head = ready(primary) ? primary : ready(backup) ? backup : 'tg'; // 都没配就 tg（可能上传时才报错）
  const other = head === 'tg' ? 'hf' : 'tg';
  return { primary: head, backup: ready(other) ? other : null };
}

// ---------- 上传 ----------

// POST /api/upload?name=<原文件名>&naming=std|original，请求体就是文件本身（不用 multipart，直接流式写进后端）
// naming 默认 std（规范命名）；original 为「13 位时间戳_原文件名」，与旧图床格式相同
// 规范名：ImgHub-YYYYMMDD-HHmmss-xxxx.ext，时间按 UTC+8；随机码用去掉 0/o/1/l 的 32 个字符，防同秒冲突、也防按时间猜链接
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
function stdName(ts, name) {
  const d = new Date(ts + 8 * 3600 * 1000).toISOString(); // 2026-11-21T15:30:45.123Z（已是 UTC+8 的钟面）
  const stamp = `${d.slice(0, 10).replaceAll('-', '')}-${d.slice(11, 19).replaceAll(':', '')}`;
  const rand = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => ALPHABET[b & 31]).join('');
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase().replace(/^jpeg$/, 'jpg');
  return `${BRAND}-${stamp}-${rand}${ext ? `.${ext}` : ''}`;
}

async function upload(request, env, ctx, url) {
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isFinite(length) || length <= 0) return json({ error: 'empty_body' }, 411);

  const name = sanitizeName(url.searchParams.get('name') || 'file');
  const contentType = pickContentType(name, request.headers.get('Content-Type'));
  const original = url.searchParams.get('naming') === 'original';

  // 冲突概率极低（同毫秒同名 / 同秒且 20 位随机码相同），仍查一下；已删除名单里的 key 也不复用
  const { goneSet } = await getSettings(env);
  const taken = async (k) => goneSet.has(k) || Boolean(await getManifest(env, k));


  let ts = Date.now();
  let key = original ? `${ts}_${name}` : stdName(ts, name);
  for (let i = 0; i < 5 && (await taken(key)); i++) key = original ? `${++ts}_${name}` : stdName(ts, name);

  const fileName = original ? name : key;
  const httpMetadata = { contentType, contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(fileName)}` };
  const plan = await storagePlan(env);
  let size;
  let manifest;

  if (plan.primary === 'tg') {
    // 字节流式发到 Telegram 频道；清单写 KV
    try {
      const tg = await tgPut(env, key, request.body, length);
      manifest = { loc: 'tg', size: length, name, httpMetadata, tg };
    } catch (err) {
      console.warn(JSON.stringify({ event: 'tg-upload-failed', key, error: err.message }));
      return json({ error: 'tg_failed' }, 502);
    }
  } else {
    // 字节流式 PUT 进 HuggingFace bucket；清单写 KV。代价是读必须 Worker 代读，受 HF 读速率与 100 GB 额度约束
    if (await hfQuotaBlocked(env)) return json({ error: 'hf_quota' }, 507);
    try {
      const hf = await hfPut(env, key, request.body, length, contentType);
      manifest = { loc: 'hf', size: length, name, httpMetadata, hf };
    } catch (err) {
      console.warn(JSON.stringify({ event: 'hf-upload-failed', key, error: err.message }));
      return json({ error: err.status === 507 ? 'hf_quota' : 'hf_failed' }, 502);
    }
  }
  size = length;
  await putManifest(env, key, manifest);

  // tg+hf：主存 TG，另归档一份到 HF（容灾）。归档失败不影响上传，留待归档标记由 cron / 设置页补
  if (plan.primary === 'tg' && plan.backup === 'hf') {
    ctx.waitUntil(
      backupHfKey(env, key).catch(async (err) => {
        console.warn(JSON.stringify({ event: 'hf-backup-failed', key, error: err.message }));
        await enqueueHf(env, key, err.message || 'error').catch(() => {});
      }),
    );
  }

  // 从哪个域名进来就用哪个域名；要换成其他绑定域名由前端改写（见 ui.js 的 linkOf）
  return json({ key, url: `${url.origin}/file/${encodeURIComponent(key)}`, size, contentType, store: plan.primary });
}

// ---------- 缩略图 ----------

async function getThumbRoute(env, key) {
  const buf = await getThumb(env, key);
  if (!buf) return json({ error: 'not_found' }, 404);
  return new Response(buf, {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(buf.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function putThumbRoute(env, key, request) {
  const length = Number(request.headers.get('Content-Length'));
  if (!(length > 12 && length <= THUMB_MAX)) return json({ error: 'bad_request' }, 400);
  const buf = new Uint8Array(await request.arrayBuffer());
  const ascii = (a, b) => String.fromCharCode(...buf.subarray(a, b));
  if (buf.length > THUMB_MAX || ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') return json({ error: 'bad_request' }, 400);
  // 只有真实存在的图才存缩略图
  if (!(await getManifest(env, key))) return json({ error: 'not_found' }, 404);
  await putThumb(env, key, buf);
  return json({ ok: true });
}
const THUMB_MAX = 512 * 1024;

// ---------- 列表 / 统计 ----------

// GET /api/list?cursor=&limit=：列出所有图片清单，按 KV 字典序（即时间顺序）
async function list(env, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
  const prefix = url.searchParams.get('prefix') || '';
  const { items, cursor } = await listManifests(env, { prefix, cursor: url.searchParams.get('cursor') || undefined, limit });
  return json({
    items: items.map(({ key, m }) => ({
      key,
      name: m.name,
      url: `${url.origin}/file/${encodeURIComponent(key)}`,
      size: m.size,
      tg: m.loc === 'tg' || Boolean(m.tg) || undefined,
      hf: m.loc === 'hf' || Boolean(m.hf) || undefined,
      contentType: m.httpMetadata?.contentType,
      // KV 清单没有 R2 的 uploaded 时间；从 key 里的时间戳还原（规范名与时间戳名都带）
      uploaded: keyTime(key) || undefined,
    })),
    cursor: cursor || null,
  });
}

// GET /api/stats：遍历清单统计数量和总大小
async function stats(env) {
  let cursor;
  let count = 0;
  let bytes = 0;
  let pages = 0;
  do {
    const { items, cursor: next } = await listManifests(env, { cursor, limit: 1000 });
    for (const { m } of items) {
      count++;
      bytes += m.size || 0;
    }
    cursor = next;
  } while (cursor && ++pages < 20);
  return json({ count, bytes, partial: Boolean(cursor) });
}

// ---------- 删除 ----------

// 从两个后端删除字节，清掉缩略图与清单。Cache API 只能清当前机房，其他机房等过期（gone 名单负责对外 404）
async function removeKeys(env, url, keys) {
  const msgs = [];
  const arch = new Set();
  await Promise.all(
    keys.map(async (key) => {
      const m = await getManifest(env, key);
      if (!m) return;
      if (m.tg?.chunks) msgs.push(...m.tg.chunks.map((c) => c.msg));
      if (m.hf?.path) arch.add(m.hf.path);
    }),
  );
  await Promise.all(keys.map((key) => deleteManifest(env, key).then(() => deleteThumb(env, key))));
  if (msgs.length && tgReady(env)) {
    await tgDelete(env, msgs).catch((err) => console.warn(JSON.stringify({ event: 'tg-delete-failed', error: err.message })));
  }
  // HF 的 DeleteObject 立即释放空间；失败只记日志，对外仍是已删除
  if (arch.size && hfReady(env)) {
    await hfDelete(env, [...arch]).catch((err) => console.warn(JSON.stringify({ event: 'hf-delete-failed', error: err.message })));
  }
  // 记进已删除名单（其他机房的缓存由读路径挡掉），顺手从防盗链豁免名单里拿掉
  const cur = await getSettings(env, { fresh: true });
  const gone = new Set(keys);
  const now = Date.now();
  await saveSettings(env, {
    ...cur,
    exempt: cur.exempt.filter((k) => !gone.has(k)),
    gone: [...keys.filter((k) => !k.startsWith('.')).map((k) => [k, now]), ...cur.gone],
  });
  const origins = [...new Set([url.origin, ...cur.domains.map((d) => `https://${d}`)])];
  await Promise.all(
    keys.flatMap((key) => {
      const p = `/file/${encodeURIComponent(key)}`;
      return origins.map((o) => caches.default.delete(new Request(o + p)));
    }),
  );
}

// ---------- 备份 ----------

// 把一个已有 TG 主存的文件归档到 HuggingFace：整份流式 PUT 进 bucket，清单补 hf 字段。
// 返回 done / exists（已归档）/ skipped（超单文件上限或配额满，写待归档标记）/ missing
async function backupHfKey(env, key, maxBytes = MAX_HF_BYTES) {
  const m = await getManifest(env, key);
  if (!m) return 'missing';
  if (m.hf) {
    await dequeueHf(env, key);
    return 'exists';
  }
  if (!m.tg) return 'missing'; // 字节只在 HF，无需归档
  if (m.size > maxBytes || (await hfQuotaBlocked(env))) {
    await enqueueHf(env, key, m.size > maxBytes ? 'too_large' : 'quota');
    return 'skipped';
  }
  // 从 Telegram 拉出整份字节再 PUT 进 bucket
  const body = await tgStream(env, m.tg);
  try {
    const hf = await hfPut(env, key, body, m.size, m.httpMetadata?.contentType);
    await putManifest(env, key, { ...m, hf });
    await dequeueHf(env, key);
    return 'done';
  } catch (err) {
    await enqueueHf(env, key, err.message || 'error');
    throw err;
  }
}

// 把一个已有 HF 主存的文件备份到 Telegram：整份流式 PUT 进频道，清单补 tg 字段。
// 返回 done / exists / missing
async function backupTgKey(env, key) {
  const m = await getManifest(env, key);
  if (!m) return 'missing';
  if (m.tg) return 'exists';
  if (!m.hf) return 'missing';
  // 从 HuggingFace 拉出整份字节再发进频道
  const res = await hfGet(env, m.hf.path);
  if (!res) return 'missing';
  const body = await res.arrayBuffer();
  const tg = await tgPut(env, key, new Response(body).body, m.size);
  await putManifest(env, key, { ...m, tg });
  return 'done';
}

// GET /api/hf/status：归档用量 + 待归档的 key（设置页「补归档」按钮用）。
async function hfStatus(env) {
  if (!hfReady(env)) return json({ ready: false });
  const manifests = await allManifests(env);
  let backed = 0;
  let tgOnly = 0;
  let hfOnly = 0;
  const pending = [];
  for (const { m } of manifests) {
    if (m.hf) backed++;
    else if (m.loc === 'hf') hfOnly++;
    if (m.loc === 'tg' && !m.hf) tgOnly++;
  }
  const queuedKeys = new Set(await listHfQueue(env));
  for (const { key, m } of manifests) {
    if (queuedKeys.has(key) || (m.loc === 'tg' && !m.hf)) {
      if (pending.length < 200) pending.push(key);
    }
  }
  let use = null;
  let error = null;
  try {
    use = await hfUsage(env, { fresh: true }); // 状态卡是人工看用量，绕开 6 小时缓存
  } catch (err) {
    error = err.message; // 只带错误摘要，不含密钥与响应头
  }
  return json({
    ready: true,
    storage: (await getSettings(env)).storage,
    bucket: env.HF_BUCKET,
    prefix: env.HF_PREFIX || 'images',
    backed,
    tgOnly,
    hfOnly,
    queued: queuedKeys.size,
    pending,
    files: use?.files ?? 0,
    bytes: use?.bytes ?? 0,
    partial: Boolean(use?.partial),
    quota: HF_QUOTA,
    quotaPct: use ? Math.min(100, Math.round((use.bytes / HF_QUOTA) * 1000) / 10) : 0,
    error,
  });
}

// GET /api/tg/status：已备份数、只存 TG 的数量、还没备份的 key（供设置页「补备份」）
async function tgStatus(env) {
  const manifests = await allManifests(env);
  let backed = 0;
  let hfOnly = 0;
  const pending = [];
  for (const { key, m } of manifests) {
    if (m.tg) backed++;
    else if (m.loc === 'hf') hfOnly++;
    if (m.loc === 'hf' && !m.tg && pending.length < 200) pending.push(key);
  }
  return json({ ready: tgReady(env), storage: (await getSettings(env)).storage, backed, hfOnly, pending });
}

// 拉全量清单（hfStatus / tgStatus 用），按需可加 limit
async function allManifests(env, limit = 5000) {
  const { items } = await listManifests(env, { limit });
  return items;
}

// Cron：把待归档标记逐个补一遍，成功就删标记。放宽到 MAX_SWEEP_BYTES。满了或撞限流就停，剩下的下一轮再来。
export async function hfSweep(env, limit = 100) {
  if (!hfReady(env)) return { done: 0, left: 0 };
  const keys = await listHfQueue(env);
  let done = 0;
  let stopped = false;
  for (const key of keys.slice(0, limit)) {
    try {
      await backupHfKey(env, key, MAX_SWEEP_BYTES);
      done++;
    } catch (err) {
      console.warn(JSON.stringify({ event: 'hf-sweep-failed', key, error: err.message }));
      stopped = Boolean(err.retryAfter) || err.status === 403; // 限流或权限问题：整轮到此为止
      if (stopped) break;
    }
  }
  return { done, left: keys.length - (stopped ? 0 : Math.min(keys.length, limit)) };
}

// 旧图床回源迁移：把取回的字节写进当前主存后端并落清单，返回清单（serve.js 的 fromLegacy 用）
export async function importLegacy(env, key, body, contentType) {
  const plan = await storagePlan(env);
  const size = body.byteLength;
  const buf = new Uint8Array(body);
  const httpMetadata = { contentType, contentDisposition: 'inline' };
  if (plan.primary === 'tg') {
    const tg = await tgPut(env, key, new Response(body).body, size);
    const manifest = { loc: 'tg', size, httpMetadata, tg };
    await putManifest(env, key, manifest);
    return manifest;
  }
  const hf = await hfPut(env, key, buf, size, contentType);
  const manifest = { loc: 'hf', size, httpMetadata, hf };
  await putManifest(env, key, manifest);
  return manifest;
}

// ---------- 工具 ----------

// upload 角色只能撤回 24 小时内上传的文件（按 key 里的上传时间判断）
function recent(key) {
  const ts = keyTime(key);
  return Number.isFinite(ts) && Date.now() - ts < UNDO_WINDOW && ts <= Date.now() + 60000;
}

// 文件名：保留中文等 Unicode，去掉路径分隔符、URL 特殊字符和控制字符，空白换成下划线
export function sanitizeName(raw) {
  let name = raw
    .normalize('NFC')
    .replace(/[\\/?#%&*:"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '');
  if ([...name].length > 120) name = [...name].slice(-120).join('');
  return name || 'file';
}

function json(data, status = 200, cookie) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}
