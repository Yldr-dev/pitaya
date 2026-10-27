const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, dialog, shell, screen, nativeTheme } = require('electron');

const paths = require('./paths');
// Keep Electron's own cache inside the portable data folder too.
app.setPath('userData', paths.electronData);
app.setPath('sessionData', paths.electronData);
// GPU caches are useless for a few small windows and break on very long paths.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');

const log = require('./log');
const updater = require('./updater');

process.on('uncaughtException', (e) => log.error('uncaught', e));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));

if (updater.isApplyMode()) {
  app.whenReady().then(() => updater.runApplyMode());
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  const config = require('./config');
  const components = require('./components');
  const ytdlp = require('./ytdlp');
  const history = require('./history');
  const doubleCopy = require('./doublecopy');

  const ASSETS = path.join(__dirname, '..', '..', 'assets');
  const RENDERER = path.join(__dirname, '..', 'renderer');
  const PRELOAD = path.join(__dirname, '..', 'preload.js');

  let tray = null;
  let popupWin = null;
  let progressWin = null;
  let settingsWin = null;
  let popupBusy = false; // a folder dialog is open from the popup
  let registeredHotkey = null;
  let progressHideTimer = null;
  let progressHeight = 0;

  app.setAppUserModelId('app.pitaya');

  const bg = () => (nativeTheme.shouldUseDarkColors ? '#17151a' : '#ffffff');

  function makeWindow(file, opts) {
    const win = new BrowserWindow({
      show: false,
      backgroundColor: bg(),
      icon: path.join(ASSETS, 'icon.ico'),
      autoHideMenuBar: true,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false },
      ...opts,
    });
    win.removeMenu();
    win.loadFile(path.join(RENDERER, file));
    // Never let a page navigate away or open new windows.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return win;
  }

  // ---------------- popup ----------------

  function createPopup() {
    popupWin = makeWindow('popup.html', {
      width: 420,
      height: 300,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
    });
    popupWin.setAlwaysOnTop(true, 'pop-up-menu');
    // Clicking anywhere else closes the popup. Right after it opens, Windows
    // sometimes hands focus back to the previous app on its own; that early
    // blur takes focus back instead of closing.
    popupWin.on('blur', () => {
      if (popupBusy || !popupWin.isVisible()) return;
      if (Date.now() - (popupWin.__shownAt || 0) < 600) {
        setTimeout(() => popupWin.isVisible() && popupWin.focus(), 30);
        return;
      }
      hidePopup();
    });
    popupWin.on('show', () => {
      popupWin.__shownAt = Date.now();
      clearTimeout(popupWin.__idle);
      popupWin.__idle = setTimeout(hidePopup, 120000);
    });
  }

  function hidePopup() {
    if (popupWin && popupWin.isVisible()) popupWin.hide();
  }

  function centerOnCursorDisplay(win, w, h) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds({
      x: Math.round(workArea.x + (workArea.width - w) / 2),
      y: Math.round(workArea.y + (workArea.height - h) * 0.38),
      width: w,
      height: h,
    });
  }

  function extractUrl(text) {
    const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
    if (!m) return null;
    try {
      return new URL(m[0]).href;
    } catch {
      return null;
    }
  }

  // ---- video info cache ----
  // Info is fetched once per link and reused: by the popup, and by the
  // download itself (saved JSON), so nothing is extracted twice.
  const infoCache = new Map(); // url -> { url, task, result, error, at }
  const INFO_TTL = 30 * 60 * 1000;
  const INFO_MAX = 8;

  function dropInfo(entry) {
    if (entry.task) entry.task.cancel();
    if (entry.result && entry.result.infoJson) fs.rm(entry.result.infoJson, { force: true }, () => {});
    infoCache.delete(entry.url);
  }

  function getInfo(url, { prefetch = false } = {}) {
    const cached = infoCache.get(url);
    if (cached) {
      const fresh = cached.task || (cached.result && Date.now() - cached.at < INFO_TTL);
      if (fresh || (prefetch && cached.error)) return cached;
      dropInfo(cached); // stale, or failed before and the user is asking now: retry
    }
    while (infoCache.size >= INFO_MAX) dropInfo(infoCache.values().next().value);

    const task = ytdlp.fetchInfo(url);
    const entry = { url, task, result: null, error: null, at: Date.now() };
    infoCache.set(url, entry);
    task.promise.then(
      (r) => {
        Object.assign(entry, { result: r, task: null, at: Date.now() });
        send(popupWin, 'popup:info', { url, info: r, dup: dupFor(url, r.key) });
      },
      (e) => {
        Object.assign(entry, { error: e.message, task: null });
        log.warn('info failed', url, e.message);
        send(popupWin, 'popup:info', { url, error: e.message });
      }
    );
    return entry;
  }

  // Is this video downloading (or queued) right now, or was it downloaded before?
  function dupFor(url, key) {
    const busy = ['queued', 'starting', 'downloading', 'processing'];
    const active = ytdlp.list().find((j) => busy.includes(j.state) && (j.url === url || (key && j.key === key)));
    if (active) return { active: true, queued: active.state === 'queued' };
    const r = history.find(url, key);
    if (!r) return null;
    const dir = path.dirname(r.file);
    const known = config.get().folders.find((f) => path.resolve(f.path) === path.resolve(dir));
    return { format: r.format, quality: r.quality, at: r.at, count: r.count || 0, folder: known ? known.name : path.basename(dir) };
  }

  // Links from these sites start loading as soon as they are copied, so the
  // popup is usually ready by the time the hotkey is pressed. Other links are
  // only fetched when the user presses the hotkey.
  const VIDEO_HOSTS =
    /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|tiktok\.com|instagram\.com|x\.com|twitter\.com|reddit\.com|redd\.it|vimeo\.com|dailymotion\.com|dai\.ly|twitch\.tv|kick\.com|soundcloud\.com|facebook\.com|fb\.watch|bilibili\.com|rumble\.com|streamable\.com|bandcamp\.com|pinterest\.com|threads\.net|threads\.com|bsky\.app|vk\.com|ok\.ru|9gag\.com|imgur\.com|archive\.org|nicovideo\.jp|mixcloud\.com|tumblr\.com|loom\.com|ted\.com)$/i;

  let lastClip = null;
  async function watchClipboard() {
    if (!components.isReady()) return;
    const text = await readClipboard();
    if (text === lastClip) return;
    lastClip = text;
    if (text.length > 2000) return;
    const url = extractUrl(text);
    if (!url) return;
    const host = new URL(url).hostname;
    if (!VIDEO_HOSTS.test(host)) return;
    log.info('prefetch', host);
    getInfo(url, { prefetch: true });
  }

  function send(win, channel, data) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }

  // Electron 45+: clipboard.readText() returns a Promise (older: a string).
  async function readClipboard() {
    try {
      return String((await Promise.race([clipboard.readText(), new Promise((r) => setTimeout(() => r(''), 1500))])) || '');
    } catch (e) {
      log.warn('clipboard read failed', e.message);
      return '';
    }
  }

  let hotkeyBusy = false;
  async function onHotkey() {
    if (hotkeyBusy) return;
    if (popupWin.isVisible()) return hidePopup();
    hotkeyBusy = true;
    try {
      await showPopupForClipboard();
    } finally {
      hotkeyBusy = false;
    }
  }

  // Copying a link twice quickly works like the hotkey. Plain text copied twice
  // is common, so anything that isn't just a link is ignored.
  async function onDoubleCopy() {
    if (hotkeyBusy || popupWin.isVisible() || !components.isReady()) return;
    const text = (await readClipboard()).trim();
    if (!/^https?:\/\/\S+$/i.test(text) || !extractUrl(text)) return;
    log.info('double copy');
    hotkeyBusy = true;
    try {
      await showPopupForClipboard({ fromCopy: true });
    } finally {
      hotkeyBusy = false;
    }
  }

  function applyDoubleCopy() {
    if (config.get().doubleCopy) doubleCopy.start(() => onDoubleCopy().catch((e) => log.warn('double copy', e.message)));
    else doubleCopy.stop();
  }

  async function showPopupForClipboard({ fromCopy = false } = {}) {
    const cfg = config.get();
    const url = extractUrl(await readClipboard());
    let payload;

    if (!components.isReady()) {
      payload = { mode: 'message', icon: 'wait', text: 'Pitaya hazırlanıyor', sub: 'Gerekli bileşenler indiriliyor, birazdan hazır.' };
      components.ensure();
      showProgress({ force: true });
    } else if (!url) {
      payload = { mode: 'message', icon: 'link', text: 'Panoda link yok', sub: 'Önce indirmek istediğin videonun linkini kopyala.' };
    } else {
      lastClip = null; // let the watcher re-check after this
      const entry = getInfo(url);
      payload = {
        mode: 'choose',
        url,
        host: new URL(url).hostname.replace(/^www\./, ''),
        folders: cfg.folders,
        lastFormat: cfg.lastFormat,
        lastQuality: cfg.lastQuality,
        lastFolder: cfg.lastFolder,
        info: entry.result,
        infoError: entry.error,
        dup: dupFor(url, entry.result && entry.result.key),
      };
    }
    log.info(fromCopy ? 'double copy' : 'hotkey', payload.mode, url ? new URL(url).hostname : '-');
    send(popupWin, 'popup:show', payload);
    centerOnCursorDisplay(popupWin, 420, popupWin.getBounds().height);
    popupWin.show();
    // After a copy (not a hotkey) Windows won't hand us focus by itself.
    if (fromCopy) doubleCopy.bringToFront(popupWin);
    popupWin.focus();
    popupWin.webContents.focus();
    setTimeout(() => {
      if (popupWin.isVisible() && !popupWin.isFocused()) {
        // Windows can refuse focus to background apps; nudge it once more.
        popupWin.setAlwaysOnTop(false);
        popupWin.setAlwaysOnTop(true, 'pop-up-menu');
        doubleCopy.bringToFront(popupWin);
        popupWin.focus();
        log.info('popup focus retry', popupWin.isFocused());
      }
    }, 120);
  }

  ipcMain.on('popup:resize', (_e, h) => {
    if (!popupWin) return;
    const height = Math.max(120, Math.min(640, Math.round(h)));
    const b = popupWin.getBounds();
    if (b.height !== height) popupWin.setBounds({ ...b, height });
  });

  ipcMain.on('popup:cancel', () => hidePopup());

  ipcMain.handle('popup:pickFolder', async () => {
    popupBusy = true;
    try {
      const r = await dialog.showOpenDialog(popupWin, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    } finally {
      popupBusy = false;
      if (popupWin.isVisible()) popupWin.focus();
    }
  });

  ipcMain.on('popup:choose', (_e, choice) => {
    hidePopup();
    if (!ytdlp.FORMATS.includes(choice.format)) return log.warn('unknown format', choice.format);
    const cfg = config.get();
    let folder = choice.customFolder;
    if (!folder) folder = (cfg.folders[choice.folderIndex] || cfg.folders[0] || {}).path;
    if (!folder) folder = app.getPath('downloads');
    const patch = { lastFormat: choice.format, lastFolder: choice.customFolder ? cfg.lastFolder : choice.folderIndex };
    if (choice.format === 'mp4') patch.lastQuality = choice.quality === 'best' ? 'best' : choice.quality;
    if (choice.customFolder && !cfg.folders.some((f) => f.path === choice.customFolder)) {
      // Remember a one-off folder so it shows up next time.
      patch.folders = [...cfg.folders, { name: path.basename(choice.customFolder) || choice.customFolder, path: choice.customFolder }];
      patch.lastFolder = patch.folders.length - 1;
    }
    config.update(patch);
    const entry = infoCache.get(choice.url);
    const info = entry && entry.result;
    try {
      ytdlp.start({
        url: choice.url,
        format: choice.format,
        quality: choice.quality,
        folder,
        title: info ? info.title : null,
        key: info ? info.key : null,
        thumbnail: info ? info.thumbnail : null,
        infoJson: info ? info.infoJson : null,
        useCookies: !!(info && info.useCookies),
      });
    } catch (e) {
      log.error('start failed', e);
      dialog.showErrorBox('Pitaya', `İndirme başlatılamadı:\n${e.message}`);
    }
    showProgress({ force: true });
  });

  // ---------------- progress panel ----------------

  function createProgress() {
    progressWin = makeWindow('progress.html', {
      width: 360,
      height: 100,
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
    progressWin.setAlwaysOnTop(true, 'pop-up-menu');
  }

  function placeProgress() {
    if (!progressHeight) return;
    const { workArea } = screen.getPrimaryDisplay();
    const w = 360;
    progressWin.setBounds({
      x: workArea.x + workArea.width - w - 16,
      y: workArea.y + workArea.height - progressHeight - 16,
      width: w,
      height: progressHeight,
    });
  }

  // The user hid the panel with "—": stay hidden until they start a new
  // download or open it from the tray.
  let progressUserHidden = false;
  // Opened on purpose (tray click): shows even when there's nothing in it.
  let progressPinned = false;
  // Mouse was on the panel when it was about to hide.
  let progressHover = false;
  const PANEL_IDLE_MS = 10000;

  function progressHasContent() {
    const c = components.getStatus().state;
    const u = updater.getState().status;
    return (
      progressPinned || ytdlp.list().length > 0 || c === 'installing' || c === 'error' || u === 'downloading' || u === 'ready'
    );
  }

  function hideProgress() {
    clearTimeout(progressHideTimer);
    progressWin.__wantVisible = false;
    progressHover = false;
    if (progressWin.isVisible()) progressWin.hide();
  }

  function openPanel() {
    progressPinned = true;
    sendProgressMeta();
    showProgress({ force: true });
    maybeHideProgress();
  }

  function sendProgressMeta() {
    const cfg = config.get();
    send(progressWin, 'progress:meta', { hotkey: cfg.hotkey, doubleCopy: cfg.doubleCopy && doubleCopy.available() });
  }

  function togglePanel() {
    if (progressWin.isVisible()) {
      progressPinned = false;
      progressUserHidden = true;
      hideProgress();
      if (ytdlp.activeCount() === 0) ytdlp.clearFinished();
    } else {
      openPanel();
    }
  }

  function showProgress({ force = false } = {}) {
    if (force) progressUserHidden = false;
    if (progressUserHidden || !progressHasContent()) return;
    clearTimeout(progressHideTimer);
    progressWin.__wantVisible = true;
    if (!progressWin.isVisible() && progressHeight) {
      placeProgress();
      progressWin.showInactive();
    }
  }

  // The panel never takes focus, so mouse-enter/leave events aren't reliable;
  // ask Windows where the cursor is instead.
  function cursorOnPanel() {
    if (!progressWin.isVisible()) return false;
    const p = screen.getCursorScreenPoint();
    const b = progressWin.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }

  // Hide right away when empty. Otherwise, once nothing is downloading or
  // waiting, hide after 10 s. While the mouse is on the panel it stays, and
  // the 10 s start over once the mouse leaves.
  function maybeHideProgress() {
    clearTimeout(progressHideTimer);
    progressHover = false;
    if (!progressHasContent()) return hideProgress();
    const u = updater.getState().status;
    const busy = ytdlp.activeCount() > 0 || components.getStatus().state === 'installing' || u === 'downloading';
    if (busy) return;
    const idle = () => {
      if (cursorOnPanel()) {
        progressHover = true;
        progressHideTimer = setTimeout(idle, 500);
      } else if (progressHover) {
        progressHover = false;
        progressHideTimer = setTimeout(idle, PANEL_IDLE_MS);
      } else {
        progressPinned = false;
        hideProgress();
        ytdlp.clearFinished();
      }
    };
    progressHideTimer = setTimeout(idle, PANEL_IDLE_MS);
  }

  ipcMain.on('progress:resize', (_e, h) => {
    progressHeight = Math.max(60, Math.min(560, Math.round(h)));
    placeProgress();
    if (progressWin.__wantVisible && !progressUserHidden && !progressWin.isVisible()) progressWin.showInactive();
  });
  ipcMain.on('progress:settings', () => openSettings());
  ipcMain.on('progress:hide', () => {
    progressPinned = false;
    progressUserHidden = true;
    hideProgress();
    if (ytdlp.activeCount() === 0) ytdlp.clearFinished();
  });
  ipcMain.on('progress:cancel', (_e, id) => ytdlp.cancel(id));
  ipcMain.on('progress:dismiss', (_e, id) => ytdlp.dismiss(id));
  const fileOf = (id) => {
    const j = ytdlp.get(id);
    return j && j.file && fs.existsSync(j.file) ? j.file : null;
  };
  // 📂: select the file in Explorer (or just open the folder if it's gone).
  ipcMain.on('progress:open', (_e, id) => {
    const file = fileOf(id);
    const j = ytdlp.get(id);
    if (file) shell.showItemInFolder(file);
    else if (j) shell.openPath(j.folder);
  });
  // Open the video/song in the default player; a playlist opens its folder.
  async function openResult({ file, folder, count }) {
    if (count > 1 || !file || !fs.existsSync(file)) return folder && shell.openPath(folder);
    const err = await shell.openPath(file);
    if (err) {
      log.warn('open file failed', file, err);
      shell.showItemInFolder(file);
    }
  }
  // Card click.
  ipcMain.on('progress:play', (_e, id) => {
    const j = ytdlp.get(id);
    if (j) openResult(j);
  });
  ipcMain.on('progress:retry', (_e, id) => {
    const j = ytdlp.get(id);
    if (!j) {
      components.ensure();
      return;
    }
    ytdlp.dismiss(id);
    ytdlp.start({
      url: j.url,
      format: j.format,
      quality: j.quality,
      folder: j.folder,
      title: j.listTitle || j.title,
      key: j.key,
      thumbnail: j.thumbnail,
    });
  });
  ipcMain.on('progress:history', () => openHistory());

  // ---- "download finished" notification ----
  // A tray balloon, which Windows shows as a normal notification. Unlike
  // Electron's Notification it works without a Start menu shortcut, which the
  // portable build doesn't have.
  let balloonTarget = null; // what clicking the notification opens
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  ytdlp.events.on('finished', (j) => {
    if (!tray || !config.get().notify) return;
    const ok = j.state === 'done';
    const list = j.count > 1;
    balloonTarget = ok ? { file: j.file, folder: j.folder, count: j.count } : { panel: true };
    const name = list ? j.listTitle || j.title : j.title;
    let content;
    if (!ok) content = `${clip(name, 120)}\n${clip(j.error || 'Bilinmeyen hata', 120)}`;
    else if (list) content = `${clip(name, 160)} · ${j.count} video\nKlasörü açmak için tıkla.`;
    else content = `${clip(name, 180)}\n${ytdlp.isAudio(j.format) ? 'Dinlemek' : 'İzlemek'} için tıkla.`;
    tray.displayBalloon({
      icon: path.join(ASSETS, 'icon.png'),
      title: ok ? (list ? 'Oynatma listesi indirildi' : 'İndirme tamamlandı') : 'İndirme başarısız',
      content,
      respectQuietTime: true,
    });
  });
  ipcMain.handle('progress:state', () => ({
    jobs: ytdlp.list(),
    components: components.getStatus(),
    update: updater.getState(),
    hotkey: config.get().hotkey,
    doubleCopy: config.get().doubleCopy && doubleCopy.available(),
  }));

  let lastActive = -1;
  ytdlp.events.on('jobs', (jobs) => {
    send(progressWin, 'progress:jobs', jobs);
    if (jobs.length) showProgress();
    maybeHideProgress();
    const active = ytdlp.activeCount();
    if (active !== lastActive) {
      lastActive = active;
      refreshTray();
    }
  });

  components.events.on('status', (s) => {
    send(progressWin, 'progress:components', s);
    send(settingsWin, 'settings:components', s);
    if (s.state === 'installing' || s.state === 'error') showProgress({ force: true });
    if (s.state === 'ready') maybeHideProgress();
  });

  // ---------------- history window ----------------

  let historyWin = null;

  function openHistory() {
    if (historyWin && !historyWin.isDestroyed()) {
      historyWin.show();
      historyWin.focus();
      return;
    }
    const dark = nativeTheme.shouldUseDarkColors;
    historyWin = makeWindow('history.html', {
      width: 600,
      height: 680,
      minWidth: 440,
      minHeight: 400,
      title: 'Pitaya — İndirme geçmişi',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: bg(), symbolColor: dark ? '#e8e3ea' : '#2a2530', height: 40 },
    });
    historyWin.once('ready-to-show', () => historyWin.show());
    historyWin.on('closed', () => (historyWin = null));
  }

  // Entries for the window: newest first, folder shown by its Pitaya name.
  function historyEntries() {
    const folders = config.get().folders;
    return history.all().map((r) => {
      const known = folders.find((f) => path.resolve(f.path) === path.resolve(r.folder));
      return { ...r, folderName: known ? known.name : path.basename(r.folder) || r.folder };
    });
  }

  history.events.on('changed', () => {
    send(historyWin, 'history:changed');
    send(settingsWin, 'settings:historyCount', history.all().length);
  });

  ipcMain.handle('history:list', () => historyEntries());
  ipcMain.on('history:open', (_e, id) => {
    const r = history.get(id);
    if (r) openResult({ file: r.file, folder: r.folder || path.dirname(r.file), count: r.count });
  });
  ipcMain.on('history:reveal', (_e, id) => {
    const r = history.get(id);
    if (!r) return;
    if (fs.existsSync(r.file)) shell.showItemInFolder(r.file);
    else shell.openPath(r.folder || path.dirname(r.file));
  });
  ipcMain.on('history:remove', (_e, id) => history.remove(id));
  ipcMain.handle('history:clear', async () => {
    const r = await dialog.showMessageBox(historyWin, {
      type: 'question',
      buttons: ['Temizle', 'Vazgeç'],
      defaultId: 1,
      cancelId: 1,
      title: 'Pitaya',
      message: 'İndirme geçmişi temizlensin mi?',
      detail: 'Sadece liste silinir; indirdiğin dosyalar yerinde kalır.',
    });
    if (r.response === 0) history.clear();
  });
  // Download again into the same folder, same format and quality.
  ipcMain.on('history:redownload', (_e, id) => {
    const r = history.get(id);
    if (!r || !r.url) return;
    ytdlp.start({
      url: r.url,
      format: r.format,
      quality: r.quality || 'best',
      folder: r.folder || path.dirname(r.file),
      title: r.title,
      key: r.key,
      thumbnail: r.thumbnail,
    });
    showProgress({ force: true });
  });

  // ---------------- settings ----------------

  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.show();
      settingsWin.focus();
      return;
    }
    const dark = nativeTheme.shouldUseDarkColors;
    settingsWin = makeWindow('settings.html', {
      width: 520,
      height: 640,
      minWidth: 440,
      minHeight: 480,
      title: 'Pitaya',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: bg(), symbolColor: dark ? '#e8e3ea' : '#2a2530', height: 40 },
      maximizable: false,
    });
    settingsWin.once('ready-to-show', () => settingsWin.show());
    settingsWin.on('closed', () => {
      settingsWin = null;
      registerHotkey(config.get().hotkey); // in case recording was interrupted
    });
  }

  function registerHotkey(accel) {
    if (registeredHotkey) {
      globalShortcut.unregister(registeredHotkey);
      registeredHotkey = null;
    }
    if (!accel) return false;
    let ok = false;
    try {
      ok = globalShortcut.register(accel, onHotkey);
    } catch (e) {
      log.warn('hotkey invalid', accel, e.message);
    }
    if (ok) registeredHotkey = accel;
    else log.warn('hotkey register failed', accel);
    return ok;
  }

  ipcMain.handle('settings:get', () => ({
    config: config.get(),
    version: app.getVersion(),
    dataDir: paths.dataDir,
    hotkeyActive: !!registeredHotkey,
    doubleCopyAvailable: doubleCopy.available(),
    historyCount: history.all().length,
    components: components.getStatus(),
    update: updater.getState(),
    updateRepo: updater.repo,
  }));
  ipcMain.handle('settings:versions', () => components.versions());
  ipcMain.handle('settings:pickFolder', async () => {
    const r = await dialog.showOpenDialog(settingsWin, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('settings:save', (_e, patch) => {
    const allowed = {};
    if (Array.isArray(patch.folders)) {
      allowed.folders = patch.folders
        .filter((f) => f && typeof f.path === 'string' && f.path)
        .map((f) => ({ name: String(f.name || path.basename(f.path) || f.path).slice(0, 60), path: f.path }));
      const cfg = config.get();
      if (cfg.lastFolder >= allowed.folders.length) allowed.lastFolder = 0;
    }
    if (typeof patch.openAtLogin === 'boolean') allowed.openAtLogin = patch.openAtLogin;
    if (typeof patch.autoUpdate === 'boolean') allowed.autoUpdate = patch.autoUpdate;
    if (typeof patch.doubleCopy === 'boolean') allowed.doubleCopy = patch.doubleCopy;
    if (typeof patch.notify === 'boolean') allowed.notify = patch.notify;
    if (['', 'firefox', 'chrome', 'edge', 'brave', 'opera', 'vivaldi'].includes(patch.cookiesBrowser)) {
      allowed.cookiesBrowser = patch.cookiesBrowser;
    }
    const cfg = config.update(allowed);
    applyLoginItem();
    if ('doubleCopy' in allowed) {
      applyDoubleCopy();
      sendProgressMeta();
    }
    return cfg;
  });
  ipcMain.handle('settings:setHotkey', (_e, accel) => {
    const prev = config.get().hotkey;
    if (registerHotkey(accel)) {
      config.update({ hotkey: accel });
      return { ok: true };
    }
    registerHotkey(prev);
    return { ok: false, error: 'Bu kısayol başka bir uygulama tarafından kullanılıyor ya da geçersiz.' };
  });
  ipcMain.on('settings:suspendHotkey', (_e, suspend) => {
    if (suspend) registerHotkey(null);
    else registerHotkey(config.get().hotkey);
  });
  ipcMain.on('settings:openData', () => shell.openPath(paths.dataDir));
  ipcMain.on('settings:openLog', () => shell.openPath(paths.logFile));
  ipcMain.on('settings:openHistory', () => openHistory());
  ipcMain.handle('settings:checkUpdate', () => runUpdateCheck({ manual: true }));
  ipcMain.handle('settings:updateYtdlp', async () => {
    await components.updateYtdlp({ force: true });
    return components.versions();
  });
  ipcMain.on('settings:repairComponents', () => {
    components.ensure();
  });

  updater.events.on('state', (s) => {
    send(settingsWin, 'settings:update', s);
    send(progressWin, 'progress:update', s);
  });

  // ---------------- tray ----------------

  function refreshTray() {
    if (!tray) return;
    const n = ytdlp.activeCount();
    const hk = config.get().hotkey;
    tray.setToolTip(n ? `Pitaya — ${n} indirme sürüyor` : `Pitaya — ${hk}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Panodaki linki indir${hk ? `\t${hk}` : ''}`, click: () => onHotkey() },
        { label: 'İndirmeleri göster', click: () => openPanel() },
        { label: 'İndirme geçmişi', click: () => openHistory() },
        { type: 'separator' },
        { label: 'Ayarlar', click: openSettings },
        { type: 'separator' },
        { label: 'Çıkış', click: () => app.quit() },
      ])
    );
  }

  function createTray() {
    tray = new Tray(path.join(ASSETS, 'tray.ico'));
    tray.on('click', () => togglePanel());
    tray.on('balloon-click', () => {
      const t = balloonTarget;
      balloonTarget = null;
      if (!t) return;
      if (t.panel) openPanel();
      else openResult(t);
    });
    refreshTray();
  }

  // Without this, notifications are headed "app.pitaya". Windows reads the
  // name and icon of an app id from here (per user, no admin needed).
  function registerAppName() {
    const icon = path.join(paths.dataDir, 'icon.png');
    try {
      fs.writeFileSync(icon, fs.readFileSync(path.join(ASSETS, 'icon.png')));
    } catch (e) {
      log.warn('icon copy failed', e.message);
    }
    const key = 'HKCU\\Software\\Classes\\AppUserModelId\\app.pitaya';
    const reg = (name, value) =>
      require('child_process').execFile('reg', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, (err) => {
        if (err) log.warn('app name registration failed', name, err.message);
      });
    reg('DisplayName', 'Pitaya');
    reg('IconUri', icon);
  }

  function applyLoginItem() {
    if (!app.isPackaged) return;
    // Re-applied on each start so it follows the folder if it was moved.
    app.setLoginItemSettings({ openAtLogin: !!config.get().openAtLogin, path: process.execPath, args: ['--hidden'] });
  }

  // ---------------- updates ----------------

  async function runUpdateCheck({ manual = false } = {}) {
    if (!manual && !config.get().autoUpdate) return updater.getState();
    const rel = await updater.check();
    if (rel && (await updater.prepare(rel))) {
      if (ytdlp.activeCount() === 0 && !popupWin.isVisible()) updater.apply();
    }
    return updater.getState();
  }

  // Apply a prepared update as soon as downloads finish.
  let applyTimer = null;
  ytdlp.events.on('jobs', () => {
    if (updater.hasPrepared() && ytdlp.activeCount() === 0 && !applyTimer) {
      applyTimer = setTimeout(() => {
        applyTimer = null;
        if (ytdlp.activeCount() === 0 && !popupWin.isVisible()) updater.apply();
      }, 8000);
    }
  });

  // ---------------- lifecycle ----------------

  app.on('second-instance', () => openPanel());
  app.on('window-all-closed', (e) => e.preventDefault()); // live in the tray
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(async () => {
    // Leftovers from downloads interrupted by a crash or shutdown.
    for (const name of fs.readdirSync(paths.tempDir)) {
      try {
        fs.rmSync(path.join(paths.tempDir, name), { recursive: true, force: true });
      } catch {}
    }
    components.setBusyCheck(() => ytdlp.isBusy());
    config.load();
    createTray();
    createPopup();
    createProgress();
    applyLoginItem();
    registerAppName();

    const firstRun = !components.isReady();
    if (!registerHotkey(config.get().hotkey)) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Pitaya',
        message: `Kısayol (${config.get().hotkey}) kaydedilemedi.`,
        detail: 'Başka bir uygulama kullanıyor olabilir. Ayarlardan farklı bir kısayol seç.',
      });
      openSettings();
    }
    refreshTray();

    const updated = process.argv.includes('--pitaya-updated');
    const manualLaunch = !process.argv.includes('--hidden') && !updated;
    if (firstRun) openSettings();
    else if (manualLaunch) openPanel();
    if (updated) log.info('started after update', app.getVersion());

    applyDoubleCopy();
    await components.ensure();
    components.updateYtdlp();
    // Cheap check; it only goes online once a day, and waits while yt-dlp is busy.
    setInterval(() => components.updateYtdlp(), 3600 * 1000);
    setInterval(() => watchClipboard().catch(() => {}), 1000);

    updater.cleanupLeftovers();
    setTimeout(() => runUpdateCheck(), 30 * 1000);
    setInterval(() => runUpdateCheck(), 6 * 3600 * 1000);
  });
}
