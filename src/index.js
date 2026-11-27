// CF-ImgHub：小而快的自建图床。/file/* 读图，/api/* 管理，其余交给静态资源（上传页）
import { serveFile } from './serve.js';
import { handleApi, hfSweep } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/file/')) return serveFile(request, env, ctx, url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx, url);
    return env.ASSETS.fetch(request);
  },

  // Cron（wrangler.jsonc 里 0 */6 * * *）：把 .hfq/ 里没归档成的文件补一遍。
  // 上传时的 waitUntil 只有 30 秒，大文件与失败都落在这里收尾；没配 HF 密钥时 hfSweep 直接返回，不产生任何外呼。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(hfSweep(env).catch((err) => console.warn(JSON.stringify({ event: 'hf-sweep-failed', error: err.message }))));
  },
};
