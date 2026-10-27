const api = window.pitaya;
const app = document.getElementById('app');

let jobs = [];
let comp = { state: 'ready' };
let update = { status: 'idle' };
let hotkey = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtSpeed(b) {
  if (!b) return '';
  const mb = b / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB/sn` : `${Math.round(b / 1024)} KB/sn`;
}

function fmtEta(s) {
  if (s == null || !isFinite(s)) return '';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

// Buttons only carry data-action/data-id. One delegated pointerdown handler
// does the work, so clicks still land while the list re-renders mid-download.
function button(label, title, action, id) {
  const b = el('button', 'btn', label);
  b.title = title;
  b.dataset.action = action;
  if (id != null) b.dataset.id = id;
  return b;
}

app.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const t = e.target.closest('[data-action]');
  if (!t) return;
  e.preventDefault();
  api.send(`progress:${t.dataset.action}`, t.dataset.id != null ? Number(t.dataset.id) : undefined);
});

function card({ badge, name, progress, status, right, cls, buttons = [], action, id }) {
  const item = el('div', 'item ' + (cls || ''));
  if (action) {
    item.dataset.action = action;
    item.dataset.id = id;
  }
  const row = el('div', 'row');
  if (badge) row.append(el('span', 'badge', badge));
  const name_ = el('span', 'name ellipsis', name);
  name_.title = name;
  row.append(name_);
  buttons.forEach((b) => row.append(b));
  item.append(row);
  const bar = el('div', 'bar');
  const fill = el('div', 'fill');
  fill.style.width = `${Math.round((progress || 0) * 100)}%`;
  bar.append(fill);
  item.append(bar);
  const st = el('div', 'status');
  st.append(el('span', 'ellipsis', status || ''));
  if (right) st.append(el('span', 'right', right));
  item.append(st);
  return item;
}

function jobCard(j) {
  const badge = j.format === 'mp3' ? 'MP3' : j.quality && j.quality !== 'best' ? `${j.quality}p` : 'MP4';
  const base = { badge, name: j.title, progress: j.progress };
  const cancel = button('✕', 'İndirmeyi iptal et', 'cancel', j.id);
  switch (j.state) {
    case 'starting':
      return card({ ...base, cls: 'indeterminate', status: 'Başlıyor…', buttons: [cancel] });
    case 'downloading':
      return card({
        ...base,
        status: `%${Math.floor(j.progress * 100)}  ${fmtSpeed(j.speed)}`,
        right: fmtEta(j.eta),
        buttons: [cancel],
      });
    case 'processing':
      return card({
        ...base,
        cls: 'indeterminate',
        status: j.format === 'mp3' ? 'MP3’e dönüştürülüyor…' : 'Birleştiriliyor…',
        buttons: [cancel],
      });
    case 'done':
      return card({
        ...base,
        cls: 'done',
        progress: 1,
        status: j.format === 'mp3' ? 'Tamamlandı · dinlemek için tıkla' : 'Tamamlandı · izlemek için tıkla',
        buttons: [button('📂', 'Klasörde göster', 'open', j.id), button('✕', 'Listeden kaldır', 'dismiss', j.id)],
        action: 'play',
        id: j.id,
      });
    case 'canceled':
      return card({ ...base, cls: 'error', status: 'İptal edildi', buttons: [button('✕', 'Kapat', 'dismiss', j.id)] });
    default:
      return card({
        ...base,
        cls: 'error',
        progress: 1,
        status: j.error || 'Bilinmeyen hata',
        buttons: [button('↻', 'Tekrar dene', 'retry', j.id), button('✕', 'Kapat', 'dismiss', j.id)],
      });
  }
}

function render() {
  app.replaceChildren();
  const head = el('div', 'head');
  const logo = el('img');
  logo.src = '../../assets/logo-128.png';
  head.append(logo, el('span', null, 'Pitaya'));
  const active = jobs.filter((j) => ['starting', 'downloading', 'processing'].includes(j.state)).length;
  head.append(el('span', 'count', active ? `${active} indirme sürüyor` : ''));
  head.append(button('⚙', 'Ayarlar', 'settings'));
  head.append(button('—', 'Gizle (indirmeler arka planda sürer)', 'hide'));
  app.append(head);

  const nothing = !jobs.length && comp.state !== 'installing' && comp.state !== 'error' && !['downloading', 'ready'].includes(update.status);
  if (nothing) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'empty-title', 'Henüz indirme yok'));
    const hint = el('div', 'muted');
    hint.append('Bir video linki kopyala, sonra ');
    (hotkey || 'Ctrl+Alt+P').split('+').forEach((k, i) => {
      if (i) hint.append('+');
      hint.append(el('kbd', null, k === 'Super' ? 'Win' : k));
    });
    hint.append(' tuşlarına bas.');
    empty.append(hint);
    app.append(empty);
  }

  if (comp.state === 'installing') {
    app.append(
      card({
        name: `${comp.label} indiriliyor`,
        progress: comp.progress || 0,
        cls: comp.progress == null ? 'indeterminate' : '',
        status: 'İlk kurulum — sadece bir kez',
        right: comp.progress != null ? `%${Math.floor(comp.progress * 100)}` : '',
      })
    );
  } else if (comp.state === 'error') {
    app.append(
      card({
        name: 'Bileşenler indirilemedi',
        cls: 'error',
        progress: 1,
        status: `İnternet bağlantını kontrol et. (${comp.error || ''})`,
        buttons: [button('↻', 'Tekrar dene', 'retry', 0)],
      })
    );
  }
  if (update.status === 'downloading') {
    app.append(card({ name: `Pitaya ${update.version} güncellemesi`, progress: update.progress || 0, status: 'İndiriliyor…' }));
  } else if (update.status === 'ready') {
    app.append(card({ name: `Pitaya ${update.version} hazır`, progress: 1, cls: 'done', status: 'İndirmeler bitince yeniden başlatılacak' }));
  }

  [...jobs].reverse().slice(0, 6).forEach((j) => app.append(jobCard(j)));
  requestAnimationFrame(() => api.send('progress:resize', app.offsetHeight + 2));
}

api.on('progress:jobs', (j) => {
  jobs = j;
  render();
});
api.on('progress:components', (c) => {
  comp = c;
  render();
});
api.on('progress:update', (u) => {
  update = u;
  render();
});

api.on('progress:meta', (m) => {
  hotkey = m.hotkey || hotkey;
  render();
});

api.invoke('progress:state').then((s) => {
  jobs = s.jobs;
  comp = s.components;
  update = s.update;
  hotkey = s.hotkey || '';
  render();
});
