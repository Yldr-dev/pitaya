// Narrow, whitelisted bridge between the pages and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = [
  'popup:resize', 'popup:cancel', 'popup:choose',
  'progress:resize', 'progress:hide', 'progress:settings', 'progress:history',
  'progress:cancel', 'progress:dismiss', 'progress:open', 'progress:play', 'progress:retry',
  'settings:suspendHotkey', 'settings:openData', 'settings:openLog', 'settings:openHistory', 'settings:repairComponents',
  'history:open', 'history:reveal', 'history:remove', 'history:redownload',
  'files:resize', 'files:cancel', 'files:run',
  'toast:resize', 'toast:close', 'toast:open', 'toast:undo',
];
const INVOKE = [
  'popup:pickFolder', 'progress:state',
  'settings:get', 'settings:versions', 'settings:pickFolder', 'settings:save', 'settings:setHotkey',
  'settings:checkUpdate', 'settings:updateYtdlp',
  'history:list', 'history:clear',
  'files:pickFolder',
];
const ON = [
  'popup:show', 'popup:info',
  'progress:jobs', 'progress:components', 'progress:update', 'progress:meta',
  'settings:components', 'settings:update', 'settings:historyCount',
  'history:changed',
  'files:show', 'toast:show',
];

contextBridge.exposeInMainWorld('pitaya', {
  send(channel, data) {
    if (SEND.includes(channel)) ipcRenderer.send(channel, data);
  },
  invoke(channel, data) {
    if (!INVOKE.includes(channel)) return Promise.reject(new Error('blocked'));
    return ipcRenderer.invoke(channel, data);
  },
  on(channel, cb) {
    if (ON.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
