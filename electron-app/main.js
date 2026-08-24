// 趣AI味 · Electron 主进程（仅负责开窗口加载本地 Web 构建，无 Rust）
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");

// 单实例锁：防止双击图标开多个窗口（改用已有实例聚焦）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerSecureStore();
  createWindowWhenReady();

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindowWhenReady() {
  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

/* ----------------------------- 安全存储（safeStorage 加密 API Key） ----------------------------- */
// 在桌面版上把 API Key 用系统级加密落盘到 userData/secure-config.json，
// 而非明文 localStorage。Web 版仍用 localStorage（见 store.ts 检测 bridge）。
const SECURE_FILE = path.join(app.getPath("userData"), "secure-config.json");

function readSecureStore() {
  try {
    return JSON.parse(fs.readFileSync(SECURE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// 读改写串行化：并发 set 相互覆盖会丢更新，这里排队逐个落盘
let writeChain = Promise.resolve();

function writeSecureStore(data) {
  writeChain = writeChain.then(() => {
    fs.writeFileSync(SECURE_FILE, JSON.stringify(data), "utf8");
  });
  return writeChain;
}

function registerSecureStore() {
  if (!safeStorage.isEncryptionAvailable()) return; // 系统不支持加密时跳过，退回 localStorage

  ipcMain.handle("secure-store-get", (_event, key) => {
    const enc = readSecureStore()[key];
    if (!enc) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      return null; // 损坏/迁移后清零
    }
  });

  ipcMain.handle("secure-store-set", (_event, key, value) => {
    const data = readSecureStore();
    if (!value) {
      delete data[key];
    } else {
      data[key] = safeStorage.encryptString(String(value)).toString("base64");
    }
    writeSecureStore(data);
    return true;
  });
}

/* ----------------------------- 窗口创建 ----------------------------- */

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: "#0f1117",
    title: "趣AI味 · QuAiWei",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // 加载打包进来的 Web 构建（dist 内容）
  win.loadFile(path.join(__dirname, "index.html"));

  // 隐藏默认菜单，更像原生产品
  win.setMenuBarVisibility(false);

  // 安全：外部链接一律在系统浏览器打开，绝不在应用窗口内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      require("electron").shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // 安全：拦截窗口内任何页内导航
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
}