// Talks to yt-dlp: reads available qualities and runs downloads.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { bin, toolEnv } = require('./components');
const paths = require('./paths');
const config = require('./config');
const history = require('./history');
const log = require('./log');

// The browser session (cookies) is only used after a site asked for a login.
// Reading it can fail (e.g. Chrome locks its cookie file while it runs), and
// that must never break public videos.
function baseArgs({ cookies = false } = {}) {
  // --encoding utf-8: without it yt-dlp prints in the Windows code page
  // (cp1254 on Turkish systems) and paths like "Yıldıray" come out broken.
  const args = ['--ignore-config', '--encoding', 'utf-8', '--no-playlist', '--ffmpeg-location', bin.ffmpegDir, '--no-color'];
  const browser = config.get().cookiesBrowser;
  if (cookies && browser) args.push('--cookies-from-browser', browser);
  return args;
}

const NEEDS_LOGIN =
  /sign in|log ?in|registered users|account credentials|--cookies|cookies-from-browser|private video|age[- ]restricted|confirm your age|members[- ]only|not a bot|only available (to|for)/i;

const canUseCookies = (stderr) => !!config.get().cookiesBrowser && NEEDS_LOGIN.test(stderr || '');

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

// ---------- info / qualities ----------

function resOf(f) {
  if (f.width && f.height) return Math.min(f.width, f.height);
  return f.height || null;
}

let currentDuration = 0;
function sizeOf(f) {
  if (f.filesize || f.filesize_approx) return f.filesize || f.filesize_approx;
  // Estimate from bitrate (kbit/s) when the site doesn't report a size.
  return f.tbr && currentDuration ? Math.round(f.tbr * 125 * currentDuration) : 0;
}

// Direct (http) formats over streamed (m3u8/dash) ones, then higher bitrate.
function better(a, b) {
  const direct = (f) => (/^https?$/.test(f.protocol || '') ? 1 : 0);
  if (direct(a) !== direct(b)) return direct(a) > direct(b);
  return (a.tbr || 0) > (b.tbr || 0);
}

function qualityLabel(r) {
  const tag = { 4320: '8K', 2160: '4K', 1440: '2K', 1080: 'Full HD', 720: 'HD' }[r];
  return tag ? `${r}p · ${tag}` : `${r}p`;
}

function thumbOf(info) {
  if (info.thumbnail) return info.thumbnail;
  const list = (info.thumbnails || []).filter((t) => t && t.url);
  // Medium-sized thumbnail is plenty for a 120px preview.
  const mid = list.find((t) => t.width && t.width >= 240 && t.width <= 720);
  return (mid || list[list.length - 1] || {}).url || null;
}

// Same video under different links (youtu.be/x, watch?v=x&t=10) gets one key.
function keyOf(info) {
  const ex = info.extractor_key || info.ie_key || info.extractor;
  return ex && info.id ? `${ex}:${info.id}` : null;
}

function summarize(info) {
  const thumbnail = thumbOf(info);
  if (info._type === 'playlist') {
    return {
      key: keyOf(info),
      thumbnail,
      uploader: info.uploader || info.channel || '',
      title: info.title || 'Oynatma listesi',
      isPlaylist: true,
      count: (info.entries || []).length,
      qualities: [],
    };
  }
  const formats = info.formats || [];
  currentDuration = info.duration || 0;
  const audio = formats
    .filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  const byRes = new Map();
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === 'none') continue;
    if (f.format_note === 'storyboard' || f.ext === 'mhtml') continue;
    const r = resOf(f);
    if (!r) continue;
    const prev = byRes.get(r);
    if (!prev || better(f, prev)) byRes.set(r, f);
  }

  const qualities = [...byRes.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([r, f]) => {
      const hasAudio = f.acodec && f.acodec !== 'none';
      const bytes = sizeOf(f) ? sizeOf(f) + (hasAudio || !audio ? 0 : sizeOf(audio)) : 0;
      return { value: r, label: qualityLabel(r), bytes };
    });

  return {
    key: keyOf(info),
    thumbnail,
    title: info.title || '',
    uploader: info.uploader || info.channel || '',
    duration: info.duration || 0,
    isPlaylist: false,
    qualities,
    audioBytes: audio ? sizeOf(audio) : 0,
  };
}

// Number of yt-dlp processes alive (info + downloads); updates wait for 0.
let running = 0;

// Returns { promise, cancel }. Tries without the browser session first.
function fetchInfo(url) {
  let child = null;
  let canceled = false;
  const promise = (async () => {
    try {
      return await runInfo(url, false, (c) => (child = c));
    } catch (e) {
      if (canceled || !canUseCookies(e.raw)) throw e;
      log.info('info needs login, retrying with browser session', url);
      const s = await runInfo(url, true, (c) => (child = c));
      s.useCookies = true;
      return s;
    }
  })();
  return {
    promise,
    cancel: () => {
      canceled = true;
      killTree(child);
    },
  };
}

function runInfo(url, cookies, onChild) {
  let child;
  return new Promise((resolve, reject) => {
    const args = [...baseArgs({ cookies }), '-J', '--flat-playlist', '--no-warnings', '--', url];
    child = spawn(bin.ytdlp, args, { windowsHide: true, env: toolEnv() });
    onChild(child);
    running++;
    let counted = true;
    const done = () => counted && (counted = false, running--);
    child.on('exit', done);
    child.on('error', done);
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    const timer = setTimeout(() => killTree(child), 60000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(Object.assign(new Error(cleanError(err) || `yt-dlp çıkış kodu ${code}`), { raw: err }));
      }
      try {
        const raw = Buffer.concat(out);
        const summary = summarize(JSON.parse(raw.toString('utf8')));
        if (!summary.isPlaylist) {
          // Saved so the download can skip a second extraction (--load-info-json).
          const file = path.join(paths.tempDir, `info-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
          fs.writeFileSync(file, raw);
          summary.infoJson = file;
          summary.fetchedAt = Date.now();
        }
        resolve(summary);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Common yt-dlp failures in plain Turkish, with what to do about them.
const FRIENDLY = [
  [/cookie database|decrypt|cookies from browser/i, 'Tarayıcı oturumu okunamadı. Tarayıcıyı kapatıp tekrar dene ya da ayarlardan Firefox seç.'],
  [/registered users|log ?in|sign in|account credentials|cookies/i, 'Bu içerik giriş istiyor. Ayarlar → "Giriş isteyen siteler"den tarayıcını seç.'],
  [/unsupported url/i, 'Bu link desteklenmiyor ya da bir video sayfası değil.'],
  [/private video|video unavailable|not available|has been removed|does not exist|404/i, 'Video bulunamadı: silinmiş, gizli ya da bölgende kapalı olabilir.'],
  [/http error 403|forbidden/i, 'Site indirmeyi engelledi. Ayarlardan yt-dlp\'yi güncelleyip tekrar dene.'],
  [/timed out|getaddrinfo|connection|network is unreachable|unable to download webpage/i, 'Bağlantı hatası. İnternetini kontrol edip tekrar dene.'],
  [/no space left|disk full/i, 'Diskte yer kalmadı.'],
  [/permission denied|access is denied/i, 'Bu klasöre yazılamıyor. Başka bir klasör seç.'],
];

function friendly(raw) {
  const hit = FRIENDLY.find(([re]) => re.test(raw));
  return hit ? hit[1] : raw;
}

function cleanError(stderr) {
  return friendly(rawError(stderr));
}

function rawError(stderr) {
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = [...lines].reverse().find((l) => l.startsWith('ERROR:')) || lines[lines.length - 1] || '';
  return errLine
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
    .slice(0, 300);
}

// ---------- downloads ----------
//
// Downloads run one at a time; the rest wait in a queue ("queued").

const jobs = new Map();
const events = new EventEmitter();
let nextId = 1;

function publicJob(j) {
  const { child, launch, ...rest } = j;
  return rest;
}

function emit() {
  events.emit('jobs', [...jobs.values()].map(publicJob));
}

const DL = '[pitaya-dl]';
const PP = '[pitaya-pp]';
const FMT = '[pitaya-fmt]';
const FILE = '[pitaya-file]';

// Audio formats extract the sound track. M4A and Opus pick a matching source
// stream when there is one, so they are usually copied without re-encoding.
const AUDIO = {
  mp3: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  m4a: ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0'],
  opus: ['-f', 'ba[acodec^=opus]/ba/b', '-x', '--audio-format', 'opus', '--audio-quality', '0'],
  flac: ['-f', 'ba/b', '-x', '--audio-format', 'flac'],
  wav: ['-f', 'ba/b', '-x', '--audio-format', 'wav'],
};
const FORMATS = ['mp4', ...Object.keys(AUDIO)];
const isAudio = (format) => Object.prototype.hasOwnProperty.call(AUDIO, format);

function formatArgs(format, quality) {
  if (isAudio(format)) {
    const args = [...AUDIO[format], '--embed-metadata'];
    // Cover art: the video thumbnail as JPG. WAV files can't hold one.
    if (format !== 'wav') args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    return args;
  }
  const sort = quality === 'best' ? 'res,vcodec:h264,acodec:aac' : `res:${quality},vcodec:h264,acodec:aac`;
  return ['-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--embed-metadata'];
}

// Adds a download to the queue. infoJson: file from fetchInfo; using it skips
// a second ~5 s extraction.
function start({ url, format, quality, folder, title, key, thumbnail, infoJson, useCookies }) {
  if (!FORMATS.includes(format)) throw new Error(`Bilinmeyen biçim: ${format}`);
  const id = nextId++;
  jobs.set(id, {
    id,
    url,
    key: key || null,
    format,
    quality: isAudio(format) ? null : quality,
    folder,
    title: title || url,
    thumbnail: thumbnail || null,
    listTitle: null, // playlist name, when the link is a playlist
    index: 0, // current video in a playlist (1-based)
    count: 0, // videos in the playlist; 0 for a single video
    state: 'queued', // queued | starting | downloading | processing | done | error | canceled
    progress: 0,
    speed: null,
    eta: null,
    file: null,
    error: null,
    parts: 1,
    part: 0,
    startedAt: null,
    launch: { infoJson, useCookies },
  });
  emit();
  pump();
  return id;
}

// Starts the next queued download when nothing is running.
function pump() {
  const all = [...jobs.values()];
  if (all.some((j) => j.child)) return;
  const next = all.find((j) => j.state === 'queued');
  if (next) launch(next);
}

function fail(job, message) {
  Object.assign(job, { state: 'error', error: message, child: null });
  emit();
  events.emit('finished', publicJob(job));
  pump();
}

function launch(job) {
  const { id, url, format, quality, folder } = job;
  const { infoJson, useCookies } = job.launch;
  Object.assign(job, { state: 'starting', startedAt: Date.now() });
  emit();

  const tmp = path.join(paths.tempDir, `job-${id}`);
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (e) {
    log.error('folder unusable', folder, e.message);
    return fail(job, 'Klasör oluşturulamadı ya da yazılamıyor. Başka bir klasör seç.');
  }

  const args = [
    ...formatArgs(format, quality),
    '-P', folder,
    '-P', `temp:${tmp}`,
    '-o', '%(title).180B.%(ext)s',
    '--no-mtime',
    '--newline',
    '--progress',
    '--no-simulate',
    '--progress-template',
    `download:${DL}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`,
    '--progress-template',
    `postprocess:${PP}%(progress.postprocessor)s`,
    // Title goes last: it may contain "|".
    '--print',
    `before_dl:${FMT}%(format_id)s|%(playlist_index)s|%(n_entries,playlist_count)s|%(extractor_key)s:%(id)s|%(webpage_url)s|%(thumbnail)s|%(title)s`,
    '--print', `after_move:${FILE}%(filepath)s`,
  ];

  // Saved info is fresh enough for an hour (stream links expire after a few).
  let jsonOk = false;
  try {
    jsonOk = !!infoJson && Date.now() - fs.statSync(infoJson).mtimeMs < 3600 * 1000;
  } catch {}

  const run = (useJson, cookies) => {
    const full = [...baseArgs({ cookies }), ...args, ...(useJson ? ['--load-info-json', infoJson] : ['--', url])];
    log.info('download start', id, format, quality, useJson ? '(saved info)' : '', cookies ? '(browser session)' : '', url);

    const child = spawn(bin.ytdlp, full, { windowsHide: true, env: toolEnv() });
    job.child = child;
    running++;
    let stderr = '';
    let buf = '';
    let lastEmit = 0;
    let lastDone = 0;
    let videoUrl = null; // the current video's own page (differs from url in a playlist)

    const num = (s) => (s && s !== 'NA' && s !== 'None' ? Number(s) : null);
    const str = (s) => (s && s !== 'NA' && s !== 'None' ? s : null);
    // In a playlist the bar shows the whole list, not just the current video.
    const overall = (p) => (job.count > 1 ? (Math.max(job.index, 1) - 1 + p) / job.count : p);

    const onLine = (line) => {
      if (line.startsWith(DL)) {
        const [done, total, est, speed, eta] = line.slice(DL.length).split('|');
        const t = num(total) || num(est);
        const d = num(done) || 0;
        // Byte counter dropping back means the next stream (e.g. audio) started.
        if (d < lastDone && job.part < job.parts - 1) job.part++;
        lastDone = d;
        const frac = t ? Math.min(d / t, 1) : 0;
        job.state = 'downloading';
        job.progress = overall((job.part + frac) / job.parts);
        job.speed = num(speed);
        job.eta = num(eta);
      } else if (line.startsWith(PP)) {
        job.state = 'processing';
        job.progress = overall(1);
        job.speed = null;
        job.eta = null;
      } else if (line.startsWith(FMT)) {
        const [fmt, index, count, key, pageUrl, thumb, ...rest] = line.slice(FMT.length).split('|');
        const n = num(count) || 0;
        if (n > 1) {
          if (!job.listTitle) job.listTitle = job.title;
          job.count = n;
          job.index = num(index) || job.index + 1;
        }
        if (key && !/^(NA|None):|:(NA|None)$/.test(key)) job.key = key;
        videoUrl = str(pageUrl);
        if (str(thumb) && (n > 1 || !job.thumbnail)) job.thumbnail = str(thumb);
        job.title = rest.join('|') || job.title;
        job.parts = fmt.split('+').length;
        job.part = 0;
        lastDone = 0;
      } else if (line.startsWith(FILE)) {
        job.file = line.slice(FILE.length).trim();
        history.add({
          url: job.count > 1 ? videoUrl : url,
          key: job.key,
          title: job.title,
          thumbnail: job.thumbnail,
          format,
          quality: job.quality,
          folder,
          file: job.file,
        });
      } else {
        return;
      }
      const now = Date.now();
      if (now - lastEmit > 150) {
        lastEmit = now;
        emit();
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.search(/\r?\n|\r/)) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + (buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1));
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    let finished = false;
    const finish = (code) => {
      if (finished) return; // 'error' and 'close' can both fire
      finished = true;
      running--;
      if (code !== 0 && job.state !== 'canceled') {
        let retry = null;
        if (useJson) retry = [false, cookies]; // saved links may have expired
        else if (!cookies && canUseCookies(stderr)) retry = [false, true]; // site wants a login
        if (retry) {
          log.warn('download failed, retrying', id, retry[1] ? 'with browser session' : 'from url', stderr.slice(-500));
          Object.assign(job, { state: 'starting', progress: 0, speed: null, eta: null, part: 0, index: 0 });
          emit();
          return run(...retry);
        }
      }
      fs.rm(tmp, { recursive: true, force: true }, () => {});
      job.child = null;
      if (job.state === 'canceled') {
        emit();
        return pump();
      }
      if (code === 0) {
        job.state = 'done';
        job.progress = 1;
        log.info('download done', id, job.file);
        // The playlist link itself, so copying it again shows "already downloaded".
        if (job.count > 1 && job.file) {
          history.add({
            url,
            key: null,
            title: job.listTitle,
            thumbnail: job.thumbnail,
            format,
            quality: job.quality,
            folder,
            file: job.file,
            count: job.count,
          });
        }
      } else {
        job.state = 'error';
        job.error = cleanError(stderr) || `yt-dlp çıkış kodu ${code}`;
        log.error('download failed', id, url, stderr.slice(-2000));
      }
      emit();
      events.emit('finished', publicJob(job));
      pump();
    };
    child.on('error', (e) => {
      stderr += e.message;
      finish(-1);
    });
    child.on('close', finish);
  };

  run(jsonOk, !!useCookies);
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.state === 'queued') {
    job.state = 'canceled';
    return emit();
  }
  if (!job.child) return;
  job.state = 'canceled';
  killTree(job.child);
  emit();
}

const FINISHED = ['done', 'error', 'canceled'];
const isFinished = (j) => !j.child && FINISHED.includes(j.state);

function dismiss(id) {
  const job = jobs.get(id);
  if (job && isFinished(job)) {
    jobs.delete(id);
    emit();
  }
}

function clearFinished() {
  for (const [id, j] of jobs) if (isFinished(j)) jobs.delete(id);
  emit();
}

// Running or waiting in the queue.
const activeCount = () => [...jobs.values()].filter((j) => !isFinished(j)).length;

module.exports = {
  fetchInfo,
  start,
  cancel,
  dismiss,
  clearFinished,
  activeCount,
  isBusy: () => running > 0,
  isAudio,
  FORMATS,
  events,
  list: () => [...jobs.values()].map(publicJob),
  get: (id) => jobs.get(id),
};
