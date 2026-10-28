const $ = (id) => document.getElementById(id);
const api = window.pitaya;

let data = null; // payload from main
let mode = 'copy'; // 'copy' | 'move'
let rows = []; // everything selectable, in arrow-key order
let sel = 0;
let form = null; // { action, ... } while a name is being typed
let msgTimer = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function reportSize() {
  requestAnimationFrame(() => api.send('files:resize', $('app').offsetHeight + 2));
}

function fmtBytes(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  const mb = b / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

const IMG = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i;
const VID = /\.(mp4|mkv|webm|mov|avi|wmv|m4v)$/i;
const AUD = /\.(mp3|m4a|aac|opus|ogg|flac|wav|wma)$/i;
const DOC = /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|rtf|odt)$/i;
const ZIP = /\.(zip|rar|7z|tar|gz)$/i;

function kindIcon(items) {
  if (items.every((i) => i.dir)) return '📁';
  if (items.some((i) => i.dir)) return '🗂️';
  const files = items.filter((i) => !i.dir);
  const all = (re) => files.every((f) => re.test(f.name));
  if (all(IMG)) return '🖼️';
  if (all(VID)) return '🎬';
  if (all(AUD)) return '🎵';
  if (all(DOC)) return '📄';
  if (all(ZIP)) return '🗜️';
  return files.length > 1 ? '🗂️' : '📄';
}

function sumTitle(s) {
  const parts = [];
  if (s.files) parts.push(`${s.files} dosya`);
  if (s.folders) parts.push(`${s.folders} klasör`);
  const size = fmtBytes(s.bytes);
  return parts.join(', ') + (size ? ` · ${size}` : '');
}

function sumNames(items) {
  const names = items.slice(0, 3).map((i) => i.name);
  const rest = items.length - names.length;
  return names.join(', ') + (rest > 0 ? ` +${rest} daha` : '');
}

// ---------------- rows ----------------

function buildRows() {
  const s = data.summary;
  const list = [];
  data.targets.slice(0, 9).forEach((t, i) => {
    list.push({ group: 'targets', key: String(i + 1), main: t.name, sub: t.path, tag: t.kind, run: () => transfer(t.path) });
  });
  list.push({
    group: 'targets',
    key: 'S',
    cls: 'pick',
    main: 'Klasör seç…',
    sub: mode === 'move' ? 'Nereye taşınacağını seç' : 'Nereye kopyalanacağını seç',
    run: pickFolder,
  });
  const one = s.items.length === 1;
  list.push({ group: 'actions', key: 'Y', main: 'Yeni klasöre topla', run: () => openForm('gather') });
  if (s.files) list.push({ group: 'actions', key: 'A', main: 'Türe göre ayır', run: () => send({ action: 'sort' }) });
  list.push({ group: 'actions', key: 'Z', main: 'ZIP yap', run: () => openForm('zip') });
  list.push({ group: 'actions', key: 'R', main: 'Yeniden adlandır', run: () => openForm('rename') });
  list.push({ group: 'actions', key: 'P', main: one ? 'Yolu kopyala' : 'Yolları kopyala', run: () => send({ action: 'paths' }) });
  return list;
}

const TAGS = { recent: 'son', usb: 'USB' };

function renderMain() {
  $('targetsLabel').textContent = mode === 'move' ? 'Nereye taşınsın?' : 'Nereye kopyalansın?';
  for (const b of $('mode').children) b.classList.toggle('on', b.dataset.mode === mode);
  const keep = rows[sel] && rows[sel].key;
  rows = buildRows();
  const idx = rows.findIndex((r) => r.key === keep);
  sel = idx >= 0 ? idx : 0;

  $('targets').replaceChildren();
  $('actions').replaceChildren();
  rows.forEach((r, i) => {
    const b = el('button', `opt${r.cls ? ' ' + r.cls : ''}${i === sel ? ' sel' : ''}`);
    b.append(el('span', 'key', r.key));
    const body = el('span', 'body');
    body.append(el('div', 'main', r.main));
    if (r.sub) {
      const sub = el('div', 'sub', r.sub);
      sub.title = r.sub;
      body.append(sub);
    }
    b.append(body);
    if (TAGS[r.tag]) b.append(el('span', `tag ${r.tag}`, TAGS[r.tag]));
    b.addEventListener('mouseenter', () => {
      sel = i;
      highlight();
    });
    b.addEventListener('click', () => r.run());
    $(r.group).append(b);
  });
  reportSize();
}

function highlight() {
  document.querySelectorAll('#main .opt').forEach((b, i) => b.classList.toggle('sel', i === sel));
}

function setMode(m) {
  mode = m;
  renderMain();
}

// ---------------- actions ----------------

function send(req) {
  api.send('files:run', { ...req, mode });
}

function transfer(target) {
  send({ action: 'transfer', target });
}

let picking = false;
async function pickFolder() {
  if (picking) return;
  picking = true;
  try {
    const dir = await api.invoke('files:pickFolder', { mode });
    if (dir) transfer(dir);
  } finally {
    picking = false;
  }
}

// ---------------- name forms ----------------

function stem(name) {
  return name.replace(/\.[^.]+$/, '');
}

function parentName() {
  const p = data.summary.parent || '';
  return p.split(/[\\/]/).filter(Boolean).pop() || '';
}

function cleanName(s) {
  return String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim();
}

function openForm(action) {
  const items = data.summary.items;
  form = { action };
  const name = $('formName');
  $('startWrap').hidden = action !== 'rename';
  if (action === 'gather') {
    $('formTitle').textContent = 'Yeni klasörün adı';
    name.value = 'Yeni klasör';
  } else if (action === 'zip') {
    $('formTitle').textContent = 'ZIP dosyasının adı';
    name.value = items.length === 1 ? stem(items[0].name) : parentName() || 'Arşiv';
  } else {
    $('formTitle').textContent = 'Yeni ad (sonuna sıra numarası eklenir)';
    name.value = parentName() || stem(items[0].name);
    $('formStart').value = '1';
  }
  document.body.classList.add('form');
  $('main').hidden = true;
  $('form').hidden = false;
  updatePreview();
  name.focus();
  name.select();
}

function closeForm() {
  form = null;
  document.body.classList.remove('form');
  $('form').hidden = true;
  $('main').hidden = false;
  renderMain();
}

function previewNames(base, start) {
  const items = data.summary.items;
  const width = Math.max(2, String(start + items.length - 1).length);
  return items.map((it, i) => {
    const ext = it.dir ? '' : (it.name.match(/\.[^.]+$/) || [''])[0];
    return `${base || '…'}_${String(start + i).padStart(width, '0')}${ext}`;
  });
}

function startNumber() {
  const n = parseInt($('formStart').value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function updatePreview() {
  if (!form) return;
  const box = $('formPreview');
  const raw = $('formName').value;
  const name = cleanName(raw);
  box.classList.toggle('error', !name);
  if (!name) {
    box.textContent = 'Bir ad yaz.';
  } else if (name !== raw.trim()) {
    box.textContent = `Windows bazı karakterlere izin vermiyor: “${name}” olarak kaydedilecek.`;
  } else if (form.action === 'rename') {
    const list = previewNames(name, startNumber());
    box.textContent = list.slice(0, 3).join(', ') + (list.length > 3 ? ' …' : '');
  } else if (form.action === 'zip') {
    box.textContent = `${name}${/\.zip$/i.test(name) ? '' : '.zip'} · dosyaların yanına kaydedilir`;
  } else {
    box.textContent = `${data.summary.items.length} öğe bu klasöre taşınır`;
  }
  reportSize();
}

function submitForm() {
  const name = cleanName($('formName').value);
  if (!name) return updatePreview();
  if (form.action === 'rename') send({ action: 'rename', name, start: startNumber() });
  else send({ action: form.action, name });
}

$('formName').addEventListener('input', updatePreview);
$('formStart').addEventListener('input', updatePreview);
$('formOk').addEventListener('click', submitForm);
$('formBack').addEventListener('click', closeForm);
for (const b of $('mode').children) b.addEventListener('click', () => setMode(b.dataset.mode));

// ---------------- keys ----------------

document.addEventListener('keydown', (e) => {
  if (!data || data.mode === 'message') {
    if (e.key === 'Escape') api.send('files:cancel');
    return;
  }
  if (form) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeForm();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submitForm();
    }
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  if (k === 'Escape') return api.send('files:cancel');
  if (k === 'Tab') {
    e.preventDefault();
    return setMode(mode === 'copy' ? 'move' : 'copy');
  }
  if (k === 'ArrowDown' || k === 'ArrowRight') {
    e.preventDefault();
    sel = (sel + 1) % rows.length;
    return highlight();
  }
  if (k === 'ArrowUp' || k === 'ArrowLeft') {
    e.preventDefault();
    sel = (sel - 1 + rows.length) % rows.length;
    return highlight();
  }
  if (k === 'Enter') {
    e.preventDefault();
    return rows[sel] && rows[sel].run();
  }
  const hit = rows.findIndex((r) => r.key.toLowerCase() === k.toLocaleLowerCase('tr'));
  if (hit >= 0) {
    e.preventDefault();
    sel = hit;
    highlight();
    rows[hit].run();
  }
});

// ---------------- show ----------------

api.on('files:show', (payload) => {
  clearTimeout(msgTimer);
  data = payload;
  form = null;
  const isMsg = payload.mode === 'message';
  document.body.classList.toggle('msg', isMsg);
  document.body.classList.remove('form');
  $('message').hidden = !isMsg;
  $('form').hidden = true;
  $('main').hidden = isMsg;
  document.querySelector('.files-meta').hidden = isMsg;
  $('mode').hidden = isMsg;
  if (isMsg) {
    $('msgText').textContent = payload.text;
    $('msgSub').textContent = payload.sub || '';
    reportSize();
    msgTimer = setTimeout(() => api.send('files:cancel'), 2600);
    return;
  }
  mode = payload.cut ? 'move' : 'copy';
  const s = payload.summary;
  $('kindIcon').textContent = kindIcon(s.items);
  $('sumTitle').textContent = sumTitle(s);
  $('sumNames').textContent = sumNames(s.items);
  $('sumNames').title = s.items.map((i) => i.name).join('\n');
  rows = [];
  sel = 0;
  renderMain();
  // Ctrl+X, Ctrl+X with nowhere remembered yet: go straight to choosing a folder.
  if (payload.autoPick) setTimeout(pickFolder, 60);
});
