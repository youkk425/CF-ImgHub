// 设置页（管理员）：站点名称、防盗链与 RSS 阅读器放行、放行网站、链接域名、存储（R2 / Telegram / HuggingFace）、主题与深浅色、登录页/上传页背景、页脚友情链接。
// 每项改动立即保存（POST /api/settings），服务端负责规范化与校验
import { t } from './i18n.js';
import { $, api, errText, gate, icon, initLang, logout, setDomains, setShape, setSite, size, snack, topbarShadow } from './ui.js';

const MAX_BG = 5;
const INTERVALS = [5, 10, 20, 40];
let settings = null;
let saving = false;

initLang();
topbarShadow();
for (const el of document.querySelectorAll('[data-shape]')) setShape(el, el.dataset.shape);
$('#logout').onclick = logout;
document.addEventListener('langchange', () => settings && apply(settings));

const setToggle = (b, on) => b.setAttribute('aria-checked', String(on));
const post = (body) => api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// 保存期间忽略重复点击；btn 显示忙碌状态
async function save(body, btn) {
  if (saving) return false;
  saving = true;
  btn?.setAttribute('aria-busy', 'true');
  const r = await post(body);
  saving = false;
  btn?.removeAttribute('aria-busy');
  if (!r.ok) {
    if (r.status === 401) return reauth();
    const e = r.body?.error;
    snack(e === 'bad_site' ? t('e_bad_site', { site: r.body.site }) : e === 'bad_link' ? t('e_bad_link', { site: r.body.site }) : e === 'bad_url' ? t('e_bad_url', { site: r.body.site }) : errText(r), { error: true });
    return false;
  }
  apply(r.body);
  snack(t('saved'));
  return true;
}

function apply(s) {
  settings = s;
  for (const row of document.querySelectorAll('[data-flag]')) setToggle($('.toggle', row), s[row.dataset.flag]);
  for (const row of document.querySelectorAll('[data-bg]')) setToggle($('.toggle', row), s.bg[row.dataset.bg]);
  $('#rssNote').textContent = t('rssNote', { list: (s.rssReaders ?? []).join(', ') });
  renderChips('allow');
  renderChips('domains');
  renderBg();
  renderLinks();
  renderStorage();
  renderTheme();
  setDomains(s.domains);
  $('#siteName').value = s.name;
  setSite({ name: s.name, bg: s.bg, links: s.links, theme: s.theme });
}

// ---------- 站点名称：留空 = 默认名 ----------
$('#nameForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#siteName').value.trim();
  if (v !== settings.name) save({ name: v }, $('#nameForm button'));
};

// ---------- 开关（整行可点；开关本身的点击会冒泡上来） ----------
for (const row of document.querySelectorAll('[data-flag]')) {
  row.onclick = () => save({ [row.dataset.flag]: !settings[row.dataset.flag] }, $('.toggle', row));
}
for (const row of document.querySelectorAll('[data-bg]')) {
  row.onclick = () => save({ bg: { [row.dataset.bg]: !settings.bg[row.dataset.bg] } }, $('.toggle', row));
}

// ---------- 放行网站 / 链接域名：胶囊 + × 移除，保存整份名单 ----------
const CHIPS = {
  allow: { box: '#sites', form: '#siteForm', input: '#siteInput', empty: 'sitesEmpty' },
  domains: { box: '#domains', form: '#domainForm', input: '#domainInput', empty: 'domainsEmpty' },
};
function chip(text, onRemove) {
  const c = document.createElement('span');
  c.className = 'chip';
  const name = document.createElement('span');
  name.textContent = text;
  c.append(name);
  if (onRemove) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x state';
    x.title = x.ariaLabel = t('removeSite', { site: text });
    x.append(icon('close', 'sm'));
    x.onclick = () => onRemove(x);
    c.append(x);
  }
  return c;
}
function emptyNote(key) {
  const p = document.createElement('span');
  p.className = 'chips-empty';
  p.textContent = t(key);
  return p;
}
function renderChips(field) {
  const box = $(CHIPS[field].box);
  box.replaceChildren();
  if (!settings[field].length) box.append(emptyNote(CHIPS[field].empty));
  for (const site of settings[field]) box.append(chip(site, (x) => save({ [field]: settings[field].filter((d) => d !== site) }, x)));
}
for (const [field, c] of Object.entries(CHIPS)) {
  $(c.form).onsubmit = async (e) => {
    e.preventDefault();
    const input = $(c.input);
    // 允许一次贴多个：空格、逗号、换行分隔
    const add = input.value.split(/[\s,，、]+/).filter(Boolean);
    if (!add.length) return input.focus();
    if (await save({ [field]: [...settings[field], ...add] }, $(`${c.form} button`))) input.value = '';
  };
}

// ---------- 快捷链接：内建两站只显示在页脚，这里只管自定义的 ----------
function renderLinks() {
  const box = $('#links');
  box.replaceChildren();
  if (!settings.links.length) box.append(emptyNote('linksEmpty'));
  for (const l of settings.links) {
    const c = chip(l.name, (x) => save({ links: settings.links.filter((v) => v !== l) }, x));
    c.title = l.url;
    box.append(c);
  }
}
$('#linkForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#linkName').value.trim();
  const url = $('#linkUrl').value.trim();
  if (!name) return $('#linkName').focus();
  if (!url) return $('#linkUrl').focus();
  if (await save({ links: [...settings.links, { name, url }] }, $('#linkForm button'))) {
    $('#linkName').value = '';
    $('#linkUrl').value = '';
  }
};

// ---------- 背景图：填地址（本站 /file/… 或任意 https 图片），最多 5 个 ----------
function renderBg() {
  const urls = settings.bg.urls;
  const box = $('#bgList');
  box.replaceChildren();
  urls.forEach((src, i) => {
    const item = document.createElement('div');
    item.className = 'bg-item';
    const img = new Image();
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = src;
    img.onerror = () => img.replaceWith(icon('image'));
    item.title = src;
    const n = document.createElement('span');
    n.className = 'bg-n';
    n.textContent = i + 1;
    const bar = document.createElement('div');
    bar.className = 'bg-acts';
    const act = (name, tip, fn, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn icon sm state';
      b.title = b.ariaLabel = t(tip);
      b.disabled = disabled;
      b.append(icon(name, 'sm'));
      b.onclick = () => fn(b);
      return b;
    };
    const move = (d) => (b) => {
      const next = [...urls];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      save({ bg: { urls: next } }, b);
    };
    bar.append(
      act('left', 'moveLeft', move(-1), i === 0),
      act('right', 'moveRight', move(1), i === urls.length - 1),
      act('delete', 'remove', (b) => save({ bg: { urls: urls.filter((_, j) => j !== i) } }, b)),
    );
    item.append(img, n, bar);
    box.append(item);
  });
  if (!urls.length) box.append(emptyNote('bgEmpty'));
  const full = urls.length >= MAX_BG;
  $('#bgUrl').disabled = full;
  $('#bgForm button').disabled = full;
  $('#bgUrl').placeholder = t(full ? 'bgMax' : 'bgUrl');

  const group = $('#bgInterval');
  group.replaceChildren(
    ...INTERVALS.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t('secN', { n: s });
      b.classList.toggle('on', s === settings.bg.interval);
      b.onclick = () => s !== settings.bg.interval && save({ bg: { interval: s } }, group);
      return b;
    }),
  );
  $('#intervalField').classList.toggle('dim', urls.length < 2);
}

// 本图床的图片链接（任一绑定域名）存成 /file/… 路径，换域名也不失效；可一次贴多个（空白分隔）
function bgPath(s) {
  try {
    const u = new URL(s, location.href);
    const own = u.host === location.host || (settings.domains ?? []).includes(u.hostname);
    return own && u.pathname.startsWith('/file/') ? u.pathname : s;
  } catch {
    return s;
  }
}
$('#bgForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#bgUrl');
  const add = input.value.split(/\s+/).filter(Boolean).map(bgPath);
  if (!add.length) return input.focus();
  const next = [...new Set([...settings.bg.urls, ...add])];
  if (next.length > MAX_BG) return snack(t('bgMax'), { error: true });
  if (await save({ bg: { urls: next } }, $('#bgForm button'))) input.value = '';
};

// ---------- 主题：预设色 + 自定义种子色；深浅色可强制 ----------
const THEME = window.imghubTheme;
const THEME_MODES = [
  ['auto', 'themeModeAuto', 'hintModeAuto'],
  ['light', 'themeModeLight', 'hintModeForced'],
  ['dark', 'themeModeDark', 'hintModeForced'],
];
// 色块：主色 / 次色 / 第三色三分，都取深色方案里的色调 80，深浅背景上都清楚
function paintSwatch(el, seed) {
  const p = THEME.palette(seed, true);
  el.style.setProperty('--c1', p.primary);
  el.style.setProperty('--c2', p.secondary);
  el.style.setProperty('--c3', p.tertiary);
}
function swatch(label, on, onPick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch state';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(on));
  b.title = b.ariaLabel = label;
  b.append(icon('check', 'sm'));
  b.onclick = onPick;
  return b;
}
function renderTheme() {
  const cur = settings.theme;
  const box = $('#swatches');
  box.replaceChildren(
    ...Object.entries(THEME.PRESETS).map(([name, seed]) => {
      const b = swatch(t(`color_${name}`), cur.color === name, () => cur.color !== name && save({ theme: { color: name } }, box));
      paintSwatch(b, seed);
      return b;
    }),
  );
  // 自定义：色块里叠一个透明的取色器，选完（change）才保存
  const custom = cur.color.startsWith('#');
  const c = swatch(t('colorCustom'), custom, null);
  c.classList.add('custom');
  if (custom) paintSwatch(c, cur.color);
  else c.append(icon('palette', 'sm'));
  const pick = document.createElement('input');
  pick.type = 'color';
  pick.value = custom ? cur.color : THEME.PRESETS.maple;
  pick.tabIndex = -1;
  pick.onchange = () => save({ theme: { color: pick.value } }, box);
  pick.onclick = (e) => e.stopPropagation(); // 别冒泡回色块的 onclick 再触发一次
  c.onclick = () => pick.click();
  c.append(pick);
  box.append(c);

  const group = $('#themeMode');
  group.replaceChildren(
    ...THEME_MODES.map(([m, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(label);
      b.classList.toggle('on', m === cur.mode);
      b.onclick = () => m !== cur.mode && save({ theme: { mode: m } }, group);
      return b;
    }),
  );
  for (const row of document.querySelectorAll('[data-theme-flag]')) setToggle($('.toggle', row), cur[row.dataset.themeFlag]);
  $('#themeModeHint').textContent = t(THEME_MODES.find(([m]) => m === cur.mode)[2]);
}

for (const row of document.querySelectorAll('[data-theme-flag]')) {
  const f = row.dataset.themeFlag;
  row.onclick = () => save({ theme: { [f]: !settings.theme[f] } }, $('.toggle', row));
}

// ---------- 存储：R2 / Telegram / HuggingFace 的组合。枚举的第一段是主存，其余是备份盘 ----------
const MODES = [
  ['r2', 'modeR2', 'hint_r2'],
  ['r2+tg', 'modeBackup', 'hint_r2tg'],
  ['tg', 'modeTg', 'hint_tg'],
  ['r2+hf', 'modeR2Hf', 'hint_r2hf'],
  ['tg+hf', 'modeTgHf', 'hint_tghf'],
  ['r2+tg+hf', 'modeAll', 'hint_all'],
  ['hf', 'modeHfOnly', 'hint_hf'], // 实验值：字节只进 bucket，读必须 Worker 代读
];
// 某一段能不能用：tg 要 bot 密钥，hf 要 S3 密钥；r2 永远可用
const ready = (token) => (token === 'tg' ? settings.tgReady : token === 'hf' ? settings.hfReady : true);
const modeReady = (m) => m.split('+').every(ready);

function renderStorage() {
  const group = $('#storageMode');
  group.replaceChildren(
    ...MODES.map(([m, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(label);
      b.classList.toggle('on', m === settings.storage);
      b.disabled = !modeReady(m);
      b.onclick = () => m !== settings.storage && save({ storage: m }, group);
      return b;
    }),
  );
  const miss = settings.storage.split('+').find((x) => !ready(x));
  $('#storageHint').textContent = miss ? t(miss === 'hf' ? 'hfNotReady' : 'tgNotReady') : t(MODES.find(([m]) => m === settings.storage)[2]);
  $('#tgBackup').hidden = !settings.tgReady;
  $('#hfBackup').hidden = !settings.hfReady;
  renderBackup('tg');
  renderBackup('hf');
}

// 补备份：两个备份盘共用一套循环，只是端点、批量与文案不同。
// Telegram 会限流（按它给的秒数等），HF 撞 503 Slow Down 走同一条 retryAfter 分支。
const BACKUPS = {
  tg: { card: '#tgBackup', note: '#tgBackupNote', btn: '#tgBackupBtn', status: '/api/tg/status', run: '/api/tg/backup', batch: 3 },
  hf: { card: '#hfBackup', note: '#hfBackupNote', btn: '#hfBackupBtn', status: '/api/hf/status', run: '/api/hf/backup', batch: 10 },
};
const STATE = {
  tg: (s) => t('tgBackupState', { backed: s.backed, pending: s.pending.length, tgOnly: s.tgOnly }),
  hf: (s) => t('hfBackupState', {
    backed: s.backed, pending: s.pending.length, queued: s.queued,
    bytes: size(s.bytes), pct: s.quotaPct, files: s.files,
  }),
};
const backup = { tg: { status: null, progress: null }, hf: { status: null, progress: null } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function renderBackup(kind) {
  const c = BACKUPS[kind];
  const st = backup[kind];
  if (st.progress) $(c.note).textContent = t(st.progress.wait ? `${kind}BackupWait` : `${kind}BackupProgress`, st.progress);
  else $(c.note).textContent = st.status ? STATE[kind](st.status) : '';
  $(c.btn).disabled = Boolean(st.progress) || !st.status?.pending.length;
}
async function loadBackup(kind) {
  if (!settings || !ready(kind)) return;
  const r = await api(BACKUPS[kind].status);
  if (r.ok) backup[kind].status = r.body;
  renderBackup(kind);
}
async function runBackup(kind) {
  const c = BACKUPS[kind];
  const st = backup[kind];
  if (st.progress || !st.status?.pending.length) return;
  const queue = [...st.status.pending];
  st.progress = { done: 0, total: queue.length };
  let ok = 0;
  let failed = 0;
  $(c.btn).setAttribute('aria-busy', 'true');
  renderBackup(kind);
  while (queue.length) {
    const batch = queue.splice(0, c.batch);
    const r = await api(c.run, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: batch }) });
    if (!r.ok) {
      snack(errText(r), { error: true });
      break;
    }
    const res = r.body.results;
    ok += res.filter((x) => x.status !== 'failed').length;
    failed += res.filter((x) => x.status === 'failed').length;
    st.progress.done += res.length;
    queue.unshift(...batch.slice(res.length)); // 限流时没处理到的放回队首
    if (r.body.retryAfter) {
      for (let s = r.body.retryAfter + 1; s > 0; s--) {
        st.progress.wait = true;
        st.progress.s = s;
        renderBackup(kind);
        await sleep(1000);
      }
      st.progress.wait = false;
    }
    renderBackup(kind);
  }
  st.progress = null;
  $(c.btn).removeAttribute('aria-busy');
  snack(t(`${kind}BackupDone`, { n: ok, failed }), { error: failed > 0 });
  loadBackup(kind);
}
for (const kind of Object.keys(BACKUPS)) $(BACKUPS[kind].card).onclick = () => runBackup(kind);

// ---------- 启动 ----------
let reauthing = null;
function reauth() {
  if (reauthing) return false;
  snack(t('sessionExpired'), { error: true });
  reauthing = gate('admin').then(() => {
    reauthing = null;
    load();
  });
  return false;
}
async function load() {
  const r = await api('/api/settings');
  if (!r.ok) {
    if (r.status === 401) return reauth();
    return snack(errText(r), { error: true });
  }
  apply(r.body);
  loadTg();
}

await gate('admin');
load();
