const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pi", {
  request: (action, value) => ipcRenderer.invoke("pi:request", action, value),
  onEvent: (listener) => { ipcRenderer.on("pi:event", (_event, value) => listener(value)); },
});
