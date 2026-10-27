const $ = (id) => document.getElementById(id);
const api = window.pitaya;

let data = null; // payload from main
let info = null; // { qualities, title, ... } once known
let infoError = null;
let step = 'format';
let choice = {};
let sel = 0;
let options = [];
let msgTimer = null;

const FALLBACK_QUALITIES = [2160, 1440, 1080, 720, 480, 360].map((v) => ({ value: v, label: `${v}p` }));

function fmtBytes(b) {
  if (!b) return '';
  const mb = b / 1048576;
  return mb >= 1024 ? `~${(mb / 1024).toFixed(1)} GB` : `~${Math.max(1, Math.round(mb))} MB`;
}

function fmtDuration(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function reportSize() {
  requestAnimationFrame(() => api.send('popup:resize', $('app').offsetHeight + 2));
}

// ---------- building option lists ----------

function buildOptions() {
  if (step === 'format') {
    return [
      { key: 'mp3', main: 'MP3', sub: 'Sadece ses' },
      { key: 'mp4', main: 'MP4', sub: 'Video' },
    ];
  }
  if (step === 'quality') {
    const list = info && !info.isPlaylist && info.qualities.length ? info.qualities : null;
    const top = list ? list[0] : null;
    const opts = [{ key: 'best', main: 'En iyi', sub: top ? top.label : 'Mevcut en yüksek kalite', side: top ? fmtBytes(top.bytes) : '' }];
    if (list) {
      for (const q of list.slice(0, 8)) opts.push({ key: q.value, main: q.label, side: fmtBytes(q.bytes) });
    } else if (infoError || (info && (info.isPlaylist || !info.qualities.length))) {
      for (const q of FALLBACK_QUALITIES) opts.push({ key: q.value, main: q.label });
    }
    return opts;
  }
  // folder
  const opts = data.folders.map((f, i) => ({ key: i, main: f.name, sub: f.path }));
  opts.push({ key: 'custom', main: 'Başka klasör…', sub: 'Bir kez seç, listeye eklensin' });
  return opts;
}

function defaultSel() {
  const keys = options.map((o) => o.key);
  let want;
  if (step === 'format') want = choice.format || data.lastFormat;
  else if (step === 'quality') want = choice.quality ?? data.lastQuality;
  else want = data.lastFolder;

  let i = keys.indexOf(want);
  if (i < 0 && step === 'quality' && typeof want === 'number') {
    // Closest available quality that is not higher than the last one.
    const lower = options.filter((o) => typeof o.key === 'number' && o.key <= want);
    i = lower.length ? keys.indexOf(lower[0].key) : 0;
  }
  return Math.max(0, i);
}

// ---------- rendering ----------

// Short, readable form of the link: host + path, no query noise.
function shortLink(u) {
  try {
    const x = new URL(u);
    const v = x.searchParams.get('v');
    return x.hostname.replace(/^www\./, '') + x.pathname + (v ? `?v=${v}` : '');
  } catch {
    return u;
  }
}

function renderMeta() {
  const loading = !info && !infoError;
  const sub = $('subtitle');
  sub.classList.toggle('error', !!infoError && !info);

  if (info) {
    $('title').textContent = info.title || shortLink(data.url);
    const bits = [];
    if (info.isPlaylist) bits.push(`Oynatma listesi${info.count ? ` · ${info.count} video` : ''}`);
    if (info.uploader) bits.push(info.uploader);
    if (info.duration) bits.push(fmtDuration(info.duration));
    sub.textContent = bits.join(' · ');
  } else if (infoError) {
    $('title').textContent = shortLink(data.url);
    sub.textContent = `Video bilgisi alınamadı: ${infoError}`;
  } else {
    $('title').textContent = 'Video bilgileri alınıyor…';
    sub.textContent = '';
  }
  $('link').textContent = shortLink(data.url);
  $('link').title = data.url;

  const img = $('thumb');
  const src = info && info.thumbnail;
  if (src && img.dataset.src !== src) {
    img.dataset.src = src;
    img.hidden = true;
    img.onload = () => {
      img.hidden = false;
      $('thumbSpin').hidden = true;
    };
    img.onerror = () => {
      img.hidden = true;
      $('thumbSpin').hidden = true;
    };
    img.src = src;
  } else if (!src) {
    img.hidden = true;
    img.removeAttribute('src');
    delete img.dataset.src;
    $('thumbSpin').hidden = !loading;
  }
  // No preview to show (site gave none): drop the empty box.
  img.parentElement.hidden = !loading && !src;
  renderDup();
  reportSize();
}

function ago(t) {
  const day = (x) => new Date(x).setHours(0, 0, 0, 0);
  const days = Math.round((day(Date.now()) - day(t)) / 86400000);
  if (days <= 0) return 'bugün';
  if (days === 1) return 'dün';
  if (days < 30) return `${days} gün önce`;
  return new Date(t).toLocaleDateString('tr-TR');
}

function renderDup() {
  const d = data.dup;
  const box = $('dup');
  box.hidden = !d;
  if (!d) return;
  if (d.active) {
    box.textContent = 'Bu video şu an indiriliyor.';
  } else {
    const fmt = d.format === 'mp3' ? 'MP3' : d.quality && d.quality !== 'best' ? `${d.quality}p MP4` : 'MP4';
    const what = d.count > 1 ? `Bu liste ${d.count} video olarak` : 'Daha önce';
    box.textContent = `${what} indirildi · ${fmt} · ${ago(d.at)} · ${d.folder}`;
  }
  box.title = box.textContent;
}

function render() {
  renderMeta();

  const order = ['format', 'quality', 'folder'];
  for (const s of document.querySelectorAll('#steps span')) {
    const k = s.dataset.step;
    s.hidden = k === 'quality' && choice.format === 'mp3';
    s.classList.toggle('active', k === step);
    s.classList.toggle('done', order.indexOf(k) < order.indexOf(step));
  }

  const box = $('options');
  box.replaceChildren();
  options.forEach((o, i) => {
    const b = el('button', 'opt' + (i === sel ? ' sel' : ''));
    b.setAttribute('role', 'option');
    b.append(el('span', 'key', i < 9 ? String(i + 1) : ''));
    const body = el('span', 'body');
    body.append(el('div', 'main', o.main));
    if (o.sub) body.append(el('div', 'sub', o.sub));
    b.append(body);
    if (o.side) b.append(el('span', 'side', o.side));
    b.addEventListener('mouseenter', () => {
      sel = i;
      highlight();
    });
    b.addEventListener('click', () => pick(i));
    box.append(b);
  });

  let note = '';
  if (step === 'quality') {
    if (!info && !infoError) {
      const row = el('div', 'loading');
      row.append(el('div', 'spinner'), el('span', null, 'Kaliteler alınıyor…'));
      box.append(row);
    } else if (infoError) {
      note = 'Kalite listesi alınamadı; seçtiğine en yakın kalite indirilecek.';
    } else if (info && info.isPlaylist) {
      note = 'Listedeki tüm videolar seçtiğin kalitede indirilecek.';
    }
  }
  $('note').textContent = note;
  reportSize();
}

function highlight() {
  [...$('options').children].forEach((c, i) => c.classList.toggle('sel', i === sel));
}

function go(next) {
  step = next;
  options = buildOptions();
  sel = defaultSel();
  render();
}

async function pick(i) {
  const o = options[i];
  if (!o) return;
  if (step === 'format') {
    choice.format = o.key;
    return go(o.key === 'mp4' ? 'quality' : 'folder');
  }
  if (step === 'quality') {
    choice.quality = o.key;
    return go('folder');
  }
  if (o.key === 'custom') {
    const dir = await api.invoke('popup:pickFolder');
    if (!dir) return;
    return finish({ customFolder: dir });
  }
  finish({ folderIndex: o.key });
}

function finish(extra) {
  api.send('popup:choose', {
    url: data.url,
    format: choice.format,
    quality: choice.format === 'mp4' ? choice.quality ?? 'best' : null,
    ...extra,
  });
}

function back() {
  if (step === 'folder') go(choice.format === 'mp4' ? 'quality' : 'format');
  else if (step === 'quality') go('format');
}

// ---------- events ----------

document.addEventListener('keydown', (e) => {
  if (!data) return;
  if (e.key === 'Escape') return api.send('popup:cancel');
  if (data.mode !== 'choose') return;
  if (/^[1-9]$/.test(e.key)) {
    const i = Number(e.key) - 1;
    if (i < options.length) {
      sel = i;
      highlight();
      pick(i);
    }
  } else if (e.key === 'ArrowDown' || e.key === 'Tab') {
    e.preventDefault();
    sel = (sel + 1) % options.length;
    highlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    sel = (sel - 1 + options.length) % options.length;
    highlight();
  } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
    e.preventDefault();
    pick(sel);
  } else if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
    e.preventDefault();
    back();
  }
});

api.on('popup:show', (payload) => {
  clearTimeout(msgTimer);
  data = payload;
  const isMsg = payload.mode === 'message';
  document.body.classList.toggle('msg', isMsg);
  $('choose').hidden = isMsg;
  $('message').hidden = !isMsg;
  $('host').textContent = payload.host || '';

  if (isMsg) {
    $('msgIcon').textContent = payload.icon === 'wait' ? '⏳' : '🔗';
    $('msgText').textContent = payload.text;
    $('msgSub').textContent = payload.sub || '';
    reportSize();
    msgTimer = setTimeout(() => api.send('popup:cancel'), 2600);
    return;
  }
  info = payload.info || null;
  infoError = payload.infoError || null;
  choice = {};
  go('format');
});

api.on('popup:info', ({ url, info: i, error, dup }) => {
  if (!data || data.url !== url) return;
  info = i || null;
  infoError = error || null;
  if (dup !== undefined) data.dup = dup;
  if (step === 'quality') {
    const key = options[sel] && options[sel].key;
    options = buildOptions();
    const idx = options.findIndex((o) => o.key === key);
    sel = idx >= 0 ? idx : defaultSel();
    render();
  } else {
    renderMeta();
  }
});
