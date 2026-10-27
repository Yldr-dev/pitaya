// Finished downloads, kept so the popup can say "you already downloaded this".
// Only entries whose file still exists count.
const fs = require('fs');
const paths = require('./paths');
const log = require('./log');

const MAX = 300;
let list = null;

function load() {
  if (list) return list;
  try {
    list = JSON.parse(fs.readFileSync(paths.historyFile, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('history unreadable', e.message);
    list = [];
  }
  return list;
}

function save() {
  const tmp = paths.historyFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
  fs.renameSync(tmp, paths.historyFile);
}

function add(rec) {
  load();
  list.push({ ...rec, at: Date.now() });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  try {
    save();
  } catch (e) {
    log.warn('history save failed', e.message);
  }
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

module.exports = { add, find };
