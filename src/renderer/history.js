const $ = (id) => document.getElementById(id);
const api = window.pitaya;

let entries = [];
let filter = 'all'; // all | video | audio
let query = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const isAudio = (f) => f && f !== 'mp4';

function badgeOf(r) {
  if (isAudio(r.format)) return r.format === 'opus' ? 'Opus' : r.format.toUpperCase();
  return r.quality && r.quality !== 'best' ? `${r.quality}p` : 'MP4';
}

function dayLabel(t) {
  const day = (x) => new Date(x).setHours(0, 0, 0, 0);
  const diff = Math.round((day(Date.now()) - day(t)) / 86400000);
  if (diff <= 0) return 'Bugün';
  if (diff === 1) return 'Dün';
  return new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
}

const timeOf = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

// Turkish-aware, accent-insensitive match ("istanbul" finds "İstanbul").
const norm = (s) => String(s || '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '');

function visible() {
  const q = norm(query.trim());
  return entries.filter((r) => {
    if (filter === 'audio' && !isAudio(r.format)) return false;
    if (filter === 'video' && isAudio(r.format)) return false;
    return !q || norm(r.title).includes(q) || norm(r.folderName).includes(q);
  });
}

function iconButton(label, title, onClick) {
  const b = el('button', 'icon-btn', label);
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function row(r) {
  const item = el('div', 'item' + (r.exists ? '' : ' missing'));
  item.title = r.exists ? (r.count > 1 ? 'Klasörü aç' : 'Aç') : '';

  const thumb = el('div', 'thumb');
  if (r.thumbnail) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => thumb.replaceChildren(badgeOf(r));
    img.src = r.thumbnail;
    thumb.append(img);
  } else {
    thumb.textContent = badgeOf(r);
  }

  const info = el('div', 'info');
  const title = el('div', 'title', r.count > 1 ? `${r.title} · ${r.count} video` : r.title);
  title.title = r.title;
  const meta = el('div', 'meta');
  meta.append(el('span', 'badge', badgeOf(r)), el('span', null, timeOf(r.at)), el('span', null, '·'));
  const where = el('span', 'ellipsis', r.folderName);
  where.title = r.folder;
  meta.append(where);
  if (!r.exists) meta.append(el('span', null, '·'), el('span', 'gone', 'Dosya bulunamadı'));
  info.append(title, meta);

  const actions = el('div', 'actions');
  if (r.exists) actions.append(iconButton('▶', r.count > 1 ? 'Klasörü aç' : 'Aç', () => api.send('history:open', r.id)));
  actions.append(iconButton('📂', 'Klasörde göster', () => api.send('history:reveal', r.id)));
  if (r.url) actions.append(iconButton('↻', 'Tekrar indir', () => api.send('history:redownload', r.id)));
  actions.append(iconButton('✕', 'Listeden kaldır (dosya silinmez)', () => api.send('history:remove', r.id)));

  item.append(thumb, info, actions);
  if (r.exists) item.addEventListener('click', () => api.send('history:open', r.id));
  return item;
}

function render() {
  const box = $('list');
  const keep = box.scrollTop;
  box.replaceChildren();
  $('clear').disabled = !entries.length;

  if (!entries.length) {
    const e = el('div', 'empty');
    e.append(el('div', 'empty-title', 'Henüz indirme yok'), el('div', null, 'İndirdiğin videolar ve müzikler burada listelenir.'));
    box.append(e);
    return;
  }
  const list = visible();
  if (!list.length) {
    const e = el('div', 'empty');
    e.append(el('div', 'empty-title', 'Sonuç yok'), el('div', null, 'Aramayı ya da filtreyi değiştir.'));
    box.append(e);
    return;
  }
  let lastDay = null;
  for (const r of list) {
    const d = dayLabel(r.at);
    if (d !== lastDay) {
      box.append(el('div', 'day', d));
      lastDay = d;
    }
    box.append(row(r));
  }
  box.scrollTop = keep;
}

async function load() {
  entries = await api.invoke('history:list');
  render();
}

$('search').addEventListener('input', (e) => {
  query = e.target.value;
  render();
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && query) {
    e.target.value = query = '';
    render();
  }
});
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    render();
  });
}
$('clear').addEventListener('click', () => api.invoke('history:clear'));
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('search').focus();
  }
});

api.on('history:changed', load);
load();
