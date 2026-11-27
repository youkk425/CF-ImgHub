// 元数据层：所有非图片字节的小数据都放 Workers KV（绑定 env.META），取代原先"塞在 R2 桶里"的做法。
// 为什么用 KV：R2 移除后，设置 / 清单 / 缩略图 / gone 名单 / HF 待归档队列这些元数据需要一个免绑卡、
//   Workers 原生、可按 key 随机读写的载体。HF bucket 存不了 customMetadata、不支持条件请求（见 huggingface.js
//   顶部注释），Telegram 是消息流不是数据库，都装不下；KV 两者都不是，且免费额度对图床元数据绰绰有余。
//
// KV 的取舍（与原 R2 方案的差异，务必知情）：
//   · 最终一致：写后约 60 秒全球同步。设置改动、删除名单的生效有延迟——对图床元数据可接受。
//   · value 上限 25 MB：settings（含 gone 名单，上限 20000 条 ~1.3 MB）、缩略图（≤512 KiB WebP）都在限内。
//     图片字节绝不进 KV（按读计费且超限），字节只走 HF / TG。
//   · list 只回 key 不回 value：管理页列表要逐个 get 取清单，个人博客量级（百~千张）可接受。
//
// key 约定（全部走本模块，别处不要再直接摸 env.META）：
//   settings              全站设置 JSON（原 .imghub/settings.json，含 gone 名单）
//   manifest:<key>        图片清单 {loc, size, name?, httpMetadata, tg?, hf?}——字节在 HF 还是 TG、怎么取
//   thumb:<key>           缩略图 WebP 原始字节（ArrayBuffer）
//   q:hf:<key>            HF 待归档标记 {reason}（原 .hfq/<key>）

export const MANIFEST_PREFIX = 'manifest:';
export const THUMB_PREFIX = 'thumb:';
export const HF_QUEUE_PREFIX = 'q:hf:';


const ns = (env) => {
  if (!env.META) throw new Error('META KV namespace not bound');
  return env.META;
};

// ---------- 设置 ----------
// 设置单独一个 key；读写都过这里，settings.js 的 30 秒 isolate 缓存留在 settings.js 里做。
export async function getRawSettings(env) {
  const v = await ns(env).get('settings');
  return v ? JSON.parse(v) : null;
}

export async function putRawSettings(env, data) {
  await ns(env).put('settings', JSON.stringify(data));
}

// ---------- 图片清单 ----------
// manifest 记录"字节在哪、怎么取"。loc: 'tg' | 'hf'。
//   tg  → body 是 tgPut 返回的清单 {v,size,chunks}，读路径用 tgStream 取
//   hf  → body 是 hfPut 返回的清单 {v,path,size}，读路径用 hfGet 取
// httpMetadata 存上传时的 Content-Type / Content-Disposition，读回时原样还原。
// name（原文件名）也并进来：原先靠 R2 customMetadata 存，HF/TG 都装不下，KV 接管。
export async function getManifest(env, key) {
  const v = await ns(env).get(MANIFEST_PREFIX + key);
  return v ? JSON.parse(v) : null;
}

export async function putManifest(env, key, manifest) {
  await ns(env).put(MANIFEST_PREFIX + key, JSON.stringify(manifest));
}

export async function deleteManifest(env, key) {
  await ns(env).delete(MANIFEST_PREFIX + key);
}

// ---------- 缩略图 ----------
export async function getThumb(env, key) {
  // KV 的 type:'arrayBuffer' 直接给二进制；没有就是没生成过
  return ns(env).get(THUMB_PREFIX + key, { type: 'arrayBuffer' });
}

export async function putThumb(env, key, buf) {
  await ns(env).put(THUMB_PREFIX + key, buf, { metadata: { ct: 'image/webp' } });
}

export async function deleteThumb(env, key) {
  await ns(env).delete(THUMB_PREFIX + key);
}

// ---------- HF 待归档队列 ----------
// 标记对象就是 key 的纯函数，重复写无害，删掉才算处理完（与原 .hfq/ 语义一致）。
export async function enqueueHf(env, key, reason) {
  await ns(env).put(HF_QUEUE_PREFIX + key, JSON.stringify({ reason }));
}

export async function dequeueHf(env, key) {
  await ns(env).delete(HF_QUEUE_PREFIX + key);
}

// 列出待归档的 key（cron / 设置页"补归档"用）。KV list 只回 key，这里剥掉前缀。
export async function listHfQueue(env, limit = 1000) {
  const out = [];
  let cursor;
  do {
    const page = await ns(env).list({ prefix: HF_QUEUE_PREFIX, limit: Math.min(limit - out.length, 1000), cursor });
    for (const k of page.keys) out.push(k.name.slice(HF_QUEUE_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && out.length < limit);
  return out;
}

// ---------- 管理页列表 / 统计 ----------
// 列出所有 manifest。KV list 只给 key，所以要逐个 get 取清单——个人博客量级（百~千张）可接受；
// 真到上万张再考虑维护独立索引 key。返回 [{key, manifest}]，按 key 字典序（即上传时间序）。
export async function listManifests(env, { prefix = '', cursor, limit = 100 } = {}) {
  const want = MANIFEST_PREFIX + (prefix || '');
  const page = await ns(env).list({ prefix: want, limit, cursor });
  const items = [];
  for (const k of page.keys) {
    const key = k.name.slice(MANIFEST_PREFIX.length);
    const manifest = await getManifest(env, key);
    if (manifest) items.push({ key, manifest });
  }
  return { items, cursor: page.list_complete ? null : page.cursor };
}
