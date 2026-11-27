// 管理页：管理员登录 → 列出桶内全部文件 → 搜索、筛选、预览、复制、批量删除。其余设置在设置页（settings.js）
import { t } from './i18n.js';
import { makeThumb, putThumb, thumbUrl } from './thumb.js';
import { $, api, confirmBox, copyText, errText, gate, icon, initLang, linkOf, loader, logout, setDomains, setShape, size, snack, snippet, timeOf, topbarShadow, when } from './ui.js';

const PAGE = 120; // 每次渲染的卡片数，避免文件多时 DOM 过大
let all = []; // 新的在前
let view = [];
let shown = 0;
let filter = 'all';
let query = '';
const selected = new Set();
let current = null;
let thumbs = new Set(); // 已有缩略图的 key
let archived = new Set(); // 已归档到 HuggingFace 的 key（与 thumbs 同样从 /api/list 内部前缀页拼出）
const SMALL = 1024 * 1024; // 没有缩略图时，这么小的原图直接拿来显示
// 浏览器解不了、补不出缩略图的类型
const NO_THUMB = /^image\/(heic|heif|tiff|jxl|svg)/i;

initLang();
topbarShadow();
for (const el of document.querySelectorAll('[data-shape]')) setShape(el, el.dataset.shape);
$('#logout').onclick = logout;
$('#refresh').onclick = () => load();
document.addEventListener('langchange', () => {
  render();
  if (!filling) syncThumbFill();
  syncSelection();
  applySettings(settings);
});

// ---------- 防盗链设置 ----------
let settings = { hotlink: false, allow: [], exempt: [], domains: [] };
let exempt = new Set();
const setToggle = (b, on) => b.setAttribute('aria-checked', String(on));
function applySettings(s) {
  settings = s;
  exempt = new Set(s.exempt);
  setToggle($('#hotlink'), s.hotlink);
  $('.stat.s4').classList.toggle('on', s.hotlink);
  $('#hotlinkState').textContent = t(s.hotlink ? 'hotlinkOn' : 'hotlinkOff');
  $('#exemptCount').textContent = t('exemptN', { n: exempt.size });
  for (const el of document.querySelectorAll('.tile')) el.classList.toggle('exempt', exempt.has(el.dataset.key));
  if (current) setToggle($('[data-exempt]', dlg), exempt.has(current.key));
  setDomains(s.domains);
}

// 整张卡片 / 整行都可以点（开关本身的点击会冒泡上来，所以开关上不另外绑事件）；保存期间忽略重复点击
let saving = false;
async function saveSetting(path, body, btn) {
  if (saving) return;
  saving = true;
  btn.setAttribute('aria-busy', 'true');
  const r = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  saving = false;
  btn.removeAttribute('aria-busy');
  if (!r.ok) {
    if (r.status === 401) return reauth();
    return snack(errText(r), { error: true });
  }
  applySettings(r.body);
  snack(t('saved'));
}
$('.stat.s4').onclick = () => saveSetting('/api/settings', { hotlink: !settings.hotlink }, $('#hotlink'));

// ---------- 数据 ----------
// 规范命名的 key 本身就是显示名；保持原名的去掉时间戳前缀
const nameOf = (o) => o.key.replace(/^\d{13}_/, '');
const kindOf = (o) => (/^image\//.test(o.contentType) ? 'image' : /^video\//.test(o.contentType) ? 'video' : 'other');

async function load() {
  all = [];
  selected.clear();
  syncSelection();
  $('#grid').replaceChildren();
  $('#empty').hidden = true;
  $('#more').replaceChildren(loader(true));
  $('#refresh').disabled = true;

  api('/api/stats').then((r) => {
    if (!r.ok) return;
    $('#statCount').textContent = r.body.count.toLocaleString();
    $('#statBytes').textContent = size(r.body.bytes);
    $('#statCount').title = r.body.partial ? t('partial') : '';
  });
  api('/api/settings').then((r) => r.ok && applySettings(r.body));

  thumbs = new Set();
  let cursor = '';
  do {
    const r = await api(`/api/list?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!r.ok) {
      $('#more').replaceChildren();
      $('#refresh').disabled = false;
      if (r.status === 401) return reauth();
      return snack(errText(r), { error: true });
    }
    all.push(...r.body.items);
    for (const k of r.body.thumbs ?? []) thumbs.add(k);
    for (const k of r.body.archived ?? []) archived.add(k);
    cursor = r.body.cursor;
  } while (cursor);
  all.sort((a, b) => timeOf(b) - timeOf(a));
  $('#refresh').disabled = false;
  render();
  syncThumbFill();
}

function render() {
  const q = query.toLowerCase();
  view = all.filter((o) => (filter === 'all' || kindOf(o) === filter) && (!q || nameOf(o).toLowerCase().includes(q) || o.name?.toLowerCase().includes(q)));
  shown = 0;
  $('#grid').replaceChildren();
  for (const b of $('#filters').children) b.classList.toggle('on', b.dataset.v === filter);
  $('#empty').hidden = view.length > 0;
  $('#emptyText').textContent = t(all.length ? 'noMatch' : 'empty');
  more();
}

function more() {
  const frag = document.createDocumentFragment();
  view.slice(shown, shown + PAGE).forEach((o, i) => frag.append(tile(o, i)));
  shown = Math.min(view.length, shown + PAGE);
  $('#grid').append(frag);
  $('#statShown').textContent = `${shown.toLocaleString()} / ${view.length.toLocaleString()}`;
  const box = $('#more');
  box.replaceChildren();
  if (shown < view.length) {
    const b = document.createElement('button');
    b.className = 'btn tonal lg state';
    b.textContent = t('loadMore');
    b.onclick = more;
    box.append(b);
  }
}

function tile(o, i) {
  const el = document.createElement('div');
  el.className = 'tile state';
  el.tabIndex = 0;
  el.dataset.key = o.key;
  el.style.animationDelay = `${Math.min(i, 24) * 18}ms`;
  el.classList.toggle('sel', selected.has(o.key));
  el.classList.toggle('exempt', exempt.has(o.key));
  el.innerHTML = '<div class="media"></div><button class="check" type="button"></button><span class="flag"></span><div class="cap"><b></b><span></span></div>';
  $('.flag', el).append(icon('link'));
  $('.flag', el).title = t('allowHotlink');
  const media = $('.media', el);
  if (kindOf(o) === 'image' && (thumbs.has(o.key) || o.size <= SMALL)) {
    media.append(tileImg(o));
  } else {
    media.append(icon(kindOf(o) === 'video' ? 'movie' : 'file'));
  }
  $('.check', el).append(icon('check'));
  $('.check', el).setAttribute('aria-label', t('selectAll'));
  $('.cap b', el).textContent = nameOf(o);
  if (o.name) el.title = o.name;
  $('.cap span', el).textContent = `${size(o.size)} · ${when(timeOf(o), 'short')}`;

  $('.check', el).onclick = (e) => {
    e.stopPropagation();
    toggle(o.key, el);
  };
  el.onclick = () => (selected.size ? toggle(o.key, el) : openDetail(o));
  el.onkeydown = (e) => {
    if (e.key === 'Enter') el.click();
    if (e.key === ' ') {
      e.preventDefault();
      toggle(o.key, el);
    }
  };
  return el;
}

// 方格里的图：有缩略图用缩略图，否则用（较小的）原图
function tileImg(o) {
  const img = new Image();
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = thumbs.has(o.key) ? thumbUrl(o.key) : o.url;
  img.onerror = () => img.replaceWith(icon('image'));
  return img;
}

// ---------- 补缩略图：给还没有缩略图的旧文件在浏览器里生成 ----------
let filling = false;
const missingThumbs = () => all.filter((o) => kindOf(o) === 'image' && !NO_THUMB.test(o.contentType) && !thumbs.has(o.key));
function syncThumbFill(done = 0, total = 0) {
  const b = $('#thumbFill');
  const n = missingThumbs().length;
  b.hidden = !filling && !n;
  b.disabled = filling;
  $('.lbl', b).textContent = filling ? t('thumbFilling', { done, total }) : t('thumbFill', { n });
}
$('#thumbFill').onclick = async () => {
  if (filling) return;
  const queue = missingThumbs();
  const total = queue.length;
  let done = 0;
  let failed = 0;
  filling = true;
  syncThumbFill(0, total);
  const worker = async () => {
    for (let o; (o = queue.shift()); ) {
      try {
        const res = await fetch(o.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const th = await makeThumb(await res.blob());
        if (!th) throw new Error('undecodable');
        await putThumb(o.key, th);
        thumbs.add(o.key);
        const el = [...document.querySelectorAll('.tile')].find((x) => x.dataset.key === o.key);
        if (el) $('.media', el).replaceChildren(tileImg(o));
      } catch (err) {
        failed++;
        console.warn('thumb failed', o.key, err);
      }
      syncThumbFill(++done, total);
    }
  };
  await Promise.all([worker(), worker()]);
  filling = false;
  syncThumbFill();
  snack(t('thumbFillDone', { n: done - failed, failed }), { error: failed > 0 });
};

// ---------- 选择 ----------
function toggle(key, el) {
  selected.has(key) ? selected.delete(key) : selected.add(key);
  el?.classList.toggle('sel', selected.has(key));
  syncSelection();
}
function syncSelection() {
  const n = selected.size;
  $('#ftb').classList.toggle('show', n > 0);
  $('main').classList.toggle('selecting', n > 0);
  $('#selCount').textContent = t('selectedN', { n });
}
$('#selClear').onclick = () => {
  selected.clear();
  for (const el of document.querySelectorAll('.tile.sel')) el.classList.remove('sel');
  syncSelection();
};
$('#selAll').onclick = () => {
  for (const o of view) selected.add(o.key);
  for (const el of document.querySelectorAll('.tile')) el.classList.add('sel');
  syncSelection();
};
$('#selCopy').onclick = (e) => {
  const urls = all.filter((o) => selected.has(o.key)).map((o) => linkOf(o.url));
  copyText(urls.join('\n'), null);
};
$('#selDelete').onclick = async () => {
  const keys = [...selected];
  const ok = await confirmBox({ title: t('confirmDelNTitle', { n: keys.length }), text: t('confirmDelN') });
  if (ok) remove(keys);
};
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selected.size && !document.querySelector('dialog[open]')) $('#selClear').click();
});

async function remove(keys) {
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await api('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: chunk }) });
    if (!r.ok) {
      if (r.status === 401) return reauth();
      return snack(errText(r), { error: true });
    }
  }
  const gone = new Set(keys);
  for (const el of document.querySelectorAll('.tile')) if (gone.has(el.dataset.key)) el.classList.add('out');
  for (const k of keys) selected.delete(k);
  all = all.filter((o) => !gone.has(o.key));
  syncSelection();
  snack(t('deletedN', { n: keys.length }));
  setTimeout(render, 250);
  api('/api/stats').then((r) => {
    if (!r.ok) return;
    $('#statCount').textContent = r.body.count.toLocaleString();
    $('#statBytes').textContent = size(r.body.bytes);
  });
}

// ---------- 详情 ----------
const dlg = $('#detail');
function openDetail(o) {
  current = o;
  const entry = { url: o.url, name: o.name || nameOf(o) };
  const pv = $('.preview', dlg);
  pv.replaceChildren();
  if (kindOf(o) === 'image') {
    const img = new Image();
    img.alt = entry.name;
    img.src = o.url;
    pv.append(img);
  } else if (kindOf(o) === 'video') {
    const v = document.createElement('video');
    v.src = o.url;
    v.controls = true;
    v.preload = 'metadata';
    pv.append(v);
  } else {
    pv.append(icon('file'));
  }
  $('.item-name', dlg).textContent = entry.name;
  $('[data-f=url]', dlg).textContent = linkOf(o.url);
  $('[data-f=type]', dlg).textContent = o.contentType || '—';
  $('[data-f=size]', dlg).textContent = `${size(o.size)} (${o.size.toLocaleString()} B)`;
  $('[data-f=uploaded]', dlg).textContent = when(timeOf(o));
  $('[data-f=store]', dlg).textContent = o.tg && o.hf ? 'Telegram + HuggingFace' : o.tg ? 'Telegram' : 'HuggingFace';
  $('[data-f=key]', dlg).textContent = o.key;
  $('[data-f=name]', dlg).textContent = o.name || '';
  for (const el of dlg.querySelectorAll('.orig')) el.hidden = !o.name;
  setToggle($('[data-exempt]', dlg), exempt.has(o.key));
  $('[data-open]', dlg).href = linkOf(o.url);
  for (const b of dlg.querySelectorAll('[data-copy]')) b.onclick = () => copyText(snippet(b.dataset.copy, entry), null);
  dlg.showModal();
}
$('.setting', dlg).onclick = () => saveSetting('/api/exempt', { keys: [current.key], on: !exempt.has(current.key) }, $('[data-exempt]', dlg));
$('.close', dlg).onclick = () => dlg.close();
dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
dlg.addEventListener('close', () => {
  const v = $('video', dlg);
  if (v) v.pause();
});
$('[data-del]', dlg).onclick = async () => {
  const o = current;
  const ok = await confirmBox({ title: t('confirmDelTitle'), text: t('confirmDel', { name: nameOf(o) }) });
  if (!ok) return;
  dlg.close();
  remove([o.key]);
};

// ---------- 搜索与筛选 ----------
let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    query = e.target.value.trim();
    render();
  }, 150);
});
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.v;
  render();
});

let reauthing = null;
function reauth() {
  if (reauthing) return;
  snack(t('sessionExpired'), { error: true });
  reauthing = gate('admin').then(() => {
    reauthing = null;
    load();
  });
}

// ---------- 启动 ----------
await gate('admin');
load();
