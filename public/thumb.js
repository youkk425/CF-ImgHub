// 缩略图：浏览器生成 WebP（短边 400），经 /api/thumb/<key> 写进 KV（要登录）。
// 上传页在上传后生成；管理页可给旧文件补。原图一个字节都不动
const SHORT = 400;
let worker;
let seq = 0;
let chain = Promise.resolve(); // 单个 Worker，依次处理

export const thumbUrl = (key) => `/api/thumb/${encodeURIComponent(key)}`;

/** 从图片 Blob 生成缩略图 Blob；不是图片或浏览器解不了时返回 null */
export async function makeThumb(blob) {
  if (blob.type && !blob.type.startsWith('image/')) return null;
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) return null;
  worker ??= new Worker('/convert-worker.js', { type: 'module' });
  const run = chain.then(
    () =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        worker.onmessage = ({ data }) => {
          if (data.id !== id) return;
          data.error ? reject(new Error(data.error)) : resolve(new Blob([data.buf], { type: 'image/webp' }));
        };
        worker.postMessage({ id, bitmap, format: 'webp', quality: 'small', thumb: SHORT }, [bitmap]);
      }),
  );
  chain = run.catch(() => {});
  return run;
}

export async function putThumb(key, blob) {
  const r = await fetch(thumbUrl(key), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/webp' }, body: blob });
  if (!r.ok) throw new Error(`thumb upload: HTTP ${r.status}`);
}
