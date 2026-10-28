// Win32 helpers for the file panel:
//  - which files are on the clipboard, and whether they were cut or copied
//  - which removable drives (USB sticks) are plugged in
const log = require('./log');

const CF_HDROP = 15;
const DROPEFFECT_MOVE = 2;
const DRIVE_REMOVABLE = 2;

let api; // undefined: not loaded yet, false: unavailable
function native() {
  if (api !== undefined) return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const shell32 = koffi.load('shell32.dll');
    api = {
      koffi,
      open: user32.func('bool __stdcall OpenClipboard(intptr_t hWndNewOwner)'),
      close: user32.func('bool __stdcall CloseClipboard()'),
      has: user32.func('bool __stdcall IsClipboardFormatAvailable(uint32 format)'),
      getData: user32.func('void * __stdcall GetClipboardData(uint32 uFormat)'),
      registerFormat: user32.func('uint32 __stdcall RegisterClipboardFormatW(const char16_t *lpszFormat)'),
      lock: kernel32.func('void * __stdcall GlobalLock(void *hMem)'),
      unlock: kernel32.func('bool __stdcall GlobalUnlock(void *hMem)'),
      dragQuery: shell32.func('uint32 __stdcall DragQueryFileW(void *hDrop, uint32 iFile, _Out_ void *lpszFile, uint32 cch)'),
      drives: kernel32.func('uint32 __stdcall GetLogicalDrives()'),
      driveType: kernel32.func('uint32 __stdcall GetDriveTypeW(const char16_t *lpRootPathName)'),
      volumeInfo: kernel32.func(
        'bool __stdcall GetVolumeInformationW(const char16_t *root, _Out_ void *name, uint32 nameSize, void *serial, void *maxLen, void *flags, void *fsName, uint32 fsNameSize)'
      ),
      errorMode: kernel32.func('uint32 __stdcall SetErrorMode(uint32 uMode)'),
    };
    api.dropEffectFormat = api.registerFormat('Preferred DropEffect');
  } catch (e) {
    log.warn('file helpers unavailable', e.message);
    api = false;
  }
  return api;
}

// Another app may hold the clipboard for a moment right after a copy.
function openClipboard(n) {
  for (let i = 0; i < 5; i++) {
    if (n.open(0)) return true;
    const until = Date.now() + 15;
    while (Date.now() < until); // tiny busy wait; the clipboard is usually free within ms
  }
  return false;
}

// { files: [paths], cut: bool } or null when no files are on the clipboard.
function clipboardFiles() {
  const n = native();
  if (!n || !n.has(CF_HDROP)) return null;
  if (!openClipboard(n)) {
    log.warn('clipboard busy');
    return null;
  }
  try {
    const drop = n.getData(CF_HDROP);
    if (!drop) return null;
    const count = n.dragQuery(drop, 0xffffffff, null, 0);
    const files = [];
    for (let i = 0; i < count; i++) {
      const len = n.dragQuery(drop, i, null, 0);
      const buf = Buffer.alloc((len + 1) * 2);
      const got = n.dragQuery(drop, i, buf, len + 1);
      if (got) files.push(buf.toString('utf16le', 0, got * 2));
    }
    let cut = false;
    if (n.dropEffectFormat && n.has(n.dropEffectFormat)) {
      const h = n.getData(n.dropEffectFormat);
      const p = h && n.lock(h);
      if (p) {
        cut = (n.koffi.decode(p, 'uint32') & DROPEFFECT_MOVE) !== 0;
        n.unlock(h);
      }
    }
    return files.length ? { files, cut } : null;
  } finally {
    n.close();
  }
}

// Plugged-in USB sticks and card readers: [{ root: 'E:\\', label }].
function removableDrives() {
  const n = native();
  if (!n) return [];
  const out = [];
  // Don't let Windows pop up "insert a disk" for empty card readers.
  const prev = n.errorMode(0x8001);
  try {
    const mask = n.drives();
    for (let i = 2; i < 26; i++) {
      if (!(mask & (1 << i))) continue;
      const root = `${String.fromCharCode(65 + i)}:\\`;
      if (n.driveType(root) !== DRIVE_REMOVABLE) continue;
      const name = Buffer.alloc(522);
      // Fails when the slot is empty (card reader without a card).
      if (!n.volumeInfo(root, name, 261, null, null, null, null, 0)) continue;
      const label = name.toString('utf16le').replace(/\0.*$/s, '');
      out.push({ root, label });
    }
  } catch (e) {
    log.warn('drive list failed', e.message);
  } finally {
    n.errorMode(prev);
  }
  return out;
}

module.exports = { clipboardFiles, removableDrives, available: () => !!native() };
