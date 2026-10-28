// The file panel: copy files (Ctrl+C, Ctrl+C) or cut them (Ctrl+X, Ctrl+X)
// in Explorer and pick where they go, or gather / sort / zip / rename them.
// A small toast at the bottom right shows progress, and offers undo.
const fs = require('fs');
const path = require('path');
const { app, ipcMain, dialog, shell, clipboard, screen } = require('electron');
const config = require('./config');
const log = require('./log');
const winfiles = require('./winfiles');
const fileops = require('./fileops');

const PANEL_W = 440;
const TOAST_W = 360;
const RECENT_MAX = 5;

module.exports = function setupFilePanel({ makeWindow, present, belowToast, onUndoChange }) {
  let win = null;
  let toastWin = null;
  let dialogOpen = false;
  let current = null; // what the panel is showing: { paths, files, folders, parent }
  let running = false;
  let last = null; // last undoable action: { undo, sub }
  let toastOpen = null; // what "Klasörü aç" does
  let toastTimer = null;
  let toastHeight = 0;

  const send = (w, ch, data) => w && !w.isDestroyed() && w.webContents.send(ch, data);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  // ---------------- windows ----------------

  function create() {
    win = makeWindow('files.html', {
      width: PANEL_W,
      height: 360,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    // Same as the download popup: clicking elsewhere closes it, except for
    // the early blur Windows sometimes causes right after it opens.
    win.on('blur', () => {
      if (dialogOpen || !win.isVisible()) return;
      if (Date.now() - (win.__shownAt || 0) < 600) {
        setTimeout(() => win.isVisible() && win.focus(), 30);
        return;
      }
      hide();
    });
    win.on('show', () => {
      win.__shownAt = Date.now();
      clearTimeout(win.__idle);
      win.__idle = setTimeout(hide, 120000);
    });

    toastWin = makeWindow('toast.html', {
      width: TOAST_W,
      height: 80,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
    });
    toastWin.setAlwaysOnTop(true, 'pop-up-menu');
  }

  function hide() {
    if (win && win.isVisible()) win.hide();
  }

  // ---------------- targets ----------------

  function isDir(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  const KNOWN = [
    ['desktop', 'Masaüstü'],
    ['documents', 'Belgeler'],
    ['downloads', 'İndirilenler'],
    ['pictures', 'Resimler'],
    ['videos', 'Videolar'],
    ['music', 'Müzik'],
  ];

  // A folder's friendly name: the user's own name for it, a known Windows
  // folder, or just its last part.
  function label(p) {
    const cfg = config.get();
    const fav = [...cfg.fileFavorites, ...cfg.folders].find((f) => same(f.path, p));
    if (fav) return fav.name;
    for (const [key, name] of KNOWN) {
      try {
        if (same(app.getPath(key), p)) return name;
      } catch {}
    }
    return path.basename(p) || p;
  }

  function targets(parent) {
    const cfg = config.get();
    const out = [];
    const seen = new Set();
    const add = (kind, p, name) => {
      if (!p) return;
      const key = path.resolve(p).toLowerCase();
      if (seen.has(key) || (parent && same(p, parent)) || !isDir(p)) return;
      seen.add(key);
      out.push({ kind, path: p, name: name || label(p) });
    };
    for (const p of cfg.fileRecent) add('recent', p);
    for (const f of cfg.fileFavorites) add('fav', f.path, f.name);
    for (const d of winfiles.removableDrives()) {
      const letter = d.root.slice(0, 2);
      add('usb', d.root, d.label ? `${d.label} (${letter})` : `USB bellek (${letter})`);
    }
    return out;
  }

  function remember(dest) {
    const list = config.get().fileRecent.filter((p) => !same(p, dest));
    config.update({ fileRecent: [dest, ...list].slice(0, RECENT_MAX) });
  }

  // ---------------- show ----------------

  async function show({ clip, fromCopy = false }) {
    let payload;
    if (running) {
      payload = { mode: 'message', text: 'Önceki dosya işlemi sürüyor', sub: 'Bitince tekrar dene.' };
    } else {
      const s = await fileops.describe(clip.files);
      current = { paths: s.items.map((i) => i.path), files: s.files, folders: s.folders, parent: s.parent };
      if (!s.items.length) {
        payload = { mode: 'message', text: 'Dosyalar bulunamadı', sub: 'Kopyaladığın dosyalar taşınmış ya da silinmiş olabilir.' };
      } else {
        const list = targets(s.parent);
        payload = {
          mode: 'files',
          cut: clip.cut,
          summary: s,
          targets: list,
          autoPick: clip.cut && !list.some((t) => t.kind === 'recent'),
        };
      }
    }
    log.info('file panel', payload.mode, clip.files.length, clip.cut ? 'cut' : 'copy');
    send(win, 'files:show', payload);
    present(win, PANEL_W, fromCopy);
  }

  ipcMain.on('files:resize', (_e, h) => {
    if (!win) return;
    const height = Math.max(110, Math.min(700, Math.round(h)));
    const b = win.getBounds();
    if (b.height !== height) win.setBounds({ ...b, height });
  });

  ipcMain.on('files:cancel', () => hide());

  ipcMain.handle('files:pickFolder', async (_e, opts = {}) => {
    const move = opts.mode === 'move';
    const recent = config.get().fileRecent.find(isDir);
    dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(win, {
        title: move ? 'Nereye taşınsın?' : 'Nereye kopyalansın?',
        buttonLabel: move ? 'Buraya taşı' : 'Buraya kopyala',
        defaultPath: recent || (current && current.parent) || undefined,
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled ? null : r.filePaths[0];
    } finally {
      dialogOpen = false;
      if (win.isVisible()) {
        win.focus();
        win.webContents.focus(); // keys go to the page again, not just the window
      }
    }
  });

  ipcMain.on('files:run', (_e, req) => {
    hide();
    run(req || {}).catch((e) => {
      log.error('file action failed', e);
      running = false;
      showToast({ state: 'error', title: 'İşlem yapılamadı', sub: e.message, subError: true });
    });
  });

  // ---------------- actions ----------------

  // "3 dosya", "1 klasör", "4 öğe"
  function noun(n, files, folders) {
    if (folders === 0) return `${n} dosya`;
    if (files === 0) return `${n} klasör`;
    return `${n} öğe`;
  }

  function failText(failed) {
    if (!failed.length) return '';
    const f = failed[0];
    return `${f.name}: ${f.error}${failed.length > 1 ? ` · +${failed.length - 1} daha` : ''}`;
  }

  // The panel's items are on the clipboard still: after a move they are
  // gone from there, so pasting them again would fail.
  function clearClipboardIfOurs(items) {
    const clip = winfiles.clipboardFiles();
    if (clip && clip.files.length === items.length && clip.files.every((f, i) => same(f, items[i]))) clipboard.clear();
  }

  async function run(req) {
    if (!current || running) return;
    const items = current.paths;
    const { files, folders } = current;
    const what = noun(items.length, files, folders);
    const progress = (title) => (p) => showToast({ state: 'busy', title, progress: p });
    let r;
    let title;
    let sub = '';
    let open = null;
    let undoSub = 'Dosyalar eski yerine döndü.';

    if (req.action === 'paths') {
      clipboard.writeText(items.join('\r\n'));
      return showToast({ state: 'done', title: items.length > 1 ? `${items.length} dosya yolu kopyalandı` : 'Dosya yolu kopyalandı', sub: items[0] });
    }

    running = true;
    try {
      if (req.action === 'transfer') {
        const dest = String(req.target || '');
        if (!path.isAbsolute(dest)) return;
        const move = req.mode === 'move';
        const where = /^[A-Z]:\\$/i.test(dest) ? `${label(dest)} sürücüsüne` : `${label(dest)} klasörüne`;
        const busy = `${what} ${where} ${move ? 'taşınıyor' : 'kopyalanıyor'}…`;
        showToast({ state: 'busy', title: busy, progress: 0 });
        r = await fileops.transfer(items, dest, move ? 'move' : 'copy', throttle(progress(busy)));
        if (r.done) remember(dest);
        if (move && r.done) clearClipboardIfOurs(items);
        if (!r.done && r.skipped && !r.failed.length) {
          return showToast({ state: 'done', title: 'Dosyalar zaten bu klasörde', sub: dest });
        }
        title = `${noun(r.done, files, folders)} ${where} ${move ? 'taşındı' : 'kopyalandı'}`;
        sub = dest;
        open = () => shell.openPath(dest);
        if (!move) undoSub = 'Kopyalar Geri Dönüşüm Kutusu’na gönderildi.';
      } else if (req.action === 'gather') {
        showToast({ state: 'busy', title: `${what} yeni klasöre toplanıyor…` });
        r = await fileops.gather(items, req.name);
        clearClipboardIfOurs(items);
        title = `${noun(r.done, files, folders)} “${path.basename(r.dir)}” klasörüne toplandı`;
        sub = r.dir;
        open = () => shell.openPath(r.dir);
      } else if (req.action === 'sort') {
        showToast({ state: 'busy', title: 'Dosyalar türlerine göre ayrılıyor…' });
        r = await fileops.sortByType(items);
        clearClipboardIfOurs(items);
        title = `${r.done} dosya türlerine göre ayrıldı`;
        sub = Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(' · ');
        open = () => shell.openPath(r.parent);
      } else if (req.action === 'zip') {
        const busy = `${what} ZIP yapılıyor…`;
        showToast({ state: 'busy', title: busy, progress: 0 });
        r = await fileops.zip(items, req.name, throttle(progress(busy)));
        title = `ZIP hazır: ${path.basename(r.file)}`;
        sub = path.dirname(r.file);
        open = () => shell.showItemInFolder(r.file);
        undoSub = 'ZIP dosyası Geri Dönüşüm Kutusu’na gönderildi.';
      } else if (req.action === 'rename') {
        showToast({ state: 'busy', title: `${what} yeniden adlandırılıyor…` });
        r = await fileops.rename(items, req.name, Math.max(0, Number(req.start) || 0));
        clearClipboardIfOurs(items);
        title = `${noun(r.done, files, folders)} yeniden adlandırıldı`;
        const firstTo = r.undo.moves[0] && r.undo.moves[0].to;
        sub = firstTo ? path.basename(firstTo) + (r.done > 1 ? ' …' : '') : '';
        open = firstTo ? () => shell.showItemInFolder(firstTo) : null;
      } else {
        return;
      }
    } finally {
      running = false;
    }

    const u = r.undo;
    const undoable = u.moves.length || u.created.length;
    setLast(undoable ? { undo: u, sub: undoSub } : null);
    current = null; // the items have changed; the next panel reads them fresh

    if (!r.done && r.failed.length) {
      return showToast({ state: 'error', title: 'İşlem yapılamadı', sub: failText(r.failed), subError: true });
    }
    showToast({
      state: 'done',
      title,
      sub: r.failed.length ? `${r.failed.length} öğe yapılamadı — ${failText(r.failed)}` : sub,
      subError: !!r.failed.length,
      canUndo: !!undoable,
      open,
      openLabel: open ? (req.action === 'zip' || req.action === 'rename' ? 'Göster' : 'Klasörü aç') : '',
    });
  }

  // Progress callbacks can fire for every chunk; update the toast ~8× a second.
  function throttle(fn) {
    let lastAt = 0;
    return (p) => {
      const now = Date.now();
      if (p < 1 && now - lastAt < 120) return;
      lastAt = now;
      fn(p);
    };
  }

  function setLast(op) {
    last = op;
    onUndoChange();
  }

  async function undoLast() {
    if (!last || running) return;
    const op = last;
    setLast(null);
    running = true;
    showToast({ state: 'busy', title: 'Geri alınıyor…' });
    let r;
    try {
      r = await fileops.undo(op.undo, (f) => shell.trashItem(f));
    } finally {
      running = false;
    }
    if (r.failed.length) {
      showToast({ state: 'error', title: 'Bir kısmı geri alınamadı', sub: failText(r.failed), subError: true });
    } else {
      showToast({ state: 'done', undone: true, title: 'Geri alındı', sub: op.sub });
    }
  }

  // ---------------- toast ----------------

  function placeToast() {
    if (!toastHeight) return;
    const { workArea } = screen.getPrimaryDisplay();
    let bottom = workArea.y + workArea.height - 16;
    const other = belowToast();
    if (other && other.isVisible()) bottom = other.getBounds().y - 8;
    toastWin.setBounds({
      x: workArea.x + workArea.width - TOAST_W - 16,
      y: Math.round(bottom - toastHeight),
      width: TOAST_W,
      height: toastHeight,
    });
  }

  function showToast(t) {
    clearTimeout(toastTimer);
    toastOpen = t.open || null;
    const { open, ...rest } = t;
    send(toastWin, 'toast:show', rest);
    toastWin.__wantVisible = true;
    if (toastHeight) {
      placeToast();
      if (!toastWin.isVisible()) toastWin.showInactive();
    }
    if (t.state !== 'busy') scheduleToastHide(t.state === 'error' ? 12000 : 8000);
  }

  function cursorOnToast() {
    if (!toastWin.isVisible()) return false;
    const p = screen.getCursorScreenPoint();
    const b = toastWin.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }

  // Stays while the mouse is on it; the wait starts over once it leaves.
  function scheduleToastHide(ms) {
    clearTimeout(toastTimer);
    const tick = () => {
      if (cursorOnToast()) {
        toastTimer = setTimeout(() => scheduleToastHide(4000), 500);
        return;
      }
      hideToast();
    };
    toastTimer = setTimeout(tick, ms);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastWin.__wantVisible = false;
    if (toastWin.isVisible()) toastWin.hide();
  }

  ipcMain.on('toast:resize', (_e, h) => {
    toastHeight = Math.max(48, Math.min(240, Math.round(h)));
    placeToast();
    if (toastWin.__wantVisible && !toastWin.isVisible()) toastWin.showInactive();
  });
  ipcMain.on('toast:close', () => hideToast());
  ipcMain.on('toast:open', () => {
    if (toastOpen) toastOpen();
    hideToast();
  });
  function requestUndo() {
    undoLast().catch((e) => {
      log.error('undo failed', e);
      showToast({ state: 'error', title: 'Geri alınamadı', sub: e.message, subError: true });
    });
  }
  ipcMain.on('toast:undo', requestUndo);

  return {
    create,
    show,
    hide,
    undoLast: requestUndo,
    canUndo: () => !!last && !running,
    isVisible: () => !!win && win.isVisible(),
    isBusy: () => running || (!!win && win.isVisible()),
    clipboardFiles: () => winfiles.clipboardFiles(),
  };
};
