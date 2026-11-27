// 存储路由：R2 移除后，"桶"的概念退化成两个正交的后端——
//   字节后端：图片字节放哪（HF bucket 或 Telegram 频道），由设置里的 storage 模式决定。
//   元数据后端：清单 / 设置 / 缩略图 / gone / 队列，统一走 KV（见 meta.js），与字节后端无关。
// 原先"按 key 里的时间戳在多个 R2 桶间路由 + 主桶兜底"的逻辑整体删除：现在只有一个字节后端（可选一份备份），
// 不再需要多桶时间路由，也不再有"主桶"这个承载元数据的角色（元数据全在 KV）。
//
// key 仍带上传时间（保留原名 <13位毫秒>_<文件名> / 规范命名 ImgHub-YYYYMMDD-HHmmss-<随机>），
// 但时间戳现在只用于命名冲突检查和撤销窗口，不再参与桶路由。

import { getManifest } from './meta.js';

export const BRAND = 'ImgHub';
const STD_KEY = new RegExp(`^${BRAND}-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})-`);

// key 里的上传时间（毫秒），解析不出返回 NaN
export function keyTime(key) {
  const ts = /^(\d{13})_/.exec(key)?.[1];
  if (ts) return Number(ts);
  const m = STD_KEY.exec(key);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h - 8, mi, s);
}

// 解析 storage 模式 → { primary, backup }。primary: 'tg' | 'hf'。
//   'tg'      → { primary:'tg', backup:null }
//   'tg+hf'   → { primary:'tg', backup:'hf' }
//   'hf'      → { primary:'hf', backup:null }
// 默认 tg：不绑卡也能跑（HF 主存是实验档，读限 16 次/秒、单文件 30 MiB，故不作默认）。
// 没配对应密钥时上游 api.js 的 storagePlan 会把不可用的那一段去掉、并降级到可用后端。
export function splitStorage(mode) {
  const [primary = 'tg', ...rest] = String(mode || 'tg').split('+');
  const backup = rest.includes('hf') ? 'hf' : null;
  return { primary: primary === 'hf' ? 'hf' : 'tg', backup };
}
