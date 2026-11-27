// Telegram 存储：用 Bot API 把文件以 document 发到频道（不压缩、不转码），按 file_id 取回。
// 两种用法（设置里的 storage）：
//   r2+tg  R2 照常存，另在 Telegram 存一份备份；清单写在主桶 .tg/<key>（读路径 R2 找不到时才用）
//   tg     只存 Telegram；R2 里同名 key 是一个小「占位对象」：正文是清单 JSON，
//          httpMetadata 照常（Content-Type 等），customMetadata {tg:'1', size:'<真实大小>'}
// 清单 {v, size, chunks:[{id, size, msg}]}：getFile 只能下载 20MB 以内的文件，所以按 CHUNK 分片，
// 每片一条消息（caption 写 key 与片号，万一 R2 丢了也能人工对上）。
// 上传与下载都是流式的：上传自己拼 multipart（FixedLengthStream 定长），不把整个文件读进内存。
// 密钥：TG_BOT_TOKEN（@BotFather 给的 token）、TG_CHAT_ID（频道 id，如 -100…；bot 要是频道管理员，能发消息、删消息）

const API = 'https://api.telegram.org';
export const CHUNK = 19 * 1024 * 1024;
export const SIDECAR = '.tg/';
const PATH_TTL = 50 * 60 * 1000; // getFile 给的下载路径至少有效 1 小时

export const tgReady = (env) => Boolean(env.TG_BOT_TOKEN && env.TG_CHAT_ID);
// 占位对象：正文是清单，真实字节在别处（Telegram 频道 / HuggingFace bucket），真实大小记在 customMetadata.size。
// tg:'1' 是老标记（保留兼容），stub:'tg'|'hf' 是新标记——两种主存模式共存时读路径靠它分流。
export const isStub = (obj) => obj?.customMetadata?.tg === '1' || obj?.customMetadata?.stub === 'tg';
export const isPlaceholder = (obj) => isStub(obj) || Boolean(obj?.customMetadata?.stub);
export const realSize = (obj) => (isPlaceholder(obj) ? Number(obj.customMetadata.size) || 0 : obj.size);

export class TgError extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.retryAfter = retryAfter; // 429 时 Telegram 要求等待的秒数
  }
}

async function call(env, method, payload) {
  const res = await fetch(`${API}/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return unwrap(method, res);
}

async function unwrap(method, res) {
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (data.ok) return data.result;
  throw new TgError(`telegram ${method}: ${data.description}`, data.parameters?.retry_after);
}

// ---------- 上传 ----------

// 包一层 reader，能把读多了的部分退回去（按片切开时用）
function byteSource(stream) {
  const reader = stream.getReader();
  let left = null;
  return {
    async read() {
      if (left) {
        const v = left;
        left = null;
        return v;
      }
      const { done, value } = await reader.read();
      return done ? null : value;
    },
    unread(v) {
      left = v;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

// 把 src 里接下来的 n 个字节写进 writer
async function pipeN(src, writer, n) {
  while (n > 0) {
    let v = await src.read();
    if (!v) throw new Error('body shorter than Content-Length');
    if (v.byteLength > n) {
      src.unread(v.subarray(n));
      v = v.subarray(0, n);
    }
    await writer.write(v);
    n -= v.byteLength;
  }
}

const enc = new TextEncoder();
const safe = (s) => String(s).replace(/["\\\r\n]/g, '_');

// 发一片：multipart 头 + 正文 n 字节 + 尾，定长流式发送
async function sendPart(env, src, n, filename, caption) {
  const b = `----imghub${crypto.randomUUID().replaceAll('-', '')}`;
  const field = (name, value) => `--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = enc.encode(
    field('chat_id', env.TG_CHAT_ID) +
      field('caption', caption) +
      // 不让 Telegram 按内容识别类型（否则 GIF 等会被转成动画 / 视频）
      field('disable_content_type_detection', 'true') +
      field('disable_notification', 'true') +
      `--${b}\r\nContent-Disposition: form-data; name="document"; filename="${safe(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${b}--\r\n`);
  const { readable, writable } = new FixedLengthStream(head.byteLength + n + tail.byteLength);
  const writer = writable.getWriter();
  const pump = (async () => {
    await writer.write(head);
    await pipeN(src, writer, n);
    await writer.write(tail);
    await writer.close();
  })().catch((err) => {
    writer.abort(err).catch(() => {});
    throw err;
  });
  const req = fetch(`${API}/bot${env.TG_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
    body: readable,
  });
  const [res] = await Promise.all([req, pump]);
  const msg = await unwrap('sendDocument', res);
  const doc = msg.document;
  if (!doc?.file_id || (doc.file_size && doc.file_size !== n)) {
    throw new TgError('telegram sendDocument: unexpected result');
  }
  return { id: doc.file_id, size: n, msg: msg.message_id };
}

// 把 stream（共 size 字节）存进 Telegram，返回清单。中途失败会删掉已发的片
export async function tgPut(env, key, stream, size) {
  const src = byteSource(stream);
  const total = Math.max(1, Math.ceil(size / CHUNK));
  const chunks = [];
  try {
    for (let i = 0; i < total; i++) {
      const n = Math.min(CHUNK, size - i * CHUNK);
      const name = total === 1 ? key : `${key}.part${i + 1}`;
      const caption = total === 1 ? key : `${key} · ${i + 1}/${total}`;
      chunks.push(await sendPart(env, src, n, name, caption));
    }
  } catch (err) {
    src.cancel();
    if (chunks.length) await tgDelete(env, chunks.map((c) => c.msg)).catch(() => {});
    throw err;
  }
  return { v: 1, size, chunks };
}

// 删消息（尽力而为：bot 是频道管理员且有删除权限时，任何时间的消息都能删）
export async function tgDelete(env, msgIds) {
  for (let i = 0; i < msgIds.length; i += 100) {
    await call(env, 'deleteMessages', { chat_id: env.TG_CHAT_ID, message_ids: msgIds.slice(i, i + 100) });
  }
}

// ---------- 下载 ----------

const paths = new Map(); // file_id → {path, at}，同一 isolate 内复用 getFile 结果

async function fetchChunk(env, chunk) {
  let p = paths.get(chunk.id);
  if (!p || Date.now() - p.at > PATH_TTL) {
    const file = await call(env, 'getFile', { file_id: chunk.id });
    p = { path: file.file_path, at: Date.now() };
    paths.set(chunk.id, p);
    if (paths.size > 2000) paths.delete(paths.keys().next().value);
  }
  const res = await fetch(`${API}/file/bot${env.TG_BOT_TOKEN}/${p.path}`);
  if (!res.ok || !res.body) {
    paths.delete(chunk.id);
    throw new TgError(`telegram file: HTTP ${res.status}`);
  }
  return res;
}

// 按清单拼出 [start, end] 字节的流。先把第一片连上再返回，失败时调用方可以回 502
export async function tgStream(env, manifest, start = 0, end = manifest.size - 1) {
  // 需要的片：[first, last]，以及第一片里要跳过的字节数
  const parts = [];
  let off = 0;
  for (const c of manifest.chunks) {
    if (off + c.size > start && off <= end) parts.push({ c, from: Math.max(0, start - off), to: Math.min(c.size, end - off + 1) });
    off += c.size;
  }
  if (!parts.length) return new ReadableStream({ start: (c) => c.close() });

  let i = 0;
  let reader = (await fetchChunk(env, parts[0].c)).body.getReader();
  let pos = 0; // 当前片里已读到的位置
  return new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        if (!reader) {
          if (++i >= parts.length) return ctrl.close();
          reader = (await fetchChunk(env, parts[i].c)).body.getReader();
          pos = 0;
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        const { from, to } = parts[i];
        const a = Math.max(from - pos, 0);
        const z = Math.min(to - pos, value.byteLength);
        pos += value.byteLength;
        if (z > a) ctrl.enqueue(a === 0 && z === value.byteLength ? value : value.subarray(a, z));
        if (pos >= to) {
          reader.cancel().catch(() => {});
          reader = null;
        }
        if (z > a) return;
      }
    },
    cancel() {
      reader?.cancel().catch(() => {});
    },
  });
}
