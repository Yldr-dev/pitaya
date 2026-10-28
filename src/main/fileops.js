// File panel actions: move/copy to a folder, gather into a new folder, sort by
// type, zip, batch rename. Each one remembers what it did so it can be undone.
// Nothing is ever overwritten: a name that is taken gets " (2)", " (3)"…
const fs = require('fs');
const path = require('path');
const { createZip } = require('./zip');

const fsp = fs.promises;

const CATEGORIES = [
  ['Fotoğraflar', /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg|ico|raw|cr2|nef|arw|dng|psd)$/i],
  ['Videolar', /\.(mp4|mkv|webm|mov|avi|wmv|flv|m4v|3gp|ts|mts)$/i],
  ['Müzik', /\.(mp3|m4a|aac|opus|ogg|flac|wav|wma|aiff?)$/i],
  ['Belgeler', /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|csv|epub)$/i],
  ['Arşivler', /\.(zip|rar|7z|tar|gz|tgz|xz|bz2|iso)$/i],
  ['Programlar', /\.(exe|msi|msix|appx|bat|cmd)$/i],
];
const OTHER = 'Diğer';

function categoryOf(file) {
  const hit = CATEGORIES.find(([, re]) => re.test(file));
  return hit ? hit[0] : OTHER;
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

// "photo.jpg" -> "photo (2).jpg" until the name is free in dir.
async function freeName(dir, name, taken = new Set()) {
  const { name: stem, ext } = path.parse(name);
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()) || (await exists(path.join(dir, candidate))); i++) {
    candidate = `${stem} (${i})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return path.join(dir, candidate);
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

async function move(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Another drive: copy, then remove the original.
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

async function copy(from, to) {
  await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
}

function errorText(e) {
  const map = {
    EBUSY: 'dosya başka bir programda açık',
    EPERM: 'izin yok ya da dosya kullanımda',
    EACCES: 'erişim izni yok',
    ENOSPC: 'diskte yer kalmadı',
    ENOENT: 'dosya bulunamadı',
    EEXIST: 'aynı adda dosya var',
    ENAMETOOLONG: 'dosya yolu çok uzun',
  };
  return map[e.code] || e.message;
}

// ---------------- summary for the panel ----------------

async function describe(files) {
  const items = [];
  for (const f of files) {
    try {
      const st = await fsp.stat(f);
      items.push({ path: f, name: path.basename(f) || f, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size });
    } catch {
      // Gone since it was copied: leave it out.
    }
  }
  return {
    items,
    files: items.filter((i) => !i.dir).length,
    folders: items.filter((i) => i.dir).length,
    bytes: items.reduce((s, i) => s + i.size, 0),
    parent: items.length ? path.dirname(items[0].path) : null,
  };
}

// ---------------- actions ----------------
// Each returns { done, failed: [{ name, error }], undo, ...extra }.
// `undo` describes how to put things back: moves to reverse, created files
// to send to the Recycle Bin and folders to remove when empty.

async function transfer(items, dest, mode, onProgress = () => {}) {
  const undo = { moves: [], created: [], dirs: [] };
  const failed = [];
  let done = 0;
  let skipped = 0;
  const taken = new Set();
  let destReady = false;
  for (let i = 0; i < items.length; i++) {
    const from = items[i];
    onProgress(i / items.length);
    const name = path.basename(from);
    try {
      if (same(from, dest) || inside(dest, from)) throw Object.assign(new Error('klasör kendi içine taşınamaz'), { code: 'SELF' });
      if (mode === 'move' && same(path.dirname(from), dest)) {
        skipped++; // already there
        continue;
      }
      if (!destReady) {
        await fsp.mkdir(dest, { recursive: true });
        destReady = true;
      }
      const to = await freeName(dest, name, taken);
      if (mode === 'move') {
        await move(from, to);
        undo.moves.push({ from, to });
      } else {
        await copy(from, to);
        undo.created.push(to);
      }
      done++;
    } catch (e) {
      failed.push({ name, error: errorText(e) });
    }
  }
  onProgress(1);
  return { done, skipped, failed, undo };
}

// Move the items into a new folder next to them.
async function gather(items, folderName) {
  const parent = path.dirname(items[0]);
  const dir = await freeName(parent, cleanName(folderName) || 'Yeni klasör');
  await fsp.mkdir(dir);
  const r = await transfer(items, dir, 'move');
  r.undo.dirs.push(dir);
  return { ...r, dir };
}

// Move each file into Fotoğraflar / Videolar / … next to it. Folders stay.
async function sortByType(items) {
  const undo = { moves: [], created: [], dirs: [] };
  const failed = [];
  const counts = {};
  let done = 0;
  for (const from of items) {
    const name = path.basename(from);
    try {
      if ((await fsp.stat(from)).isDirectory()) continue;
      const cat = categoryOf(name);
      const dir = path.join(path.dirname(from), cat);
      if (!(await exists(dir))) {
        await fsp.mkdir(dir);
        undo.dirs.push(dir);
      }
      const to = await freeName(dir, name);
      await move(from, to);
      undo.moves.push({ from, to });
      counts[cat] = (counts[cat] || 0) + 1;
      done++;
    } catch (e) {
      failed.push({ name, error: errorText(e) });
    }
  }
  return { done, failed, undo, counts, parent: path.dirname(items[0]) };
}

async function zip(items, zipName, onProgress) {
  const parent = path.dirname(items[0]);
  let base = cleanName(zipName) || 'Arşiv';
  if (!/\.zip$/i.test(base)) base += '.zip';
  const file = await freeName(parent, base);
  const r = await createZip(items, file, onProgress);
  return { done: r.count, failed: [], undo: { moves: [], created: [file], dirs: [] }, file };
}

// "tatil" -> tatil_01.jpg, tatil_02.jpg … in the order given.
async function rename(items, base, start = 1) {
  base = cleanName(base);
  if (!base) throw new Error('Yeni ad boş olamaz');
  const width = Math.max(2, String(start + items.length - 1).length);
  const plan = items.map((from, i) => {
    const isDir = fs.existsSync(from) && fs.statSync(from).isDirectory();
    const ext = isDir ? '' : path.extname(from);
    return { from, name: `${base}_${String(start + i).padStart(width, '0')}${ext}` };
  });
  const undo = { moves: [], created: [], dirs: [] };
  const failed = [];
  // Two steps, so "a_02" -> "a_01" style swaps inside the set never collide.
  const staged = [];
  for (const p of plan) {
    const tmp = path.join(path.dirname(p.from), `.pitaya-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      await fsp.rename(p.from, tmp);
      staged.push({ ...p, tmp });
    } catch (e) {
      failed.push({ name: path.basename(p.from), error: errorText(e) });
    }
  }
  const taken = new Map(); // dir -> Set of names used in this batch
  for (const s of staged) {
    const dir = path.dirname(s.from);
    if (!taken.has(dir)) taken.set(dir, new Set());
    let to = s.from;
    try {
      to = await freeName(dir, s.name, taken.get(dir));
      await fsp.rename(s.tmp, to);
      undo.moves.push({ from: s.from, to });
    } catch (e) {
      await fsp.rename(s.tmp, s.from).catch(() => {});
      failed.push({ name: path.basename(s.from), error: errorText(e) });
    }
  }
  return { done: undo.moves.length, failed, undo };
}

function previewNames(items, base, start = 1) {
  base = cleanName(base);
  const width = Math.max(2, String(start + items.length - 1).length);
  return items.map((it, i) => `${base || '…'}_${String(start + i).padStart(width, '0')}${it.dir ? '' : path.extname(it.name)}`);
}

// Characters Windows doesn't allow in names.
function cleanName(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120);
}

// ---------------- undo ----------------

async function undo(u, trash) {
  const failed = [];
  let done = 0;
  for (const m of [...u.moves].reverse()) {
    try {
      const back = (await exists(m.from)) ? await freeName(path.dirname(m.from), path.basename(m.from)) : m.from;
      await fsp.mkdir(path.dirname(back), { recursive: true });
      await move(m.to, back);
      done++;
    } catch (e) {
      failed.push({ name: path.basename(m.to), error: errorText(e) });
    }
  }
  for (const f of u.created) {
    try {
      if (await exists(f)) await trash(f);
      done++;
    } catch (e) {
      failed.push({ name: path.basename(f), error: errorText(e) });
    }
  }
  for (const d of [...u.dirs].reverse()) {
    await fsp.rmdir(d).catch(() => {}); // only when empty
  }
  return { done, failed };
}

module.exports = { describe, transfer, gather, sortByType, zip, rename, previewNames, undo, cleanName, categoryOf };
