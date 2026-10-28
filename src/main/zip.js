// Minimal streaming ZIP writer (no extra dependency). Names are stored as
// UTF-8 so Turkish characters survive in Windows Explorer and other tools.
// No ZIP64: archives and files over 4 GB are refused.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LIMIT = 0xffffffff;
// Already-compressed files: deflate barely helps, so spend little CPU on them.
const PACKED = /\.(jpe?g|png|gif|webp|heic|avif|mp4|mkv|webm|mov|avi|mp3|m4a|aac|opus|ogg|flac|zip|rar|7z|gz|xz|bz2|docx|xlsx|pptx|pdf)$/i;

let crcTable = null;
function crc32js(buf, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
const crc32 = zlib.crc32 || crc32js;

function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Files and folders (recursively) as zip entries, named relative to their
// own parent, so "C:\a\photos" becomes "photos/…".
async function collect(items) {
  const out = [];
  async function walk(abs, name) {
    const st = await fs.promises.lstat(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      out.push({ abs, name: name + '/', dir: true, mtime: st.mtime, size: 0 });
      const list = await fs.promises.readdir(abs);
      for (const child of list) await walk(path.join(abs, child), `${name}/${child}`);
    } else if (st.isFile()) {
      out.push({ abs, name, dir: false, mtime: st.mtime, size: st.size });
    }
  }
  const used = new Set();
  for (const item of items) {
    let base = path.basename(item);
    // Two selected items with the same name from different folders.
    for (let i = 2; used.has(base.toLowerCase()); i++) base = `${path.parse(path.basename(item)).name} (${i})${path.extname(item)}`;
    used.add(base.toLowerCase());
    await walk(item, base);
  }
  return out;
}

async function createZip(items, outFile, onProgress = () => {}) {
  const entries = await collect(items);
  const total = entries.reduce((s, e) => s + e.size, 0);
  if (entries.some((e) => e.size >= LIMIT) || total >= LIMIT) throw new Error('ZIP 4 GB’tan büyük olamaz');
  if (entries.length >= 0xffff) throw new Error('ZIP için çok fazla dosya var');

  const ws = fs.createWriteStream(outFile, { flags: 'wx' });
  let offset = 0;
  let failed = null;
  ws.on('error', (e) => (failed = e));
  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (failed) return reject(failed);
      offset += buf.length;
      if (ws.write(buf)) return resolve();
      const onDrain = () => {
        ws.off('error', onError);
        resolve();
      };
      const onError = (e) => {
        ws.off('drain', onDrain);
        reject(e);
      };
      ws.once('drain', onDrain);
      ws.once('error', onError);
    });

  const central = [];
  let doneBytes = 0;
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
      const { time, date } = dosTime(e.mtime);
      const flags = e.dir ? 0x0800 : 0x0808; // UTF-8 names; sizes follow the data
      const method = e.dir ? 0 : 8;
      const start = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      await write(local);
      await write(name);

      let crc = 0;
      let csize = 0;
      let usize = 0;
      if (!e.dir) {
        const deflate = zlib.createDeflateRaw({ level: PACKED.test(e.name) ? 1 : 6 });
        const rs = fs.createReadStream(e.abs);
        rs.on('error', (err) => deflate.destroy(err));
        rs.on('data', (c) => {
          crc = crc32(c, crc);
          usize += c.length;
          doneBytes += c.length;
          onProgress(total ? doneBytes / total : 1);
        });
        rs.pipe(deflate);
        for await (const chunk of deflate) {
          csize += chunk.length;
          await write(chunk);
        }
        const desc = Buffer.alloc(16);
        desc.writeUInt32LE(0x08074b50, 0);
        desc.writeUInt32LE(crc, 4);
        desc.writeUInt32LE(csize, 8);
        desc.writeUInt32LE(usize, 12);
        await write(desc);
      }
      if (offset >= LIMIT) throw new Error('ZIP 4 GB’tan büyük olamaz');

      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(flags, 8);
      c.writeUInt16LE(method, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(csize, 20);
      c.writeUInt32LE(usize, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE(e.dir ? 0x10 : 0x20, 38); // DOS attributes: folder / archive
      c.writeUInt32LE(start, 42);
      central.push(c, name);
    }

    const cdStart = offset;
    for (const b of central) await write(b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await write(end);
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    if (failed) throw failed;
  } catch (e) {
    ws.destroy();
    await fs.promises.rm(outFile, { force: true }).catch(() => {});
    throw e;
  }
  return { file: outFile, count: entries.filter((e) => !e.dir).length };
}

module.exports = { createZip };
