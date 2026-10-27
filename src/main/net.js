// Download + unzip helpers. Uses Electron's network stack so system proxy
// settings are respected on any computer.
// original-fs: Electron's own fs treats any "*.asar" path as an archive, so it
// can't write the app.asar inside a Pitaya update zip ("Invalid package").
const fs = require('original-fs');
const path = require('path');
const { net } = require('electron');
const yauzl = require('yauzl');

const UA = 'Pitaya-App';

async function fetchJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Streams url -> dest (via a .part file). onProgress(fraction 0..1 | null).
async function downloadFile(url, dest, onProgress) {
  const part = dest + '.part';
  const res = await net.fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastReport = 0;

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(part);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      received += value.length;
      const now = Date.now();
      if (onProgress && now - lastReport > 200) {
        lastReport = now;
        onProgress(total ? received / total : null);
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  if (total && received !== total) {
    fs.rmSync(part, { force: true });
    throw new Error(`Eksik indirme (${received}/${total} bayt)`);
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
  onProgress && onProgress(1);
}

// Extracts entries of zipFile. pick(entryPath) returns the destination path
// for an entry, or null to skip it.
function extractZip(zipFile, pick) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        const target = name.endsWith('/') ? null : pick(name);
        if (!target) return zip.readEntry();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return reject(e2);
          const out = fs.createWriteStream(target);
          stream.on('error', reject);
          out.on('error', reject);
          out.on('finish', () => zip.readEntry());
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { fetchJson, downloadFile, extractZip };
