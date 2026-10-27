const $ = (id) => document.getElementById(id);
const api = window.pitaya;

let cfg = null;
let recording = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- hotkey ----------

const KEY_NAMES = {
  Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};

function keyFromEvent(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^Numpad[0-9]$/.test(c)) return 'num' + c.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
  return KEY_NAMES[c] || null;
}

function showKeys(accel) {
  const box = $('hotkey');
  box.replaceChildren();
  if (!accel) {
    box.append(el('span', 'muted', 'Yok'));
    return;
  }
  accel.split('+').forEach((k, i) => {
    if (i) box.append(el('span', 'plus', '+'));
    box.append(el('kbd', null, k === 'Super' ? 'Win' : k));
  });
}

function setHint(text, error) {
  const h = $('hotkeyHint');
  h.textContent = text || '';
  h.classList.toggle('error', !!error);
}

function startRecording() {
  recording = true;
  api.send('settings:suspendHotkey', true);
  $('hotkey').replaceChildren(el('span', 'rec', 'Yeni kısayola bas…'));
  $('hotkeyBtn').textContent = 'Vazgeç';
  setHint('En az bir değiştirici tuş kullan: Ctrl, Alt, Shift veya Win. Vazgeçmek için Esc.');
}

function stopRecording() {
  recording = false;
  api.send('settings:suspendHotkey', false);
  $('hotkeyBtn').textContent = 'Değiştir';
  showKeys(cfg.hotkey);
}

document.addEventListener('keydown', async (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === 'Escape') {
    stopRecording();
    setHint('');
    return;
  }
  const key = keyFromEvent(e);
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!key) return; // only modifiers so far
  if (!mods.length && !/^F\d+$/.test(key)) {
    setHint('Tek tuş olmaz; Ctrl, Alt, Shift veya Win ile birlikte bas.', true);
    return;
  }
  const accel = [...mods, key].join('+');
  recording = false;
  const r = await api.invoke('settings:setHotkey', accel);
  if (r.ok) {
    cfg.hotkey = accel;
    setHint('Kaydedildi.');
  } else {
    setHint(r.error, true);
  }
  $('hotkeyBtn').textContent = 'Değiştir';
  showKeys(cfg.hotkey);
});

$('hotkeyBtn').addEventListener('click', () => (recording ? stopRecording() : startRecording()));

// ---------- folders ----------

async function saveFolders() {
  cfg = await api.invoke('settings:save', { folders: cfg.folders });
}

function renderFolders() {
  const box = $('folders');
  box.replaceChildren();
  if (!cfg.folders.length) box.append(el('div', 'empty', 'Henüz klasör yok. En az bir tane ekle.'));
  cfg.folders.forEach((f, i) => {
    const row = el('div', 'folder');
    row.append(el('span', 'num', i < 9 ? String(i + 1) : ''));
    const info = el('div', 'info');
    const name = el('input');
    name.value = f.name;
    name.spellcheck = false;
    name.title = 'Adı değiştirmek için tıkla';
    name.addEventListener('change', () => {
      f.name = name.value.trim() || f.path;
      saveFolders();
    });
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    info.append(name, el('div', 'path ellipsis', f.path));
    info.querySelector('.path').title = f.path;
    row.append(info);

    const up = el('button', 'icon-btn', '↑');
    up.title = 'Yukarı taşı';
    up.disabled = i === 0;
    up.onclick = () => {
      [cfg.folders[i - 1], cfg.folders[i]] = [cfg.folders[i], cfg.folders[i - 1]];
      saveFolders().then(renderFolders);
    };
    const down = el('button', 'icon-btn', '↓');
    down.title = 'Aşağı taşı';
    down.disabled = i === cfg.folders.length - 1;
    down.onclick = () => {
      [cfg.folders[i + 1], cfg.folders[i]] = [cfg.folders[i], cfg.folders[i + 1]];
      saveFolders().then(renderFolders);
    };
    const del = el('button', 'icon-btn', '✕');
    del.title = 'Kaldır';
    del.onclick = () => {
      cfg.folders.splice(i, 1);
      saveFolders().then(renderFolders);
    };
    row.append(up, down, del);
    box.append(row);
  });
}

$('addFolder').addEventListener('click', async () => {
  const dir = await api.invoke('settings:pickFolder');
  if (!dir || cfg.folders.some((f) => f.path === dir)) return;
  const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
  cfg.folders.push({ name, path: dir });
  await saveFolders();
  renderFolders();
});

// ---------- toggles ----------

for (const id of ['openAtLogin', 'autoUpdate', 'doubleCopy', 'notify']) {
  $(id).addEventListener('change', async (e) => {
    cfg = await api.invoke('settings:save', { [id]: e.target.checked });
  });
}

$('cookiesBrowser').addEventListener('change', async (e) => {
  cfg = await api.invoke('settings:save', { cookiesBrowser: e.target.value });
});

// ---------- components & versions ----------

function renderComponents(s) {
  const box = $('compStatus');
  box.replaceChildren();
  box.classList.toggle('error', s.state === 'error');
  if (s.state === 'installing') {
    const pct = s.progress != null ? ` %${Math.floor(s.progress * 100)}` : '';
    box.append(el('div', 'spinner'), el('span', null, `${s.label} indiriliyor…${pct}`));
  } else if (s.state === 'error') {
    box.textContent = `İndirme başarısız: ${s.error}. İnternet bağlantını kontrol edip "Eksikleri indir"e bas.`;
  } else if (s.state === 'ready' && lastCompState === 'installing') {
    loadVersions();
  }
  lastCompState = s.state;
}
let lastCompState = null;

async function loadVersions(promise) {
  const v = await (promise || api.invoke('settings:versions'));
  for (const k of ['ytdlp', 'ffmpeg', 'deno']) $(`v-${k}`).textContent = v[k] || 'yok';
}

$('updYtdlp').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Güncelleniyor…';
  await loadVersions(api.invoke('settings:updateYtdlp'));
  e.target.disabled = false;
  e.target.textContent = "yt-dlp'yi güncelle";
});
$('repair').addEventListener('click', () => api.send('settings:repairComponents'));

// ---------- app update ----------

const UPDATE_TEXT = {
  idle: '',
  checking: 'Denetleniyor…',
  latest: 'En güncel sürüm',
  downloading: 'Yeni sürüm indiriliyor…',
  ready: 'Güncelleme hazır, birazdan yeniden başlayacak',
};

function renderUpdate(u) {
  let t = UPDATE_TEXT[u.status] ?? '';
  if (u.status === 'downloading' && u.progress != null) t = `${u.version} indiriliyor… %${Math.floor(u.progress * 100)}`;
  if (u.status === 'ready') t = `${u.version} hazır, birazdan yeniden başlayacak`;
  if (u.status === 'error') t = `Denetlenemedi: ${u.error}`;
  if (u.status === 'disabled') t = u.error;
  $('updStatus').textContent = t ? `· ${t}` : '';
}

$('checkUpd').addEventListener('click', async (e) => {
  e.target.disabled = true;
  renderUpdate(await api.invoke('settings:checkUpdate'));
  e.target.disabled = false;
});

function showHistoryCount(n) {
  $('historyCount').textContent = n ? `${n} indirme kayıtlı` : 'Henüz kayıt yok';
}
$('openHistory').addEventListener('click', () => api.send('settings:openHistory'));
api.on('settings:historyCount', showHistoryCount);

$('openData').addEventListener('click', () => api.send('settings:openData'));
$('openLog').addEventListener('click', () => api.send('settings:openLog'));

api.on('settings:components', renderComponents);
api.on('settings:update', renderUpdate);

// ---------- init ----------

(async () => {
  const s = await api.invoke('settings:get');
  cfg = s.config;
  showKeys(cfg.hotkey);
  if (!s.hotkeyActive) setHint('Bu kısayol şu an çalışmıyor; başka bir uygulama kullanıyor olabilir. Değiştir.', true);
  renderFolders();
  showHistoryCount(s.historyCount);
  $('openAtLogin').checked = !!cfg.openAtLogin;
  $('autoUpdate').checked = !!cfg.autoUpdate;
  $('notify').checked = !!cfg.notify;
  $('doubleCopy').checked = !!cfg.doubleCopy && s.doubleCopyAvailable;
  if (!s.doubleCopyAvailable) {
    $('doubleCopy').disabled = true;
    $('doubleCopyHint').textContent = 'Bu bilgisayarda kullanılamıyor (ayrıntı günlük dosyasında).';
  }
  $('cookiesBrowser').value = cfg.cookiesBrowser || '';
  $('version').textContent = `Pitaya ${s.version}`;
  renderComponents(s.components);
  renderUpdate(s.update);
  loadVersions();
})();
