// 趣AI味 · Electron 主进程（仅负责开窗口加载本地 Web 构建，无 Rust）
const { app, BrowserWindow, ipcMain, safeStorage, session } = require("electron");
const http = require("http");
const { registerPplIpc } = require("./ppl-engine.cjs");

// 内置 SenseNova 网关代理（常驻 LLM 通道的 CORS 解法，自 C 盘副本 v0.6.1 吸收）。
// 网关 token.sensenova.cn 的 OPTIONS 预检返回 404，浏览器直连必挂；
// 桌面版在本机起一个转发服务，页面里 /sensenova/* 的请求被 webRequest 重定向过来，
// 由 Node 侧转发到网关（Node 发请求没有 CORS 概念）。
const UPSTREAM = "https://token.sensenova.cn";

/** 本机转发服务：/sensenova/* → https://token.sensenova.cn/* */
function startProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      };
      // 预检直接放行（网关自己的 OPTIONS 是 404，这正是要代理的原因）
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        return res.end();
      }
      const url = new URL(req.url, "http://127.0.0.1");
      const target = UPSTREAM + url.pathname + url.search;
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const headers = { ...req.headers };
        delete headers.host;
        delete headers.origin;
        delete headers.referer;
        delete headers["content-length"];
        const body = Buffer.concat(chunks);
        fetch(target, {
          method: req.method,
          headers,
          body: body.length ? body : undefined,
        })
          .then(async (up) => {
            res.writeHead(up.status, {
              "Content-Type": up.headers.get("content-type") || "application/json",
              ...cors,
            });
            res.end(Buffer.from(await up.arrayBuffer()));
          })
          .catch((e) => {
            res.writeHead(502, { "Content-Type": "application/json", ...cors });
            res.end(JSON.stringify({ error: { message: "代理转发失败: " + String(e) } }));
          });
      });
    });
    // 端口被占就往后找（多开场景）
    let port = 18964;
    const tryListen = () => {
      server.once("error", () => {
        port++;
        if (port > 18974) return resolve(null);
        tryListen();
      });
      server.listen(port, "127.0.0.1", () => resolve(port));
    };
    tryListen();
  });
}

// 困惑度模型镜像源（设置面板可改）；注册 IPC 前定义，引用稳定对象传给引擎
const pplMirrorRef = { value: null };
const path = require("path");
const fs = require("fs");

// 单实例锁：防止双击图标开多个窗口（改用已有实例聚焦）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerSecureStore();
  registerPplIpc(ipcMain, pplMirrorRef);
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
  // 无论系统是否支持加密都必须注册通道：不注册会让渲染层 invoke 报
  // "No handler registered"。加密不可用时由处理器返回兜底值（退回 localStorage）。

  ipcMain.handle("secure-store-get", (_event, key) => {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const enc = readSecureStore()[key];
    if (!enc) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      return null; // 损坏/迁移后清零
    }
  });

  ipcMain.handle("secure-store-set", (_event, key, value) => {
    if (!safeStorage.isEncryptionAvailable()) return false;
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

  // 页面是 file:// 加载的，fetch("/sensenova/...") 会解析成 file:///sensenova/...，
  // 拦截这类请求重定向到本机转发服务
  startProxy().then((port) => {
    if (port) {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["file:///sensenova/*", "file://*/sensenova/*"] },
        (details, callback) => {
          callback({ redirectURL: `http://127.0.0.1:${port}${details.url.replace(/^file:\/\/[^/]*/, "")}` });
        }
      );
    }
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