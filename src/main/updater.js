// Self-update from GitHub Releases for the portable (zip) build.
//
// Flow: download the new release zip -> extract to data/update/new ->
// start the NEW Pitaya.exe with --pitaya-apply-update. That process waits for
// the old one to exit, copies its own files over the app folder, relaunches
// the app and exits. No scripts, so unusual paths (e.g. "Yıldıray") are safe.
// original-fs: the update folder holds another app.asar, which Electron's fs
// would try to open as an archive instead of copying or deleting it.
const fs = require('original-fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const { EventEmitter } = require('events');
const paths = require('./paths');
const log = require('./log');
const { fetchJson, downloadFile, extractZip } = require('./net');
const pkg = require('../../package.json');

const repo = (pkg.pitaya && pkg.pitaya.updateRepo) || '';
const events = new EventEmitter();
let state = { status: 'idle', version: null, progress: null, error: null };

function set(patch) {
  state = { ...state, ...patch };
  events.emit('state', state);
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function canUpdate() {
  if (!app.isPackaged) return 'Geliştirme modunda güncelleme kapalı';
  if (!repo) return 'Güncelleme deposu ayarlanmamış';
  if (!paths.isPortable) return 'Uygulama klasörü yazılabilir değil';
  return null;
}

async function check() {
  const reason = canUpdate();
  if (reason) {
    set({ status: 'disabled', error: reason });
    return null;
  }
  set({ status: 'checking', error: null });
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
    const version = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => /win-x64\.zip$/i.test(a.name));
    if (!version || !asset || cmpVersion(version, app.getVersion()) <= 0) {
      set({ status: 'latest', version: null });
      return null;
    }
    return { version, url: asset.browser_download_url, size: asset.size };
  } catch (e) {
    log.warn('update check failed', e.message);
    set({ status: 'error', error: e.message });
    return null;
  }
}

function findExeDir(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'pitaya.exe')) return dir;
    for (const e of entries) if (e.isDirectory()) stack.push(path.join(dir, e.name));
  }
  return null;
}

let prepared = null;
let preparing = null; // a download in progress (automatic and manual checks can overlap)

// Downloads and extracts a release. Returns the folder with the new exe.
function prepare(rel) {
  if (prepared && prepared.version === rel.version) return Promise.resolve(prepared);
  if (!preparing) preparing = doPrepare(rel).finally(() => (preparing = null));
  return preparing;
}

async function doPrepare(rel) {
  set({ status: 'downloading', version: rel.version, progress: 0 });
  const zip = path.join(paths.updateDir, `Pitaya-${rel.version}.zip`);
  const out = path.join(paths.updateDir, 'new');
  try {
    fs.rmSync(paths.updateDir, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    await downloadFile(rel.url, zip, (p) => set({ progress: p }));
    const root = path.resolve(out);
    await extractZip(zip, (name) => {
      const target = path.resolve(root, name);
      return target.startsWith(root + path.sep) ? target : null; // zip-slip guard
    });
    fs.rmSync(zip, { force: true });
    const dir = findExeDir(out);
    if (!dir) throw new Error('Güncelleme paketinde Pitaya.exe yok');
    prepared = { version: rel.version, dir };
    set({ status: 'ready', progress: null });
    log.info('update ready', rel.version);
    return prepared;
  } catch (e) {
    log.error('update download failed', e);
    set({ status: 'error', error: e.message, progress: null });
    return null;
  }
}

// Hands over to the new exe and quits.
function apply() {
  if (!prepared) return false;
  const exe = path.join(prepared.dir, 'Pitaya.exe');
  log.info('applying update', prepared.version);
  const child = spawn(
    exe,
    ['--pitaya-apply-update', `--target=${paths.appDir}`, `--pid=${process.pid}`, `--exe=${process.execPath}`],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
  app.exit(0);
  return true;
}

// ---- runs inside the NEW exe ----

function argValue(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runApplyMode() {
  const target = argValue('target');
  const pid = Number(argValue('pid'));
  const oldExe = argValue('exe') || path.join(target, 'Pitaya.exe');
  const src = path.dirname(process.execPath);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < 100 && pid && alive(pid); i++) await sleep(200);
  await sleep(500);

  process.noAsar = true; // copy app.asar as a plain file
  let ok = false;
  for (let attempt = 0; attempt < 10 && !ok; attempt++) {
    try {
      for (const name of fs.readdirSync(src)) {
        if (name.toLowerCase() === 'data') continue;
        fs.cpSync(path.join(src, name), path.join(target, name), { recursive: true, force: true });
      }
      ok = true;
    } catch (e) {
      log.warn('update copy failed, retrying', e.message);
      await sleep(1000);
    }
  }
  process.noAsar = false;
  log[ok ? 'info' : 'error'](ok ? 'update applied' : 'update copy gave up');

  spawn(oldExe, ok ? ['--pitaya-updated'] : [], { detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
}

function cleanupLeftovers() {
  if (prepared) return;
  setTimeout(() => {
    if (!prepared) fs.rm(paths.updateDir, { recursive: true, force: true }, () => {});
  }, 20000);
}

module.exports = {
  events,
  check,
  prepare,
  apply,
  runApplyMode,
  cleanupLeftovers,
  isApplyMode: () => process.argv.includes('--pitaya-apply-update'),
  getState: () => state,
  hasPrepared: () => !!prepared,
  repo,
};
