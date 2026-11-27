// 运行时设置（后台可改）：存成 KV（env.META）里的一个 JSON 值，读路径在 isolate 内存里缓存 30 秒。
// 放 KV：R2 移除后元数据的载体（免绑卡、Workers 原生、改了不用重新部署）；读路径每个 isolate 每 30 秒最多读一次。
//
// 防盗链语义：hotlink=true 时全局开启；allow 是后台填的放行网站（含子域）；exempt 里的 key 单独放行（单张开关）。
// domains：本图床绑定的其他域名（只认完整主机名）。上传页/管理页可选用哪个域名生成链接，防盗链也把它们当作自身。
// rss：是否放行内建的网页版 RSS 阅读器名单（默认开）。
// storage：新上传的字节存到哪个后端。三种模式（默认 tg，设置页可切换）：
//   tg      只存 Telegram（不占对象存储，HF 不启用）
//   tg+hf   Telegram 主存，另归档一份到 HuggingFace（容灾）
//   hf      只存 HuggingFace（实验档：Worker 代读、读限约 16 次/秒、单文件 30 MiB）
//   没配 TG_BOT_TOKEN/TG_CHAT_ID 或 HF_* 密钥时，未就绪的后端会被自动降级（见 api.js 的 storagePlan）。
// bg：登录页 / 上传页背景，urls 是图片地址（https 完整地址或本站 /file/… 路径，最多 5 个，多于 1 个时轮播），interval 为轮播秒数。
// 旧版存的是 keys（本图床的 key），读取时自动转成 /file/<key>。
// theme：{color, mode, logo, glow}。glow：各页（含登录页）的撞色渐层背景，默认 true。logo=true 时 Logo 与站名改用主题色（默认 false = 枫橙 Logo）。color 是预设名（见 THEME_COLORS，配色在前端 theme.js 生成）或 #rrggbb 自定义种子色；
// mode = auto（访客可自己切换深浅色，默认跟随系统）| light | dark（强制，所有访客生效，切换按钮隐藏）。登录前就要用，经 /api/site 公开。
// name：站点名称（页面标题、顶栏、页脚），空字符串 = 默认 CF ImgHub；登录前就要用，经 /api/site 公开。
// links：页脚里额外的友情链接 [{name, url}]（秋风塬上、秋风广告规则两站是内建的，写死在前端 ui.js，不能移除）。bg 与 links 登录前就要用，经 GET /api/site 公开（见 siteInfo）。
// gone：已删除的 key 与删除时间 [[key, ms]]。读路径在查缓存之前比对，所以删除 30 秒内全球生效
// （Cache API 只能清当前机房，其他机房的缓存最长留一年）；也挡住旧 key 被删后又从旧图床回源迁移回来。
// 保留 GONE_TTL（略长于缓存一年），最多 MAX_GONE 条；不对外公开。
// 单张设置不写进对象的 customMetadata，因为图片回应会在 Cache API 里缓存一年，
// 改了 metadata 也清不掉其他机房的缓存；放在设置里则所有机房 30 秒内生效。
import { getRawSettings, putRawSettings } from './meta.js';
import { splitStorage } from './stores.js';

const SETTINGS_KEY = 'settings'; // KV key（原 .imghub/settings.json 对象）
const TTL = 30 * 1000;
// 没有设置对象时：防盗链关闭，放行名单预置三项（本站两个博客 + 示例域名，部署者在管理页改成自己的）
const DEFAULTS = {
  name: '',
  hotlink: false,
  rss: true,
  allow: ['awads.cc', 'awavenue.top', 'example.com'],
  exempt: [],
  domains: [],
  bg: { urls: [], login: true, upload: true, interval: 10 },
  links: [],
  storage: 'tg',
  theme: { color: 'maple', mode: 'auto', logo: false, glow: true },
};
export const THEME_COLORS = ['maple', 'sakura', 'amber', 'bamboo', 'teal', 'ocean', 'violet', 'ink'];
export const THEME_MODES = ['auto', 'light', 'dark'];
export const normThemeColor = (c) => (THEME_COLORS.includes(c) ? c : typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null);
// 三种字节后端模式，默认 tg（免绑卡即可跑）；hf 是实验档（读限约 16 次/秒、单文件 30 MiB），不作默认
export const STORAGE_MODES = ['tg', 'tg+hf', 'hf'];
export { splitStorage }; // 'r2+tg+hf' → { primary:'tg', backup:null }；'tg+hf' → { primary:'tg', backup:'hf' }；'hf' → { primary:'hf', backup:null }
export const MAX_SITES = 200;
export const MAX_DOMAINS = 20;
export const MAX_BG = 5;
export const MAX_LINKS = 10;
export const MAX_NAME = 40;
export const BG_INTERVALS = [5, 10, 20, 40];
const GONE_TTL = 400 * 86400 * 1000;
const MAX_GONE = 20000;

let memo = null;
let memoAt = 0;

// fresh：改设置前读最新值，免得用了本 isolate 里过期的副本、覆盖掉别处刚写的修改
export async function getSettings(env, { fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memoAt < TTL) return memo;
  let data = {};
  try {
    const raw = await getRawSettings(env);
    if (raw) data = raw;
  } catch (err) {
    console.warn('settings read failed', err.message);
    if (memo) return memo; // 读失败时沿用旧值，别因此放开防盗链
  }
  memo = withSets(normalize(data));
  memoAt = Date.now();
  return memo;
}

export async function saveSettings(env, next) {
  const data = normalize(next);
  await putRawSettings(env, data);
  memo = withSets(data);
  memoAt = Date.now();
  return data;
}

const withSets = (d) => ({ ...d, exemptSet: new Set(d.exempt), domainSet: new Set(d.domains), goneSet: new Set(d.gone.map(([k]) => k)) });

// 已删除名单：去掉过期的、重复的（保留最新一次），按时间新的在前截断
function normGone(list) {
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  const map = new Map();
  for (const e of list) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[0] || e[0].startsWith('.') || !Number.isFinite(e[1])) continue;
    if (now - e[1] > GONE_TTL) continue;
    if (!(map.get(e[0]) >= e[1])) map.set(e[0], e[1]);
  }
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, MAX_GONE);
}

// 只保留已知字段；allow / domains 规范化成主机名，exempt 去重
function normalize(d) {
  const bg = d?.bg && typeof d.bg === 'object' ? d.bg : {};
  return {
    name: normName(d?.name) ?? DEFAULTS.name,
    hotlink: typeof d?.hotlink === 'boolean' ? d.hotlink : DEFAULTS.hotlink,
    rss: typeof d?.rss === 'boolean' ? d.rss : DEFAULTS.rss,
    allow: Array.isArray(d?.allow) ? [...new Set(d.allow.map(normSite).filter(Boolean))].slice(0, MAX_SITES) : [...DEFAULTS.allow],
    exempt: Array.isArray(d?.exempt) ? [...new Set(d.exempt.filter((k) => typeof k === 'string' && k))] : [],
    gone: normGone(d?.gone),
    domains: Array.isArray(d?.domains) ? [...new Set(d.domains.map(normSite).filter(Boolean))].slice(0, MAX_DOMAINS) : [],
    bg: {
      urls: [...new Set((Array.isArray(bg.urls) ? bg.urls : Array.isArray(bg.keys) ? bg.keys.filter(isFileKey).map((k) => `/file/${encodeURIComponent(k)}`) : []).map(normBgUrl).filter(Boolean))].slice(0, MAX_BG),
      login: typeof bg.login === 'boolean' ? bg.login : DEFAULTS.bg.login,
      upload: typeof bg.upload === 'boolean' ? bg.upload : DEFAULTS.bg.upload,
      interval: BG_INTERVALS.includes(bg.interval) ? bg.interval : DEFAULTS.bg.interval,
    },
    links: Array.isArray(d?.links) ? d.links.map(normLink).filter(Boolean).slice(0, MAX_LINKS) : [],
    storage: STORAGE_MODES.includes(d?.storage) ? d.storage : DEFAULTS.storage,
    theme: {
      color: normThemeColor(d?.theme?.color) ?? DEFAULTS.theme.color,
      mode: THEME_MODES.includes(d?.theme?.mode) ? d.theme.mode : DEFAULTS.theme.mode,
      logo: typeof d?.theme?.logo === 'boolean' ? d.theme.logo : DEFAULTS.theme.logo,
      glow: typeof d?.theme?.glow === 'boolean' ? d.theme.glow : DEFAULTS.theme.glow,
    },
  };
}

// 站点名称：去掉首尾与连续空白，最多 40 字；空字符串表示用默认名；不是字符串或过长返回 null
export function normName(n) {
  if (typeof n !== 'string') return null;
  const s = n.replace(/\s+/g, ' ').trim();
  return [...s].length > MAX_NAME ? null : s;
}

export const isFileKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 1024 && !k.startsWith('.');

// 背景图地址：https 完整地址，或以 / 开头的本站路径（不收 //host 这种协议相对地址）；不合法返回 null
export function normBgUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 1000) return null;
  if (s.startsWith('/')) return s.startsWith('//') || /\s/.test(s) ? null : s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.href : null; // http 图片在 https 页面上会被浏览器拦下
  } catch {
    return null;
  }
}

// 友情链接：名称 1–40 字，地址只收 http(s)；不合法返回 null
export function normLink(l) {
  const name = typeof l?.name === 'string' ? l.name.trim() : '';
  if (!name || [...name].length > 40 || typeof l?.url !== 'string') return null;
  try {
    const u = new URL(l.url.trim().includes('://') ? l.url.trim() : `https://${l.url.trim()}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(u.hostname) || u.href.length > 500) return null;
    return { name, url: u.href };
  } catch {
    return null;
  }
}

// 后台填的网站 → 小写主机名。接受 blog.example.com、https://example.com/path、*.example.com、中文域名（转成 punycode）；
// 不合法返回 null。example.com 同时放行它的所有子域
export function normSite(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase().replace(/^\*?\./, '');
  if (!s || s.length > 253) return null;
  try {
    const host = new URL(s.includes('://') ? s : `http://${s}`).hostname;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function publicSettings(s) {
  return { name: s.name, hotlink: s.hotlink, rss: s.rss, allow: s.allow, exempt: s.exempt, domains: s.domains, bg: s.bg, links: s.links, storage: s.storage, theme: s.theme };
}

// 不登录也能读的部分（站点名称、登录页背景、页脚、主题）
export function siteInfo(s) {
  return { name: s.name, bg: s.bg, links: s.links, theme: s.theme };
}
