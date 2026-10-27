// Finished downloads: shown in Settings → Geçmiş, and used by the popup to
// say "you already downloaded this" (only when the file still exists).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const paths = require('./paths');
const log = require('./log');

const MAX = 500;
const events = new EventEmitter(); // 'changed'
let list = null;
let lastId = 0;

// Increasing ids, unique even when two entries share a millisecond.
function newId() {
  lastId = Math.max(lastId + 1, Date.now());
  return lastId;
}

function load() {
  if (list) return list;
  try {
    list = JSON.parse(fs.readFileSync(paths.historyFile, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('history unreadable', e.message);
    list = [];
  }
  list = list.filter((r) => r && r.file);
  for (const r of list) {
    if (!r.id) r.id = newId(); // entries from 0.2.x had no id
    else lastId = Math.max(lastId, r.id);
  }
  return list;
}

function save() {
  const tmp = paths.historyFile + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
    fs.renameSync(tmp, paths.historyFile);
  } catch (e) {
    log.warn('history save failed', e.message);
  }
  events.emit('changed');
}

function add(rec) {
  load();
  list.push({ ...rec, id: newId(), at: Date.now() });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  save();
}

// Latest download of this link (or of the same video under another link).
function find(url, key) {
  load();
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (((url && r.url === url) || (key && r.key === key)) && r.file && fs.existsSync(r.file)) return r;
  }
  return null;
}

// Newest first, with whether the file is still there.
function all() {
  return load()
    .slice()
    .reverse()
    .map((r) => ({ ...r, folder: r.folder || path.dirname(r.file), exists: fs.existsSync(r.file) }));
}

const get = (id) => load().find((r) => r.id === id) || null;

function remove(id) {
  load();
  const i = list.findIndex((r) => r.id === id);
  if (i >= 0) {
    list.splice(i, 1);
    save();
  }
}

function clear() {
  list = [];
  save();
}

module.exports = { add, find, all, get, remove, clear, events };
