// 安全存储桥接：通过 contextBridge 暴露 safeStorage 加密存储 API 到渲染进程
// 仅限 Electron 桌面版使用；Web 版（无 window.secureStore）回退到 localStorage。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("secureStore", {
  get: (key) => ipcRenderer.invoke("secure-store-get", key),
  set: (key, value) => ipcRenderer.invoke("secure-store-set", key, value),
});