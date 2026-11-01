/* The only door between the pages and the main process. Every channel is
   named here; anything else is refused. */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'panel:init', 'panel:sources', 'settings:set', 'rec:start', 'notes:get', 'state:get',
]);
const SEND = new Set([
  'engine:reply', 'engine:autostop', 'take:chunk', 'bar:cmd', 'notes:set',
  'win:notes', 'win:templates', 'win:library', 'win:folder', 'win:close', 'win:minimize',
]);
const LISTEN = new Set([
  'engine:call', 'rec:state', 'panel:banner', 'notes:state', 'countdown:tick',
]);

contextBridge.exposeInMainWorld('penguDesktop', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`blocked: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on(channel, fn) {
    if (!LISTEN.has(channel)) return () => {};
    const handler = (e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
