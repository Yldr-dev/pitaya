// External tools Pitaya needs, fetched on first run into data/bin:
//  - yt-dlp: the downloader (supports 1000+ sites). Self-updates daily.
//  - ffmpeg: MP3 conversion and merging video+audio.
//  - deno:   JavaScript runtime yt-dlp needs for full YouTube support.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const paths = require('./paths');
const config = require('./config');
const log = require('./log');
const { downloadFile, extractZip, fetchJson } = require('./net');

// yt-dlp uses the "folder" build (yt-dlp_win.zip): the single-exe build
// unpacks itself on every run, which costs ~1.5 s per launch.
const bin = {
  ytdlpDir: path.join(paths.binDir, 'yt-dlp'),
  ytdlp: path.join(paths.binDir, 'yt-dlp', 'yt-dlp.exe'),
  legacyYtdlp: path.join(paths.binDir, 'yt-dlp.exe'),
  ffmpegDir: path.join(paths.binDir, 'ffmpeg'),
  ffmpeg: path.join(paths.binDir, 'ffmpeg', 'ffmpeg.exe'),
  deno: path.join(paths.binDir, 'deno.exe'),
};

const SOURCES = {
  ytdlp: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip',
  ytdlpLatest: 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
  ffmpeg: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
  deno: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
};

const events = new EventEmitter();
let status = { state: 'checking', label: '', progress: null, error: null };

function setStatus(patch) {
  status = { ...status, ...patch };
  events.emit('status', status);
}

function run(file, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: 'utf8', env: toolEnv() }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

// Environment for yt-dlp & friends: UTF-8 output and our bin dir first on PATH.
function toolEnv() {
  return {
    ...process.env,
    PATH: `${paths.binDir};${bin.ffmpegDir};${process.env.PATH || ''}`,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

// Downloads the yt-dlp folder build into bin/yt-dlp.new, checks it runs,
// then swaps it in place of bin/yt-dlp.
async function installYtdlp(onProgress) {
  const zip = path.join(paths.tempDir, 'yt-dlp.zip');
  const fresh = bin.ytdlpDir + '.new';
  const old = bin.ytdlpDir + '.old';
  await downloadFile(SOURCES.ytdlp, zip, onProgress);
  fs.rmSync(fresh, { recursive: true, force: true });
  const root = path.resolve(fresh);
  await extractZip(zip, (name) => {
    const target = path.resolve(root, name);
    return target.startsWith(root + path.sep) ? target : null;
  });
  fs.rmSync(zip, { force: true });
  await run(path.join(fresh, 'yt-dlp.exe'), ['--version']);
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(bin.ytdlpDir)) fs.renameSync(bin.ytdlpDir, old);
  fs.renameSync(fresh, bin.ytdlpDir);
  fs.rm(old, { recursive: true, force: true }, () => {});
  fs.rm(bin.legacyYtdlp, { force: true }, () => {});
}

const components = [
  {
    id: 'ytdlp',
    label: 'yt-dlp',
    installed: () => fs.existsSync(bin.ytdlp),
    install: installYtdlp,
  },
  {
    id: 'ffmpeg',
    label: 'ffmpeg',
    installed: () => fs.existsSync(bin.ffmpeg) && fs.existsSync(path.join(bin.ffmpegDir, 'ffprobe.exe')),
    async install(onProgress) {
      const zip = path.join(paths.tempDir, 'ffmpeg.zip');
      await downloadFile(SOURCES.ffmpeg, zip, onProgress);
      fs.rmSync(bin.ffmpegDir, { recursive: true, force: true });
      await extractZip(zip, (name) => {
        const m = /^[^/]+\/bin\/([^/]+)$/.exec(name);
        if (!m || m[1].toLowerCase() === 'ffplay.exe') return null;
        return path.join(bin.ffmpegDir, m[1]);
      });
      fs.rmSync(zip, { force: true });
      await run(bin.ffmpeg, ['-version']);
    },
  },
  {
    id: 'deno',
    label: 'Deno',
    installed: () => fs.existsSync(bin.deno),
    async install(onProgress) {
      const zip = path.join(paths.tempDir, 'deno.zip');
      await downloadFile(SOURCES.deno, zip, onProgress);
      await extractZip(zip, (name) => (name.toLowerCase() === 'deno.exe' ? bin.deno + '.new' : null));
      fs.rmSync(zip, { force: true });
      fs.rmSync(bin.deno, { force: true });
      fs.renameSync(bin.deno + '.new', bin.deno);
      await run(bin.deno, ['--version']);
    },
  },
];

let ensuring = null;

// Installs whatever is missing. Safe to call repeatedly.
function ensure() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const missing = components.filter((c) => !c.installed());
    try {
      for (const c of missing) {
        log.info('installing component', c.id);
        setStatus({ state: 'installing', label: c.label, progress: 0, error: null });
        let attempt = 0;
        for (;;) {
          try {
            await c.install((p) => setStatus({ progress: p }));
            break;
          } catch (e) {
            if (++attempt >= 3) throw e;
            log.warn(`install ${c.id} failed, retrying`, e.message);
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
      }
      setStatus({ state: 'ready', label: '', progress: null, error: null });
      if (missing.some((c) => c.id === 'ytdlp')) config.update({ lastYtdlpUpdate: Date.now() });
      return true;
    } catch (e) {
      log.error('component install failed', e);
      setStatus({ state: 'error', progress: null, error: e.message });
      return false;
    } finally {
      ensuring = null;
    }
  })();
  return ensuring;
}

// Set by main: true while any yt-dlp process runs (its folder can't be swapped then).
let isBusy = () => false;
let updating = null;

// yt-dlp breaks when sites change, so keep it fresh (checked max once a day).
function updateYtdlp({ force = false } = {}) {
  if (updating) return updating;
  updating = (async () => {
    if (!fs.existsSync(bin.ytdlp)) return;
    const last = config.get().lastYtdlpUpdate || 0;
    if (!force && Date.now() - last < 24 * 3600 * 1000) return;
    try {
      const [{ stdout }, rel] = await Promise.all([run(bin.ytdlp, ['--version'], 30000), fetchJson(SOURCES.ytdlpLatest)]);
      const current = stdout.trim();
      const latest = String(rel.tag_name || '').trim();
      if (!latest || latest === current) {
        log.info('yt-dlp up to date', current);
        config.update({ lastYtdlpUpdate: Date.now() });
        return;
      }
      if (isBusy()) {
        log.info('yt-dlp update postponed: busy');
        return; // next periodic check retries
      }
      log.info('updating yt-dlp', current, '->', latest);
      await installYtdlp(null);
      config.update({ lastYtdlpUpdate: Date.now() });
    } catch (e) {
      log.warn('yt-dlp update failed', e.message, e.stderr || '');
    }
  })().finally(() => (updating = null));
  return updating;
}

async function versions() {
  const v = {};
  for (const [k, file, args] of [
    ['ytdlp', bin.ytdlp, ['--version']],
    ['ffmpeg', bin.ffmpeg, ['-version']],
    ['deno', bin.deno, ['--version']],
  ]) {
    try {
      const { stdout } = await run(file, args, 15000);
      const first = stdout.trim().split('\n')[0];
      v[k] = k === 'ffmpeg' ? (first.match(/version (\S+)/) || [])[1] || first : first.replace(/^deno\s+/, '').split(' ')[0];
    } catch {
      v[k] = null;
    }
  }
  return v;
}

module.exports = {
  bin,
  events,
  ensure,
  updateYtdlp,
  setBusyCheck: (fn) => (isBusy = fn),
  isUpdating: () => !!updating,
  versions,
  toolEnv,
  getStatus: () => status,
  isReady: () => components.every((c) => c.installed()),
};
