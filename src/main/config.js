// User settings stored as JSON in the data folder.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const paths = require('./paths');
const log = require('./log');

function defaultFolders() {
  const list = [];
  const add = (name, key) => {
    try {
      list.push({ name, path: app.getPath(key) });
    } catch {}
  };
  add('İndirilenler', 'downloads');
  add('Müzik', 'music');
  add('Videolar', 'videos');
  return list;
}

function defaults() {
  return {
    hotkey: 'Ctrl+Alt+P',
    folders: defaultFolders(),
    lastFormat: 'mp4',
    lastQuality: 'best',
    lastFolder: 0,
    openAtLogin: true,
    autoUpdate: true,
    cookiesBrowser: '', // '' | firefox | chrome | edge | brave | opera | vivaldi
  };
}

let current = null;

function load() {
  const base = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
    current = { ...base, ...raw };
    if (!Array.isArray(current.folders)) current.folders = base.folders;
    current.folders = current.folders.filter((f) => f && typeof f.path === 'string' && f.path);
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('config unreadable, using defaults', e.message);
    current = base;
    save();
  }
  return current;
}

function save() {
  const tmp = paths.configFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8');
  fs.renameSync(tmp, paths.configFile);
}

function get() {
  return current || load();
}

function update(patch) {
  current = { ...get(), ...patch };
  save();
  return current;
}

module.exports = { get, update, load, folderName: (p) => path.basename(p) || p };
