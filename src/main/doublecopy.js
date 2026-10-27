// Notices when the user copies twice in a row (Ctrl+C, Ctrl+C).
//
// Windows bumps a clipboard counter on every copy, even when the copied text
// is the same, so watching that counter is enough: no keyboard hook, and it
// also works with "Copy" from a right-click menu.
const log = require('./log');

const TICK = 40; // ms between checks
const BURST = 70; // one copy can bump the counter several times within this
const WINDOW = 600; // max gap between the two copies

let api; // undefined: not loaded yet, false: unavailable
function native() {
  if (api !== undefined) return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    api = {
      seq: user32.func('uint32 __stdcall GetClipboardSequenceNumber()'),
      foreground: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      threadOf: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, intptr_t lpdwProcessId)'),
      attach: user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'),
      setForeground: user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'),
      toTop: user32.func('bool __stdcall BringWindowToTop(intptr_t hWnd)'),
      myThread: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
    };
  } catch (e) {
    log.warn('native helpers unavailable', e.message);
    api = false;
  }
  return api;
}

let timer = null;

function start(onDouble) {
  stop();
  const n = native();
  if (!n) return false;
  let last = n.seq();
  let lastChange = 0;
  let pending = 0; // time of a first copy waiting for its second
  timer = setInterval(() => {
    const s = n.seq();
    if (s === last) return;
    last = s;
    const now = Date.now();
    const sameCopy = now - lastChange < BURST;
    lastChange = now;
    if (sameCopy) return;
    if (pending && now - pending <= WINDOW) {
      pending = 0; // a third quick copy starts over instead of firing again
      onDouble();
    } else {
      pending = now;
    }
  }, TICK);
  return true;
}

function stop() {
  clearInterval(timer);
  timer = null;
}

// Windows only lets the app the user is typing in bring windows to the front.
// A copy isn't a hotkey, so borrow the foreground app's input state for a
// moment to hand focus to our window.
function bringToFront(win) {
  const n = native();
  if (!n || !win || win.isDestroyed()) return false;
  try {
    const buf = win.getNativeWindowHandle();
    const hwnd = Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
    const fg = n.foreground();
    const theirs = fg ? n.threadOf(fg, 0) : 0;
    const mine = n.myThread();
    const attached = theirs && theirs !== mine && n.attach(mine, theirs, true);
    n.toTop(hwnd);
    const ok = n.setForeground(hwnd);
    if (attached) n.attach(mine, theirs, false);
    return ok;
  } catch (e) {
    log.warn('bringToFront failed', e.message);
    return false;
  }
}

module.exports = { start, stop, bringToFront, available: () => !!native() };
