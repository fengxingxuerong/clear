// 安全存储桥接：通过 contextBridge 暴露 safeStorage 加密存储 API 到渲染进程
// 仅限 Electron 桌面版使用；Web 版（无 window.secureStore）回退到 localStorage。
// 同时桥接本地困惑度引擎（ppl-*），Web 版无 window.ppl 自动走 Worker WASM。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("secureStore", {
  get: (key) => ipcRenderer.invoke("secure-store-get", key),
  set: (key, value) => ipcRenderer.invoke("secure-store-set", key, value),
});

contextBridge.exposeInMainWorld("ppl", {
  status: () => ipcRenderer.invoke("ppl-status"),
  download: (onProgress) => {
    // 进度经事件通道推送；返回值只表达最终成败
    const listener = (_event, info) => {
      try {
        onProgress(info);
      } catch {
        /* 回调异常不影响下载 */
      }
    };
    ipcRenderer.on("ppl-progress", listener);
    return ipcRenderer.invoke("ppl-download").finally(() => {
      ipcRenderer.removeListener("ppl-progress", listener);
    });
  },
  score: (windows) => ipcRenderer.invoke("ppl-score", windows),
});
