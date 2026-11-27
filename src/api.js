// /api/*：登录、上传、删除、列表。权限见 auth.js：upload 角色可上传、可撤回 24 小时内的上传；admin 角色全部可做
// 错误只返回代码（error 字段），由前端按语言翻译
import { pickContentType } from './mime.js';
import { allStores, BRAND, configStore, keyTime, storesFor, writeStore } from './stores.js';
import { BG_INTERVALS, STORAGE_MODES, THEME_MODES, isFileKey, MAX_BG, MAX_DOMAINS, MAX_LINKS, MAX_SITES, getSettings, normBgUrl, normLink, normName, normSite, normThemeColor, publicSettings, saveSettings, siteInfo, splitStorage } from './settings.js';
import { RSS_READERS } from './serve.js';
import { hasRole, identify, login, logoutCookie, sameOrigin } from './auth.js';
import { SIDECAR, TgError, isPlaceholder, isStub, realSize, tgDelete, tgPut, tgReady } from './telegram.js';
import {
  BACKUP_BATCH, HF_QUOTA, MAX_HF_BYTES, MAX_SWEEP_BYTES, QUEUE as HF_QUEUE, SIDECAR as HF_SIDECAR,
  hfDelete, hfPut, hfQuotaBlocked, hfReady, hfUsage, isHfStub,
} from './huggingface.js';

// 只对 Bearer 调用开放跨域；Cookie 会话是 SameSite=Strict，跨域请求本来就带不上
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
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
    if (method === 'GET') return getThumb(env, key);
    if (!hasRole(role, 'admin') && !recent(key)) return json({ error: 'forbidden' }, 403);
    return putThumb(env, key, request);
  }

  if (!hasRole(role, 'admin')) return json({ error: 'forbidden' }, 403);
  if (path === '/api/list' && method === 'GET') return list(env, url);
  if (path === '/api/stats' && method === 'GET') return stats(env);
  if (path === '/api/settings' && method === 'GET') return json(settingsOut(env, await getSettings(env)));
  if (path === '/api/settings' && method === 'POST') {
    // {name?: string, hotlink?, rss?: boolean, allow?, domains?: string[], bg?: {urls?, login?, upload?, interval?}, links?: [{name, url}], theme?: {color?, mode?, logo?, glow?}}，至少给一项；bg、theme 为局部合并
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
      // 逐段校验：选了没配密钥的盘就报错，别悄悄降级——用户以为有备份其实没有
      const tokens = splitStorage(body.storage);
      if ((tokens.primary === 'tg' || tokens.backups.includes('tg')) && !tgReady(env)) return json({ error: 'tg_not_configured' }, 400);
      if ((tokens.primary === 'hf' || tokens.backups.includes('hf')) && !hfReady(env)) return json({ error: 'hf_not_configured' }, 400);
      next.storage = body.storage;
    }
    if ('allow' in (body ?? {})) {
      if (!Array.isArray(body.allow) || body.allow.length > MAX_SITES) return json({ error: 'bad_request' }, 400);
      const sites = body.allow.map(normSite);
      const bad = body.allow.find((_, i) => !sites[i]);
      if (bad !== undefined) return json({ error: 'bad_site', site: String(bad) }, 400);
      next.allow = sites;
    }
    if ('domains' in (body ?? {})) {
      if (!Array.isArray(body.domains) || body.domains.length > MAX_DOMAINS) return json({ error: 'bad_request' }, 400);
      const hosts = body.domains.map(normSite);
      const bad = body.domains.find((_, i) => !hosts[i]);
      if (bad !== undefined) return json({ error: 'bad_site', site: String(bad) }, 400);
      next.domains = hosts;
    }
    if ('links' in (body ?? {})) {
      if (!Array.isArray(body.links) || body.links.length > MAX_LINKS) return json({ error: 'bad_request' }, 400);
      const links = body.links.map(normLink);
      const bad = body.links.find((_, i) => !links[i]);
      if (bad !== undefined) return json({ error: 'bad_link', site: String(bad?.url ?? '') }, 400);
      next.links = links;
    }
    let bgPatch;
    if ('bg' in (body ?? {})) {
      const b = body.bg;
      if (!b || typeof b !== 'object') return json({ error: 'bad_request' }, 400);
      if ('urls' in b) {
        if (!Array.isArray(b.urls) || b.urls.length > MAX_BG) return json({ error: 'bad_request' }, 400);
        const urls = b.urls.map(normBgUrl);
        const bad = b.urls.find((_, i) => !urls[i]);
        if (bad !== undefined) return json({ error: 'bad_url', site: String(bad) }, 400);
        b.urls = urls;
      }
      delete b.keys;
      if (('login' in b && typeof b.login !== 'boolean') || ('upload' in b && typeof b.upload !== 'boolean')) return json({ error: 'bad_request' }, 400);
      if ('interval' in b && !BG_INTERVALS.includes(b.interval)) return json({ error: 'bad_request' }, 400);
      bgPatch = b;
    }
    let themePatch;
    if ('theme' in (body ?? {})) {
      const th = body.theme;
      if (!th || typeof th !== 'object') return json({ error: 'bad_request' }, 400);
      themePatch = {};
      if ('color' in th) {
        if (!normThemeColor(th.color)) return json({ error: 'bad_request' }, 400);
        themePatch.color = normThemeColor(th.color);
      }
      if ('mode' in th) {
        if (!THEME_MODES.includes(th.mode)) return json({ error: 'bad_request' }, 400);
        themePatch.mode = th.mode;
      }
      for (const f of ['logo', 'glow']) {
        if (!(f in th)) continue;
        if (typeof th[f] !== 'boolean') return json({ error: 'bad_request' }, 400);
        themePatch[f] = th[f];
      }
      if (!Object.keys(themePatch).length) return json({ error: 'bad_request' }, 400);
    }
    if (!Object.keys(next).length && !bgPatch && !themePatch) return json({ error: 'bad_request' }, 400);
    const cur = await getSettings(env, { fresh: true });
    if (bgPatch) next.bg = { ...cur.bg, ...bgPatch };
    if (themePatch) next.theme = { ...cur.theme, ...themePatch };
    return json(settingsOut(env, await saveSettings(env, { ...cur, ...next })));
  }
  // POST /api/exempt {keys, on}：单张防盗链开关。on=true 表示这几张允许外链
  if (path === '/api/exempt' && method === 'POST') {
    const body = await request.json().catch(() => null);
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => typeof k === 'string' && k && !k.startsWith('.')) : [];
    if (!keys.length || keys.length > 1000 || typeof body.on !== 'boolean') return json({ error: 'bad_request' }, 400);
    const cur = await getSettings(env, { fresh: true });
    const set = new Set(cur.exempt);
    for (const k of keys) body.on ? set.add(k) : set.delete(k);
    return json(settingsOut(env, await saveSettings(env, { ...cur, exempt: [...set] })));
  }
  if (path === '/api/delete' && method === 'POST') {
    const body = await request.json().catch(() => null);
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => typeof k === 'string' && k) : [];
    if (!keys.length || keys.length > 100) return json({ error: 'bad_key' }, 400);
    await removeKeys(env, url, keys);
    return json({ ok: true, deleted: keys.length });
  }
  if (path === '/api/tg/status' && method === 'GET') return tgStatus(env);
  // POST /api/tg/backup {keys}：把已在 R2 的文件补备份到 Telegram（一次最多 5 个，前端循环调用）
  if (path === '/api/tg/backup' && method === 'POST') {
    if (!tgReady(env)) return json({ error: 'tg_not_configured' }, 400);
    const body = await request.json().catch(() => null);
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => typeof k === 'string' && k && !k.startsWith('.')) : [];
    if (!keys.length || keys.length > 5) return json({ error: 'bad_key' }, 400);
    const results = [];
    for (const key of keys) {
      try {
        results.push({ key, status: await backupKey(env, key) });
      } catch (err) {
        console.warn(JSON.stringify({ event: 'tg-backup-failed', key, error: err.message }));
        // 触发 Telegram 限流就停下，告诉前端等多久
        if (err instanceof TgError && err.retryAfter) return json({ results, retryAfter: err.retryAfter });
        results.push({ key, status: 'failed' });
      }
    }
    return json({ results });
  }
  if (path === '/api/hf/status' && method === 'GET') return hfStatus(env);
  // POST /api/hf/backup {keys}：把已在 R2、但还没归档的文件补备份到 HuggingFace（一次最多 BACKUP_BATCH 个）
  if (path === '/api/hf/backup' && method === 'POST') {
    if (!hfReady(env)) return json({ error: 'hf_not_configured' }, 400);
    const body = await request.json().catch(() => null);
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => typeof k === 'string' && k && !k.startsWith('.')) : [];
    if (!keys.length || keys.length > BACKUP_BATCH) return json({ error: 'bad_key' }, 400);
    const results = [];
    for (const key of keys) {
      try {
        results.push({ key, status: await hfBackupKey(env, key) });
      } catch (err) {
        console.warn(JSON.stringify({ event: 'hf-backup-failed', key, error: err.message }));
        // 撞上限流就停下，剩下的交给下一轮或 cron；这张图留 .hfq/ 标记
        if (err.retryAfter) return json({ results, retryAfter: err.retryAfter });
        await hfQueue(env, key, null, 'error').catch(() => {});
        results.push({ key, status: 'failed' });
      }
    }
    return json({ results });
  }
  return json({ error: 'not_found' }, 404);
}

const settingsOut = (env, s) => ({ ...publicSettings(s), rssReaders: RSS_READERS, tgReady: tgReady(env), hfReady: hfReady(env) });

// 把 storage 拆成「主存 + 备份盘」。主存可以是 r2 / tg / hf（hf 是实验值），没配密钥的那一段自动去掉。
// 只是"降级路径"要一致：主存不可用就落回 r2，绝不把字节放到读不出来的地方。
async function storagePlan(env) {
  const { primary, backups } = splitStorage((await getSettings(env)).storage);
  const ready = (t) => (t === 'tg' ? tgReady(env) : t === 'hf' ? hfReady(env) : true);
  const head = ready(primary) ? primary : 'r2';
  const rest = backups.filter(ready).filter((t) => t !== head && t !== 'r2');
  return { primary: head, backups: rest };
}

// 待处理标记 .hfq/<key>：上传时太大、超配额或失败的文件留在这儿，由「补备份」按钮 / cron 收尾。
// 标记对象就是 key 的纯函数，重复写无害，删掉才算处理完。
async function hfQueue(env, key, size, reason) {
  await configStore(env).bucket.put(
    HF_QUEUE + key,
    JSON.stringify({ v: 1, key, size: size ?? null, reason, at: Date.now() }),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

// 把 R2 里的 key 备份到 HuggingFace：整份流式 PUT 进桶，清单连同原对象的 httpMetadata 存到主桶 .hf/<key>
// 返回 done / exists（已归档）/ stub（只存 Telegram 的文件，字节不在 R2，留给 tg→hf 的路子）/
//      skipped（超单文件上限或配额满，写 .hfq/ 标记）/ missing
// maxBytes 是熔断上限：上传请求里用 MAX_HF_BYTES（waitUntil 只有 30 秒），cron 用 MAX_SWEEP_BYTES。
async function hfBackupKey(env, key, maxBytes = MAX_HF_BYTES) {
  const main = configStore(env).bucket;
  // 已归档 / 只存 Telegram / 正主没了：都不需要再补备份，顺手清掉可能残留的标记，免得 cron 每轮空转
  if (await main.head(HF_SIDECAR + key)) {
    await main.delete(HF_QUEUE + key);
    return 'exists';
  }
  for (const s of storesFor(env, key)) {
    const head = await s.bucket.head(key);
    if (!head) continue;
    if (isPlaceholder(head)) {
      await main.delete(HF_QUEUE + key);
      return 'stub';
    }
    if (head.size > maxBytes || (await hfQuotaBlocked(env))) {
      await hfQueue(env, key, head.size, head.size > maxBytes ? 'too_large' : 'quota');
      return 'skipped';
    }
    const obj = await s.bucket.get(key);
    if (!obj) return 'missing';
    const manifest = await hfPut(env, key, obj.body, obj.size, obj.httpMetadata?.contentType);
    await main.put(HF_SIDECAR + key, JSON.stringify(manifest), { httpMetadata: obj.httpMetadata });
    await main.delete(HF_QUEUE + key);
    return 'done';
  }
  await main.delete(HF_QUEUE + key);
  return 'missing';
}

// GET /api/hf/status：归档用量 + 待归档的 key（设置页「补备份」按钮用）。
// files/bytes 来自 ListObjectsV2（最多扫 5 页，扫不完标 partial）；bucket 没有用量接口，只能自己数。
async function hfStatus(env) {
  if (!hfReady(env)) return json({ ready: false });
  const main = configStore(env).bucket;
  const backed = new Set();
  await listAll(main, { prefix: HF_SIDECAR }, (o) => backed.add(o.key.slice(HF_SIDECAR.length)));
  const pending = [];
  let queued = 0;
  let tgOnly = 0;
  let hfOnly = 0;
  await listAll(main, { prefix: HF_QUEUE }, (o) => {
    if (!backed.has(o.key.slice(HF_QUEUE.length))) queued++;
  });
  for (const s of allStores(env)) {
    await listAll(s.bucket, { include: ['customMetadata'] }, (o) => {
      if (o.key.startsWith('.')) return;
      if (isStub(o)) tgOnly++;
      else if (isHfStub(o)) hfOnly++; // 实验主存：字节只在 bucket，本来就不该出现在"待归档"里
      else if (!backed.has(o.key) && pending.length < 200) pending.push(o.key);
    });
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
    backed: backed.size,
    tgOnly,
    hfOnly,
    queued,
    pending,
    files: use?.files ?? 0,
    bytes: use?.bytes ?? 0,
    partial: Boolean(use?.partial),
    quota: HF_QUOTA,
    quotaPct: use ? Math.min(100, Math.round((use.bytes / HF_QUOTA) * 1000) / 10) : 0,
    error,
  });
}

// Cron：把 .hfq/ 里的标记逐个补一遍，成功就删标记。放宽到 MAX_SWEEP_BYTES（cron 单次上限 15 分钟，不是 30 秒）。
// 桶满了或撞限流就停下，剩下的下一轮再来；重复跑无害。
export async function hfSweep(env, limit = 100) {
  if (!hfReady(env)) return { done: 0, left: 0 };
  const main = configStore(env).bucket;
  const keys = [];
  await listAll(main, { prefix: HF_QUEUE }, (o) => keys.push(o.key.slice(HF_QUEUE.length)));
  let done = 0;
  let stopped = false;
  for (const key of keys.slice(0, limit)) {
    try {
      await hfBackupKey(env, key, MAX_SWEEP_BYTES);
      done++;
    } catch (err) {
      console.warn(JSON.stringify({ event: 'hf-sweep-failed', key, error: err.message }));
      stopped = Boolean(err.retryAfter) || err.status === 403; // 限流或权限问题：整轮到此为止，别把外呼预算烧光
      if (stopped) break;
    }
  }
  return { done, left: keys.length - (stopped ? 0 : Math.min(keys.length, limit)) };
}

// 把 R2 里的 key 备份到 Telegram：清单连同原对象的 httpMetadata 存到主桶 .tg/<key>
// 返回 done / exists（已有备份）/ tg（本来就只存 Telegram）/ missing
async function backupKey(env, key) {
  const main = configStore(env).bucket;
  if (await main.head(SIDECAR + key)) return 'exists';
  for (const s of storesFor(env, key)) {
    const obj = await s.bucket.get(key);
    if (!obj) continue;
    if (isStub(obj)) {
      await obj.body.cancel();
      return 'tg';
    }
    const manifest = await tgPut(env, key, obj.body, obj.size);
    await main.put(SIDECAR + key, JSON.stringify(manifest), { httpMetadata: obj.httpMetadata });
    return 'done';
  }
  return 'missing';
}

// GET /api/tg/status：已备份数、只存 Telegram 的数量、还没备份的 key（供设置页「补备份」）
async function tgStatus(env) {
  const backed = new Set();
  await listAll(configStore(env).bucket, { prefix: SIDECAR }, (o) => backed.add(o.key.slice(SIDECAR.length)));
  const pending = [];
  let tgOnly = 0;
  for (const s of allStores(env)) {
    await listAll(s.bucket, { include: ['customMetadata'] }, (o) => {
      if (o.key.startsWith('.')) return;
      if (isStub(o)) tgOnly++;
      else if (!backed.has(o.key)) pending.push(o.key);
    });
  }
  return json({ ready: tgReady(env), storage: (await getSettings(env)).storage, backed: backed.size, tgOnly, pending });
}

async function listAll(bucket, opts, fn) {
  let cursor;
  let pages = 0;
  do {
    const res = await bucket.list({ ...opts, limit: 1000, cursor });
    res.objects.forEach(fn);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor && ++pages < 50);
}

// upload 角色只能撤回 24 小时内上传的文件（按 key 里的上传时间判断）
function recent(key) {
  const ts = keyTime(key);
  return Number.isFinite(ts) && Date.now() - ts < UNDO_WINDOW && ts <= Date.now() + 60000;
}

// POST /api/upload?name=<原文件名>&naming=std|original，请求体就是文件本身（不用 multipart，直接流式写进 R2）
// naming 默认 std（规范命名）；original 为「13 位时间戳_原文件名」，与旧图床格式相同
async function upload(request, env, ctx, url) {
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isFinite(length) || length <= 0) return json({ error: 'empty_body' }, 411);

  const name = sanitizeName(url.searchParams.get('name') || 'file');
  const contentType = pickContentType(name, request.headers.get('Content-Type'));
  const store = writeStore(env);
  const original = url.searchParams.get('naming') === 'original';

  // 冲突概率极低（同毫秒同名 / 同秒且 20 位随机码相同），仍然检查一下；已删除名单里的 key 也不复用（读路径会挡掉）
  const { goneSet } = await getSettings(env);
  const taken = async (k) => goneSet.has(k) || Boolean(await store.bucket.head(k));
  let ts = Date.now();
  let key = original ? `${ts}_${name}` : stdName(ts, name);
  for (let i = 0; i < 5 && (await taken(key)); i++) key = original ? `${++ts}_${name}` : stdName(ts, name);

  const fileName = original ? name : key;
  const httpMetadata = { contentType, contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(fileName)}` };
  const custom = original ? {} : { name };
  const plan = await storagePlan(env);
  let size;
  if (plan.primary === 'tg') {
    // 只存 Telegram：文件流式发到频道，R2 里放占位对象（正文是清单）
    let manifest;
    try {
      manifest = await tgPut(env, key, request.body, length);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'tg-upload-failed', key, error: err.message }));
      return json({ error: 'tg_failed' }, 502);
    }
    await store.bucket.put(key, JSON.stringify(manifest), { httpMetadata, customMetadata: { ...custom, tg: '1', size: String(length) } });
    size = length;
    // 占位对象没有正文字节，HF 备份只能跳过（清单已经在 R2，tg 掉数据时读路径仍能取回）
  } else if (plan.primary === 'hf') {
    // 实验：只存 HuggingFace。字节直接流进 bucket，R2 只留清单占位对象 + 缩略图，几乎不占 R2 存储。
    // 代价是读必须 Worker 代读（bucket 要签名、不能公开直链），且受 HF 读速率与 100 GB 免费额度约束。
    if (await hfQuotaBlocked(env)) return json({ error: 'hf_quota' }, 507);
    let manifest;
    try {
      manifest = await hfPut(env, key, request.body, length, contentType);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'hf-upload-failed', key, error: err.message }));
      return json({ error: err.status === 507 ? 'hf_quota' : 'hf_failed' }, 502);
    }
    // 占位对象正文是清单：读路径（serve.js 的 fromStore）据此知道字节在 bucket 里；
    // customMetadata 里同样带 name/size，管理页、统计、删除都不用特殊照顾。
    await store.bucket.put(key, JSON.stringify(manifest), { httpMetadata, customMetadata: { ...custom, stub: 'hf', size: String(length) } });
    // 侧车清单与「备份」模式同一形状：hfStatus 的待归档统计、删除联动、兜底读都复用它
    await configStore(env).bucket.put(HF_SIDECAR + key, JSON.stringify(manifest), { httpMetadata });
    size = length;
  } else {
    const obj = await store.bucket.put(key, request.body, { httpMetadata, customMetadata: original ? undefined : custom });
    size = obj.size;
    // 备份在回应之后做，不拖慢上传；失败的可以在设置页补备份
    if (plan.backups.includes('tg')) {
      ctx.waitUntil(backupKey(env, key).catch((err) => console.warn(JSON.stringify({ event: 'tg-backup-failed', key, error: err.message }))));
    }
    if (plan.backups.includes('hf')) {
      // 归档失败绝不影响上传：留 .hfq/ 标记，设置页「补备份」或 cron 再收
      ctx.waitUntil(
        hfBackupKey(env, key).catch(async (err) => {
          console.warn(JSON.stringify({ event: 'hf-backup-failed', key, error: err.message }));
          await hfQueue(env, key, length, 'error').catch(() => {});
        }),
      );
    }
  }

  // 从哪个域名进来就用哪个域名；要换成其他绑定域名由前端改写（见 ui.js 的 linkOf）
  return json({ key, url: `${url.origin}/file/${encodeURIComponent(key)}`, size, contentType, store: plan.primary === 'r2' ? store.binding : plan.primary });
}

// 规范名：ImgHub-YYYYMMDD-HHmmss-xxxx.ext，时间按 UTC+8；随机码用去掉 0/o/1/l 的 32 个字符，防同秒冲突、也防按时间猜链接
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
export function stdName(ts, name) {
  const d = new Date(ts + 8 * 3600 * 1000).toISOString(); // 2026-11-21T15:30:45.123Z（已是 UTC+8 的钟面）
  const stamp = `${d.slice(0, 10).replaceAll('-', '')}-${d.slice(11, 19).replaceAll(':', '')}`;
  const rand = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => ALPHABET[b & 31]).join('');
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase().replace(/^jpeg$/, 'jpg');
  return `${BRAND}-${stamp}-${rand}${ext ? `.${ext}` : ''}`;
}

export const THUMB = '.thumb/';
const THUMB_MAX = 512 * 1024;

// 缩略图与原图放在同一个桶（列表时顺带列出，管理页据此知道哪些已有缩略图）
async function getThumb(env, key) {
  for (const s of storesFor(env, key)) {
    const obj = await s.bucket.get(THUMB + key);
    if (!obj) continue;
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(obj.size),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        ETag: obj.httpEtag,
      },
    });
  }
  return json({ error: 'not_found' }, 404);
}

async function putThumb(env, key, request) {
  const length = Number(request.headers.get('Content-Length'));
  if (!(length > 12 && length <= THUMB_MAX)) return json({ error: 'bad_request' }, 400);
  const buf = new Uint8Array(await request.arrayBuffer());
  const ascii = (a, b) => String.fromCharCode(...buf.subarray(a, b));
  if (buf.length > THUMB_MAX || ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') return json({ error: 'bad_request' }, 400);
  for (const s of storesFor(env, key)) {
    if (!(await s.bucket.head(key))) continue;
    await s.bucket.put(THUMB + key, buf, { httpMetadata: { contentType: 'image/webp' } });
    return json({ ok: true });
  }
  return json({ error: 'not_found' }, 404);
}

// GET /api/list?cursor=&limit=：只列当前写入桶，按 R2 的字典序（即时间顺序）
async function list(env, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
  const store = writeStore(env);
  const res = await store.bucket.list({
    limit,
    cursor: url.searchParams.get('cursor') || undefined,
    prefix: url.searchParams.get('prefix') || undefined,
    include: ['httpMetadata', 'customMetadata'],
  });
  return json({
    // 「.」开头的内部对象排在最前面；.thumb/ 与 .hf/ 分别是缩略图与归档清单，前端攒齐全部分页后据此打标
    thumbs: res.objects.filter((o) => o.key.startsWith(THUMB)).map((o) => o.key.slice(THUMB.length)),
    archived: res.objects.filter((o) => o.key.startsWith(HF_SIDECAR)).map((o) => o.key.slice(HF_SIDECAR.length)),
    items: res.objects.filter((o) => !o.key.startsWith('.')).map((o) => ({
      key: o.key,
      name: o.customMetadata?.name,
      url: `${url.origin}/file/${encodeURIComponent(o.key)}`,
      size: realSize(o),
      tg: isStub(o) || undefined,
      hf: isHfStub(o) || undefined,
      contentType: o.httpMetadata?.contentType,
      uploaded: o.uploaded,
    })),
    cursor: res.truncated ? res.cursor : null,
  });
}

// 从所有桶删除，顺带清掉 Telegram 消息、HuggingFace 归档对象与各种内部清单。
// Cache API 只能清当前机房的缓存，其他机房要等过期或在面板清除（gone 名单负责对外表现为 404）
async function removeKeys(env, url, keys) {
  const stores = allStores(env);
  const main = configStore(env).bucket;
  // Telegram 里的消息（清单里记着 message_id）与 HF 归档路径都先读清单拿到；清单读不出来也不影响 R2 的删除。
  // collect 同时吃两种占位对象：tg 的清单有 chunks，hf 的清单有 path。
  const msgs = [];
  const arch = new Set();
  const collect = async (obj) => {
    if (!obj) return;
    const m = await obj.json().catch(() => null);
    if (m?.chunks) msgs.push(...m.chunks.map((c) => c.msg));
    if (m?.path) arch.add(m.path);
  };
  await Promise.all(
    keys.map(async (key) => {
      await collect(await main.get(SIDECAR + key));
      await collect(await main.get(HF_SIDECAR + key));
      for (const s of stores) if (isPlaceholder(await s.bucket.head(key))) await collect(await s.bucket.get(key));
    }),
  );
  await Promise.all([
    ...stores.map((s) => s.bucket.delete([...keys, ...keys.map((k) => THUMB + k)])),
    main.delete([...keys.map((k) => SIDECAR + k), ...keys.map((k) => HF_SIDECAR + k), ...keys.map((k) => HF_QUEUE + k)]),
  ]);
  if (msgs.length && tgReady(env)) {
    await tgDelete(env, msgs).catch((err) => console.warn(JSON.stringify({ event: 'tg-delete-failed', error: err.message })));
  }
  // 路线 B 的 DeleteObject 立即释放空间（这正是它比 git 仓库适合图床的地方）；失败只记日志，对外仍是已删除
  if (arch.size && hfReady(env)) {
    await hfDelete(env, [...arch]).catch((err) => console.warn(JSON.stringify({ event: 'hf-delete-failed', error: err.message })));
  }
  // 记进已删除名单（其他机房的缓存由读路径挡掉），顺手从防盗链豁免名单里拿掉（背景图是自由填写的地址，不跟着删）
  const cur = await getSettings(env, { fresh: true });
  const origins = [...new Set([url.origin, ...cur.domains.map((d) => `https://${d}`)])];
  const gone = new Set(keys);
  const now = Date.now();
  await saveSettings(env, {
    ...cur,
    exempt: cur.exempt.filter((k) => !gone.has(k)),
    gone: [...keys.filter((k) => !k.startsWith('.')).map((k) => [k, now]), ...cur.gone],
  });
  await Promise.all(
    keys.flatMap((key) => {
      const path = `/file/${encodeURIComponent(key)}`;
      return origins.map((o) => caches.default.delete(new Request(o + path)));
    }),
  );
}

// GET /api/stats：遍历当前写入桶统计数量和总大小（最多 20 页 = 2 万个对象，够用很久）
async function stats(env) {
  const store = writeStore(env);
  let cursor;
  let count = 0;
  let bytes = 0;
  let pages = 0;
  do {
    const res = await store.bucket.list({ limit: 1000, cursor, include: ['customMetadata'] });
    for (const o of res.objects) {
      if (o.key.startsWith('.')) continue;
      count++;
      bytes += realSize(o);
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor && ++pages < 20);
  return json({ count, bytes, partial: Boolean(cursor) });
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
