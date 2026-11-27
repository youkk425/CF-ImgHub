// 上传页与管理页共用：图标、形状变形、登录闸门、语言菜单、提示条、确认框、API 调用
import { LANGS, applyI18n, detectLang, getBrand, getLang, setBrand, setLang, t } from './i18n.js';

export const $ = (s, root = document) => root.querySelector(s);

// ---------- 图标（Material Icons，Apache-2.0；内联以免请求外部字体） ----------
const ICONS = {
  upload: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
  cloud: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  public: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
  code: 'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
  md: 'M20.56 18H3.44C2.65 18 2 17.37 2 16.59V7.41C2 6.63 2.65 6 3.44 6h17.12c.79 0 1.44.63 1.44 1.41v9.18c0 .78-.65 1.41-1.44 1.41zM6.81 15.19v-3.66l1.92 2.35 1.92-2.35v3.66h1.93V8.81h-1.93l-1.92 2.35-1.92-2.35H4.89v6.38h1.92zM19.69 12h-1.92V8.81h-1.92V12h-1.93l2.89 3.28L19.69 12z',
  logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  shield: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z',
  refresh: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  translate: 'M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z',
  tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  visibility: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  open: 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
  image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
  movie: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
  file: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  selectAll: 'M3 5h2V3c-1.1 0-2 .9-2 2zm0 8h2v-2H3v2zm4 8h2v-2H7v2zM3 9h2V7H3v2zm10-6h-2v2h2V3zm6 0v2h2c0-1.1-.9-2-2-2zM5 21v-2H3c0 1.1.9 2 2 2zm-2-4h2v-2H3v2zM9 3H7v2h2V3zm2 18h2v-2h-2v2zm8-8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2zm0-12h2V7h-2v2zm0 8h2v-2h-2v2zm-4 4h2v-2h-2v2zm0-16h2V3h-2v2zM7 17h10V7H7v10zm2-8h6v6H9V9z',
  history: 'M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
  sweep: 'M5 13h14v-2H5v2zm-2 4h14v-2H3v2zM7 7v2h14V7H7z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  github: 'M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z',
  wallpaper: 'M4 4h7V2H4c-1.1 0-2 .9-2 2v7h2V4zm6 9-4 5h12l-3-4-2.03 2.71L10 13zm7-4.5c0-.83-.67-1.5-1.5-1.5S14 7.67 14 8.5s.67 1.5 1.5 1.5S17 9.33 17 8.5zM20 2h-7v2h7v7h2V4c0-1.1-.9-2-2-2zm0 18h-7v2h7c1.1 0 2-.9 2-2v-7h-2v7zM4 13H2v7c0 1.1.9 2 2 2h7v-2H4v-7z',
  rss: 'M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19 7.38 20 6.18 20 5 20 4 19 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27V4.44m0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93V10.1z',
  left: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  right: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  brightnessAuto: 'M10.85 12.65h2.3L12 9l-1.15 3.65zM20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM14.3 16l-.7-2h-3.2l-.7 2H7.8L11 7h2l3.2 9h-1.9z',
  lightMode: 'M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z',
  darkMode: 'M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z',
  palette: 'M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  error: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.file);
  svg.append(p);
  return svg;
}
// Logo：枫橙圆角方块 + 白色站点枫叶（awads.cc 的标志，按原图描成多边形），左下角一朵上传云把方块咬掉一角。
// 缺口用 mask 做成透明，任何背景上都成立；颜色由 CSS 的 .logo 规则控制。mask id 每个实例唯一
const LEAF = 'M49.6 1L49 18.1L56.6 17.6L52.1 22.6L52.1 22.9L51.4 23.5L50.8 24.5L46.9 28.8L46.9 29L40.1 36.9L55.6 30.6L54.6 36.5L64 39.4L25.6 43.4ZM31.5 3.4L34 8.4L34.2 8.5L34.2 9.2L27 29.5L26.4 30.8L26.1 31.9L25.9 32L12.2 15.4L10 10.1L9.1 8.6L9.1 8.2L16.2 14.8L20.8 10.9L23.2 26L23.2 27.2L23.5 27.4ZM6.1 9.9L8.9 15.6L8 20.6L4 18.9ZM0 20.9L0.4 20.9L14 27L21.5 43.6L21.5 44.1L21.2 44.2L19.1 48.2L3.2 44.5L3.4 44.1L3.6 44.1L5.5 42.4L7.8 40.8L7.9 40.1ZM63.6 42.8L63.9 42.9L55.5 51L55.8 51.6L57.8 53.6L37.1 56.8L36.8 57.2L36 63L35.8 63L35.2 62.2L34.2 61.5L34.2 61.2L24.2 51.1L23.9 51.4L18.9 61.2L18.6 61.5L15.2 61.8L23.5 47L58.2 43.5Z';
const CLOUD_BODY = 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z';
const CLOUD_ARROW = 'M14 13v4h-4v-4H7l5-5 5 5h-3z';
let logoSeq = 0;
export function logo(cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const id = `logo-mask-${++logoSeq}`;
  const ct = 'translate(-4 30) scale(1.32)';
  svg.setAttribute('viewBox', '-4 -3 70 70');
  svg.setAttribute('class', `logo ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    `<mask id="${id}"><rect x="-8" y="-8" width="80" height="80" fill="#fff"/><path d="${CLOUD_BODY}" transform="${ct}" stroke="#000" stroke-width="2.73" stroke-linejoin="round"/></mask>` +
    `<g mask="url(#${id})"><rect class="logo-bg" width="64" height="64" rx="18"/><path class="logo-leaf" transform="translate(10.6 8.6) scale(0.7)" d="${LEAF}"/></g>` +
    `<path class="logo-cloud" transform="${ct}" d="${CLOUD_BODY}"/><path class="logo-arrow" transform="${ct}" d="${CLOUD_ARROW}"/>`;
  return svg;
}
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    el.replaceWith(el.dataset.icon === 'logo' ? logo(el.className) : icon(el.dataset.icon, el.className));
  }
}

// ---------- 形状（M3E 形状库的近似：极坐标半径函数 → clip-path 多边形） ----------
// 顶点数统一为 N，这样任意两个形状之间都能用 WAAPI 平滑插值
const N = 96;
const SHAPES = {
  circle: () => 1,
  cookie9: (a) => 0.9 + 0.1 * Math.cos(9 * a),
  cookie7: (a) => 0.88 + 0.12 * Math.cos(7 * a),
  clover4: (a) => 0.78 + 0.22 * Math.abs(Math.cos(2 * a)) ** 0.6,
  burst12: (a) => 0.84 + 0.16 * Math.cos(12 * a) ** 3,
  pentagon: (a) => 0.9 + 0.1 * Math.cos(5 * a),
  sunny8: (a) => 0.92 + 0.08 * Math.cos(8 * a),
  pill: (a) => Math.min(1, 0.62 / Math.max(0.01, Math.abs(Math.cos(a)))) * 0.9 + 0.1,
};
const cache = {};
export function shape(name) {
  if (cache[name]) return cache[name];
  const f = SHAPES[name] || SHAPES.circle;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 50 * f(a);
    pts.push(`${(50 + r * Math.sin(a)).toFixed(2)}% ${(50 - r * Math.cos(a)).toFixed(2)}%`);
  }
  return (cache[name] = `polygon(${pts.join(',')})`);
}
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const SPRING = getComputedStyle(document.documentElement).getPropertyValue('--spring').trim() || 'ease-out';

// 静态形状
// 变形画在 ::before 上（CSS 变量 --shape），里面的图标保持不转
export function setShape(el, name) {
  el.style.setProperty('--shape', shape(name));
}
const PSEUDO = { pseudoElement: '::before' };

// 循环变形：每段用弹簧曲线停在一个形状上，同时整体缓慢旋转。返回控制器
export function morph(el, seq = ['cookie9', 'clover4', 'burst12', 'pentagon'], { step = 1600, spin = 12000 } = {}) {
  setShape(el, seq[0]);
  if (reduceMotion.matches) return { speed() {}, stop() {} };
  const frames = [...seq, seq[0]].map((n, i, arr) => ({ clipPath: shape(n), offset: i / (arr.length - 1), easing: SPRING }));
  const a = el.animate(frames, { ...PSEUDO, duration: step * seq.length, iterations: Infinity });
  const b = el.animate([{ rotate: '0deg' }, { rotate: '360deg' }], { ...PSEUDO, duration: spin, iterations: Infinity });
  return {
    speed(rate) {
      a.updatePlaybackRate(rate);
      b.updatePlaybackRate(rate);
    },
    stop() {
      a.cancel();
      b.cancel();
    },
  };
}

// 一次性形状切换（比如成功时变成 sunny）
export function morphTo(el, name, duration = 600) {
  const from = getComputedStyle(el, '::before').clipPath;
  for (const a of el.getAnimations({ subtree: true })) if (a.effect?.getKeyframes?.()[0]?.clipPath) a.cancel();
  setShape(el, name);
  if (!reduceMotion.matches) el.animate([{ clipPath: from }, { clipPath: shape(name) }], { ...PSEUDO, duration, easing: SPRING });
}

// M3E LoadingIndicator：多边形轮流变形 + 旋转
export function loader(contained = false) {
  const el = document.createElement('span');
  el.className = 'morph loader' + (contained ? ' contained' : '');
  morph(el, ['cookie9', 'pentagon', 'pill', 'burst12', 'clover4', 'sunny8'], { step: 650, spin: 4000 });
  if (!contained) return el;
  const box = document.createElement('span');
  box.className = 'loader-box';
  box.append(el);
  return box;
}

// 波浪进度条。p 为 null 时是不确定进度
export function wavy() {
  const el = document.createElement('div');
  el.className = 'wavy indeterminate';
  el.setAttribute('role', 'progressbar');
  el.innerHTML = '<div class="wave"></div><div class="track"></div>';
  return {
    el,
    set(p) {
      if (p == null) {
        el.classList.add('indeterminate');
        el.removeAttribute('aria-valuenow');
        return;
      }
      el.classList.remove('indeterminate');
      el.style.setProperty('--p', p);
      el.setAttribute('aria-valuenow', p);
    },
  };
}

// ---------- 语言 ----------
const BRAND_KEY = 'imghub.name'; // 站点名称缓存，免得每次先闪一下默认名
function useBrand(name) {
  if (name) localStorage.setItem(BRAND_KEY, name);
  else localStorage.removeItem(BRAND_KEY);
  setBrand(name);
}

export function initLang() {
  setBrand(localStorage.getItem(BRAND_KEY));
  setLang(detectLang());
  hydrateIcons();
  for (const b of document.querySelectorAll('[data-lang-menu]')) langMenu(b);
  for (const b of document.querySelectorAll('[data-mode-menu]')) modeMenu(b);
  moreMenu();
  // Logo 一律回上传页；已在上传页时只滚回顶部，不重新载入（免得丢掉上传队列）
  $('.topbar .brand')?.addEventListener('click', (e) => {
    if (location.pathname !== '/') return;
    e.preventDefault();
    scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  });
}

let menuSeq = 0;
// 弹出菜单：items() 每次打开时取 [[值, 文字, 图标?]]，current() 取当前值
function popMenu(button, items, current, pick) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.popover = 'auto';
  menu.id = `menu-${++menuSeq}`;
  document.body.append(menu);
  button.addEventListener('click', () => {
    menu.replaceChildren();
    for (const [v, label, ic] of items()) {
      const b = document.createElement('button');
      b.className = 'state';
      b.classList.toggle('on', v === current());
      if (ic) b.append(icon(ic));
      b.append(label);
      b.onclick = () => {
        pick(v);
        menu.hidePopover();
      };
      menu.append(b);
    }
    menu.showPopover();
    // 按钮收进了「更多」菜单（窄屏）时，菜单挂在「更多」按钮下面
    const anchor = button.getClientRects().length ? button : $('.topbar [data-more-menu]') || button;
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  });
}
// 窄屏顶栏的「更多」菜单：列出被收起（.ovf）且未隐藏的按钮，点选时转交给原按钮
function moreMenu() {
  const more = $('.topbar [data-more-menu]');
  if (!more) return;
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.popover = 'auto';
  menu.id = `menu-${++menuSeq}`;
  document.body.append(menu);
  more.addEventListener('click', () => {
    menu.replaceChildren();
    for (const el of document.querySelectorAll('.topbar .ovf')) {
      if (el.hidden) continue;
      if (el.id === 'logout' && menu.childElementCount) menu.append(Object.assign(document.createElement('div'), { className: 'sep' }));
      const b = document.createElement('button');
      b.className = 'state';
      const svg = el.querySelector('svg');
      if (svg) b.append(svg.cloneNode(true));
      b.append(el.getAttribute('aria-label') || el.title || '');
      b.onclick = () => {
        menu.hidePopover();
        el.click();
      };
      menu.append(b);
    }
    menu.showPopover();
    const r = more.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  });
}
function langMenu(button) {
  popMenu(button, () => Object.entries(LANGS), getLang, setLang);
}

// ---------- 深浅色 ----------
// 访客自选（记在本机）；管理员在设置页强制浅色/深色时按钮隐藏。配色与套用在 theme.js
const theme = window.imghubTheme;
const MODES = [
  ['auto', 'modeAuto', 'brightnessAuto'],
  ['light', 'modeLight', 'lightMode'],
  ['dark', 'modeDark', 'darkMode'],
];
function modeMenu(button) {
  if (!theme) return;
  const sync = () => {
    button.hidden = Boolean(theme.forced());
    button.replaceChildren(icon(MODES.find(([m]) => m === theme.userMode())[2]));
  };
  sync();
  document.addEventListener('themechange', sync);
  popMenu(button, () => MODES.map(([m, k, ic]) => [m, t(k), ic]), theme.userMode, theme.setMode);
}

// ---------- 链接域名 ----------
// 默认用当前打开页面的域名；后台登记了其他域名时，顶栏出现地球按钮，可选用哪个域名生成链接（记在本机）
const DOMAIN_KEY = 'imghub.domain';
let domains = [];
const domainChoices = () => [...new Set([location.host, ...domains])];
export function linkHost() {
  const saved = localStorage.getItem(DOMAIN_KEY);
  return saved && domainChoices().includes(saved) ? saved : location.host;
}
// 把服务端给的链接（当前域名）换成选定的域名
export function linkOf(url) {
  const u = new URL(url, location.href);
  const host = linkHost();
  // 不能只改 u.host：新值不带端口时会保留旧端口
  return host === u.host ? u.href : `https://${host}${u.pathname}${u.search}`;
}
export function setDomains(list) {
  domains = Array.isArray(list) ? list : [];
  const btn = $('[data-domain-menu]');
  if (!btn) return;
  btn.hidden = domainChoices().length < 2;
  if (!btn.dataset.ready) {
    btn.dataset.ready = '1';
    popMenu(btn, () => domainChoices().map((d) => [d, d]), linkHost, (v) => {
      if (v === location.host) localStorage.removeItem(DOMAIN_KEY);
      else localStorage.setItem(DOMAIN_KEY, v);
      snack(t('linkDomainSet', { host: v }));
      document.dispatchEvent(new CustomEvent('domainchange'));
    });
  }
}

// ---------- 提示条 ----------
let snackTimer;
export function snack(msg, { error = false } = {}) {
  let el = $('#snackbar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'snackbar';
    el.className = 'snackbar';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.replaceChildren(icon(error ? 'error' : 'check', 'sm'), document.createTextNode(msg));
  el.classList.toggle('raised', Boolean($('.ftb.show')));
  el.classList.add('show');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- 确认框 ----------
export function confirmBox({ title, text, ok = t('confirm'), iconName = 'delete' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = '<div class="dlg-icon"></div><h3 class="headline"></h3><p></p><div class="actions"><button class="btn state" value="no"></button><button class="btn danger state" value="yes"></button></div>';
    $('.dlg-icon', d).append(icon(iconName));
    $('h3', d).textContent = title;
    $('p', d).textContent = text;
    const [no, yes] = d.querySelectorAll('.actions button');
    no.textContent = t('cancel');
    yes.textContent = ok;
    no.onclick = () => d.close('no');
    yes.onclick = () => d.close('yes');
    d.onclose = () => {
      resolve(d.returnValue === 'yes');
      d.remove();
    };
    document.body.append(d);
    d.showModal();
    no.focus();
  });
}

// ---------- 复制 ----------
export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  snack(t('copied'));
  if (btn && !btn.classList.contains('ok')) {
    const old = btn.firstElementChild;
    btn.classList.add('ok');
    btn.replaceChildren(icon('check'));
    setTimeout(() => {
      btn.classList.remove('ok');
      btn.replaceChildren(old);
    }, 1200);
  }
}

// ---------- API ----------
export async function api(path, init = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    return { ok: false, status: 0, body: { error: 'network' } };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}
export function errText(r) {
  const code = r.body?.error ? `e_${r.body.error}` : null;
  return code && t(code) !== code ? t(code) : t('e_server', { s: r.status });
}

// ---------- 登录闸门 ----------
// need：'upload' | 'admin'。返回 { role, user }
export const canDo = (role, need) => role === 'admin' || (need === 'upload' && role === 'upload');

// bg：登录后这一页用哪组背景（'upload'；不传 = 无背景）。登录卡片显示时用 'login' 那组
export async function gate(need, { bg = null } = {}) {
  footer();
  const r = await api('/api/session');
  if (canDo(r.body?.role, need)) {
    document.body.classList.remove('locked');
    setDomains(r.body.domains);
    backdrop(bg);
    return r.body;
  }
  backdrop('login');
  // 登录成功后再取一次会话，拿到域名列表
  const s = await showLogin(need);
  api('/api/session').then((x) => setDomains(x.body?.domains));
  backdrop(bg);
  return s;
}

export async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.reload();
}

function showLogin(need) {
  return new Promise((resolve) => {
    document.body.classList.add('locked');
    const wrap = document.createElement('div');
    wrap.className = 'gate';
    wrap.innerHTML = `
      <div class="corner">
        <a class="btn icon state" href="${GITHUB}" target="_blank" rel="noopener" data-i18n-tip="github"><i data-icon="github"></i></a>
        <button class="btn icon state" data-mode-menu data-i18n-tip="colorMode"><i data-icon="brightnessAuto"></i></button>
        <button class="btn icon state" data-lang-menu data-i18n-tip="language"><i data-icon="translate"></i></button>
      </div>
      <div class="gate-card">
        <span class="emblem"><i data-icon="logo"></i><span class="badge"><i data-icon="lock"></i></span></span>
        <h1 class="headline"></h1>
        <div class="muted sub"></div>
        <form novalidate>
          <div class="field user"><input id="g-user" name="username" autocomplete="username" placeholder=" " spellcheck="false"><label for="g-user" data-i18n="username"></label></div>
          <div class="field pw"><input id="g-pw" name="password" type="password" autocomplete="current-password" placeholder=" "><label for="g-pw" data-i18n="password"></label>
            <button type="button" class="btn icon state eye" data-i18n-tip="showPw"><i data-icon="visibility"></i></button></div>
          <div class="err" role="alert"></div>
          <button class="btn filled lg block state submit" type="submit"><span data-i18n="signIn"></span></button>
        </form>
        <button class="btn sm state switch" type="button"></button>
      </div>`;
    document.body.prepend(wrap);
    hydrateIcons(wrap);
    langMenu($('[data-lang-menu]', wrap));
    modeMenu($('[data-mode-menu]', wrap));

    const card = $('.gate-card', wrap);
    const emblem = $('.emblem', wrap);
    const form = $('form', wrap);
    const err = $('.err', wrap);
    const submit = $('.submit', wrap);
    const sw = $('.switch', wrap);
    let mode = need === 'admin' ? 'admin' : 'upload';

    const render = () => {
      const admin = mode === 'admin';
      $('.user', wrap).hidden = !admin;
      $('h1', wrap).dataset.i18n = admin ? 'adminLoginTitle' : 'loginTitle';
      $('.sub', wrap).dataset.i18n = admin ? 'adminLoginSub' : 'loginSub';
      emblem.classList.toggle('admin', admin);
      $('.badge', emblem).replaceChildren(icon(admin ? 'shield' : 'lock'));
      // 管理页只接受管理员；上传页两种都可以
      sw.hidden = need === 'admin' && admin;
      sw.dataset.i18n = admin ? 'asUploader' : 'asAdmin';
      if (need === 'admin' && !admin) sw.dataset.i18n = 'asAdmin';
      err.textContent = '';
      applyI18n(wrap);
      (admin ? $('#g-user', wrap) : $('#g-pw', wrap)).focus();
    };
    const relabel = () => applyI18n(wrap);
    document.addEventListener('langchange', relabel);
    sw.onclick = () => {
      mode = mode === 'admin' ? 'upload' : 'admin';
      if (need === 'admin') mode = 'admin';
      render();
    };
    $('.eye', wrap).onclick = () => {
      const pw = $('#g-pw', wrap);
      pw.type = pw.type === 'password' ? 'text' : 'password';
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = { role: mode, password: $('#g-pw', wrap).value };
      if (mode === 'admin') body.username = $('#g-user', wrap).value.trim();
      submit.disabled = true;
      submit.replaceChildren(loader());
      const r = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      submit.disabled = false;
      submit.replaceChildren(Object.assign(document.createElement('span'), { textContent: t('signIn') }));
      $('span', submit).dataset.i18n = 'signIn';
      if (!r.ok) {
        err.textContent = errText(r);
        for (const f of form.querySelectorAll('.field')) f.classList.add('error');
        card.classList.remove('shake');
        void card.offsetWidth;
        card.classList.add('shake');
        $('#g-pw', wrap).select();
        return;
      }
      if (!canDo(r.body.role, need)) {
        err.textContent = t('e_forbidden');
        return;
      }
      emblem.classList.add('ok');
      $('.badge', emblem).replaceChildren(icon('check'));
      card.classList.add('out');
      setTimeout(() => {
        document.removeEventListener('langchange', relabel);
        wrap.remove();
        document.body.classList.remove('locked');
        resolve(r.body);
      }, 380);
    };
    for (const input of form.querySelectorAll('input')) {
      input.addEventListener('input', () => {
        for (const f of form.querySelectorAll('.field')) f.classList.remove('error');
        err.textContent = '';
      });
    }
    render();
  });
}

// ---------- 站点外观：背景图、页脚 ----------
export const GITHUB = 'https://github.com/TG-Twilight/CF-ImgHub';
// 内建快捷链接：始终显示在页脚，不出现在设置页；名称随界面语言
export const BUILTIN_LINKS = [
  { i18n: 'siteAwads', url: 'https://awads.cc/' },
  { i18n: 'siteAwavenue', url: 'https://awavenue.top/' },
];
let siteReq;
// 公开设置（站点名称、背景、页脚链接、主题）：每页只取一次；设置页保存后用 setSite() 更新
export const site = () =>
  (siteReq ??= api('/api/site').then((r) => {
    if (!r.ok) return { bg: { urls: [] }, links: [] };
    theme?.setSite(r.body.theme);
    useBrand(r.body.name);
    return r.body;
  }));
export function setSite(info) {
  siteReq = Promise.resolve(info);
  theme?.setSite(info.theme);
  useBrand(info.name);
  footer();
}
const BG_FADE = 1200; // 与 CSS 里 .backdrop img 的淡入时长一致

// 背景轮播：两层 <img> 交替淡入。which = 'login' | 'upload' | null（无背景）
let bg = { sig: null, timer: 0 };
export async function backdrop(which) {
  const info = await site();
  const keys = which && info.bg?.[which] ? info.bg.urls ?? [] : []; // 图片地址（本站路径或外部 https）
  const sig = `${which}|${keys.join('|')}|${info.bg?.interval}`;
  if (sig === bg.sig) return;
  clearInterval(bg.timer);
  const state = (bg = { sig, timer: 0 });
  let box = $('.backdrop');
  if (!keys.length) {
    document.body.classList.remove('has-bg');
    box?.classList.remove('show');
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.className = 'backdrop';
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<img alt="" referrerpolicy="no-referrer"><img alt="" referrerpolicy="no-referrer">';
    document.body.prepend(box);
  }
  const layers = [...box.querySelectorAll('img')];
  let front = layers.findIndex((l) => l.classList.contains('on'));
  if (front < 0) front = 0;
  let i = Math.floor(Math.random() * keys.length);
  const show = async (key) => {
    const next = layers[1 - front];
    next.src = key;
    try {
      await next.decode();
    } catch {
      return; // 图片被删或加载失败：保持当前这张
    }
    if (state !== bg) return; // 期间页面换了背景
    next.classList.add('on');
    layers[front].classList.remove('on');
    front = 1 - front;
    document.body.classList.add('has-bg');
    box.classList.add('show');
  };
  await show(keys[i]);
  if (keys.length < 2 || reduceMotion.matches || state !== bg) return;
  state.timer = setInterval(() => {
    if (document.hidden) return;
    i = (i + 1) % keys.length;
    show(keys[i]);
  }, (info.bg.interval || 10) * 1000 + BG_FADE);
}

// 页脚：项目名 + GitHub + 快捷链接（内建两站在前）
export async function footer() {
  let el = $('footer.foot');
  if (!el) {
    el = document.createElement('footer');
    el.className = 'foot';
    document.body.append(el);
    document.addEventListener('langchange', () => footer());
  }
  const info = await site();
  const link = (href, ...content) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.append(...content);
    return a;
  };
  const row = (cls, ...content) => {
    const d = document.createElement('div');
    d.className = `foot-row ${cls}`;
    d.append(...content);
    return d;
  };
  const brand = document.createElement('span');
  brand.className = 'foot-brand';
  const name = document.createElement('span');
  name.dataset.brand = '';
  name.textContent = getBrand();
  brand.append(logo('foot-logo'), name);
  const gh = link(GITHUB, icon('github', 'sm'), t('footSource'));
  gh.className = 'gh';
  const label = document.createElement('span');
  label.className = 'foot-label';
  label.append(icon('link', 'sm'), t('friendLinks'));
  const friends = [...BUILTIN_LINKS.map((b) => ({ name: t(b.i18n), url: b.url })), ...(info.links ?? [])];
  el.replaceChildren(row('', brand, gh), row('friends', label, ...friends.map((l) => link(l.url, l.name))));
}

// ---------- 杂项 ----------
// 上传时间：两种 key 都带时间（规范名是 UTC+8 的钟面），解析不出就用清单里的 uploaded（从 key 时间戳还原）
export function timeOf(o) {
  const ts = /^(\d{13})_/.exec(o.key)?.[1];
  if (ts) return Number(ts);
  const m = /^ImgHub-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(o.key);
  if (m) return Date.UTC(+m[1], m[2] - 1, +m[3], m[4] - 8, +m[5], +m[6]);
  return Date.parse(o.uploaded) || 0;
}

export function size(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export const when = (ms, style = 'medium') => new Date(ms).toLocaleString(getLang(), { dateStyle: style, timeStyle: 'short' });

// 顶栏滚动后加底色
export function topbarShadow() {
  const bar = $('.topbar');
  if (!bar) return;
  const f = () => bar.classList.toggle('scrolled', scrollY > 4);
  addEventListener('scroll', f, { passive: true });
  f();
}

export function snippet(kind, entry) {
  const url = linkOf(entry.url);
  if (kind === 'md') return `![${entry.name.replace(/[[\]\\]/g, '\\$&')}](${url})`;
  if (kind === 'html') return `<img src="${url}" alt="${entry.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" loading="lazy">`;
  return url;
}
