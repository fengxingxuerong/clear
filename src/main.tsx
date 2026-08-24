import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { loadApi, loadApiKeySecure, loadDetector, loadDetectorKeySecure } from "./store";
import type { ApiConfig } from "./api/llm";
import type { DetectorConfig } from "./api/detector";
import "./styles.css";

// 桌面版（Electron）：主 API Key 与外部检测器 Key 都通过 window.secureStore
// （safeStorage 加密）加载，避免明文存 localStorage。任一 Key 存在于安全存储时，
// 对应配置对象以 localStorage 内容为底、注入解密后的 Key。
// Web 版：window.secureStore 不存在，走同步 localStorage。
async function bootstrap() {
  let initialApi: ApiConfig | undefined;
  const secureKey = await loadApiKeySecure();
  if (secureKey !== undefined) {
    initialApi = loadApi();
    initialApi.apiKey = secureKey;
  }
  let initialDetector: DetectorConfig | undefined;
  const secureDetectorKey = await loadDetectorKeySecure();
  if (secureDetectorKey !== undefined) {
    initialDetector = loadDetector();
    initialDetector.apiKey = secureDetectorKey;
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App initialApi={initialApi} initialDetector={initialDetector} />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

bootstrap();