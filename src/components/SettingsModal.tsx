import { useEffect, useState } from "react";
import {
  ApiConfig,
  DEFAULT_API,
  RewriteStyle,
  DEEP_MAX_ROUNDS,
  DEEP_TARGET_SCORE,
  SENSENOVA_PRESET,
} from "../api/llm";
import { DetectorConfig, DEFAULT_DETECTOR } from "../api/detector";
import type { LocalSettings } from "../store";

interface SettingsModalProps {
  api: ApiConfig;
  detector: DetectorConfig;
  zhuqueMode: boolean;
  pplEnabled: boolean;
  local: LocalSettings;
  onClose: () => void;
  onSave: (
    api: ApiConfig,
    detector: DetectorConfig,
    zhuqueMode: boolean,
    pplEnabled: boolean,
    local: LocalSettings,
  ) => void;
}

const STYLE_OPTIONS: { value: RewriteStyle; label: string }[] = [
  { value: "casual", label: "自然口语（默认）" },
  { value: "plain", label: "平实书面（报告/公众号）" },
  { value: "academic", label: "学术体（论文降AIGC）" },
];

export function SettingsModal({
  api,
  detector,
  zhuqueMode,
  pplEnabled,
  local,
  onClose,
  onSave,
}: SettingsModalProps) {
  // 草稿态：模态内编辑不立即持久化，点「保存」统一落盘，避免半保存的中间态
  const [draftApi, setDraftApi] = useState<ApiConfig>(api);
  const [draftDetector, setDraftDetector] = useState<DetectorConfig>(detector);
  const [draftZhuque, setDraftZhuque] = useState<boolean>(zhuqueMode);
  const [draftPpl, setDraftPpl] = useState<boolean>(pplEnabled);
  const [draftLocal, setDraftLocal] = useState<LocalSettings>(local);
  // 温度输入中间态：允许清空/逐字编辑，失焦时才归一化进草稿（避免受控回弹跳值）
  const [tempText, setTempText] = useState(String(api.temperature));

  // Esc 关闭模态（桌面应用标配交互）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const updateApi = (patch: Partial<ApiConfig>) => setDraftApi({ ...draftApi, ...patch });
  const updateDetector = (patch: Partial<DetectorConfig>) =>
    setDraftDetector({ ...draftDetector, ...patch });

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="API 设置" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>API 设置（可选）</span>
          <button onClick={onClose}>✕</button>
        </div>
        <p className="modal-tip">
          不填也能用：默认走本地引擎，完全离线、零成本。填了走 OpenAI
          兼容接口（通吃各家），效果更强。
        </p>
        <label className="row">
          <span>启用 API</span>
          <input
            type="checkbox"
            checked={draftApi.enabled}
            onChange={(e) => updateApi({ enabled: e.target.checked })}
          />
        </label>
        <label className="row">
          <span>Base URL</span>
          <input
            value={draftApi.baseUrl}
            onChange={(e) => updateApi({ baseUrl: e.target.value })}
            placeholder={DEFAULT_API.baseUrl}
          />
        </label>
        <label className="row">
          <span>API Key</span>
          <input
            type="password"
            value={draftApi.apiKey}
            onChange={(e) => updateApi({ apiKey: e.target.value })}
            placeholder="sk-..."
          />
        </label>
        <label className="row" style={{ alignItems: "flex-start" }}>
          <span>
            Key 池
            <br />
            <small style={{ color: "var(--muted)" }}>
              每行一个
              <br />
              429 自动切换
            </small>
          </span>
          <textarea
            style={{
              flex: 1, minHeight: 60, background: "rgba(8,12,22,0.7)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
              fontFamily: "inherit", fontSize: 12,
            }}
            value={draftApi.apiKeys ?? ""}
            onChange={(e) => updateApi({ apiKeys: e.target.value })}
            placeholder={"sk-...\nsk-..."}
          />
        </label>
        <label className="row">
          <span>SenseNova 预置</span>
          <button
            className="ghost sm"
            onClick={() =>
              updateApi({
                enabled: true,
                baseUrl: SENSENOVA_PRESET.baseUrl,
                apiKey: SENSENOVA_PRESET.keys[0],
                apiKeys: SENSENOVA_PRESET.keys.join("\n"),
                model: "deepseek-v4-flash",
                judgeModel: "glm-5.2",
                altModel: "deepseek-v4-pro",
              })
            }
            title="内置 SenseNova 网关常驻通道（2026-09-01 实测可用）：deepseek-v4-flash 主力 + glm-5.2 交叉评判 + 3 Key 自动轮换"
          >
            填入 SenseNova 常驻通道
          </button>
        </label>
        <label className="row">
          <span>模型</span>
          <input
            value={draftApi.model}
            onChange={(e) => updateApi({ model: e.target.value })}
            placeholder={DEFAULT_API.model}
            list="quaiwei-model-list"
          />
          <datalist id="quaiwei-model-list">
            <option value="stealth/ox-alpha">OpenRouter · Ox Alpha（1M 上下文）</option>
            <option value="deepseek-v4-flash">SenseNova · deepseek-v4-flash</option>
            <option value="glm-5.2">SenseNova · glm-5.2</option>
            <option value="sensenova-6.8-flash-lite">SenseNova · flash-lite</option>
            <option value="gpt-4o-mini">OpenAI · gpt-4o-mini</option>
          </datalist>
        </label>
        <label className="row">
          <span>评判模型</span>
          <input
            value={draftApi.judgeModel}
            onChange={(e) => updateApi({ judgeModel: e.target.value })}
            placeholder="留空=用主模型；建议填不同家族"
          />
        </label>
        <label className="row">
          <span>备选改写</span>
          <input
            value={draftApi.altModel}
            onChange={(e) => updateApi({ altModel: e.target.value })}
            placeholder="可选；如 glm-5.2，首轮双模型竞争"
          />
        </label>
        <p className="modal-tip" style={{ marginTop: -6 }}>
          交叉评判：实测同一去味文本主模型（deepseek）自评 30 分、glm-5.2 评 4 分——
          填一个不同家族的模型（如 glm-5.2 或 sensenova-6.7-flash-lite）评分更客观，痕迹指认也更犀利。
        </p>
        <label className="row">
          <span>一键配置</span>
          <button
            className="ghost sm"
            onClick={() => {
              updateApi({
                baseUrl: "https://openrouter.ai/api/v1",
                model: "stealth/ox-alpha",
                reasoningEffort: "max",
                enabled: true,
              });
            }}
            title="Ox Alpha：1M 上下文，最大推理强度，支持多模态输入"
          >
            填入 OpenRouter + Ox Alpha
          </button>
        </label>
        <label className="row">
          <span>推理强度</span>
          <select
            value={draftApi.reasoningEffort || ""}
            onChange={(e) =>
              updateApi({
                reasoningEffort: (e.target.value as ApiConfig["reasoningEffort"]) || undefined,
              })
            }
          >
            <option value="">关闭（非推理模型）</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
            <option value="max">最大（1M 上下文 + 最高推理）</option>
            <option value="x-high">极限</option>
          </select>
        </label>
        <label className="row">
          <span>温度</span>
          <input
            type="number"
            step="0.1"
            min={0}
            max={2}
            value={tempText}
            onChange={(e) => {
              setTempText(e.target.value);
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) updateApi({ temperature: v });
            }}
            onBlur={() => {
              const v = parseFloat(tempText);
              const clamped = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : api.temperature;
              updateApi({ temperature: clamped });
              setTempText(String(clamped));
            }}
          />
        </label>
        <label className="row">
          <span>文风</span>
          <select
            value={draftApi.style}
            onChange={(e) => updateApi({ style: e.target.value as RewriteStyle })}
          >
            {STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>深度模式</span>
          <input
            type="checkbox"
            checked={draftApi.deepMode}
            onChange={(e) => updateApi({ deepMode: e.target.checked })}
          />
        </label>
        <p className="modal-tip" style={{ marginTop: -6 }}>
          深度模式：改写 → LLM 评分 → 未达标（&gt;{DEEP_TARGET_SCORE} 分）带分数反馈自动再改写，最多{" "}
          {DEEP_MAX_ROUNDS} 轮。单次更慢但去味更彻底。
        </p>
        <label className="row">
          <span>最长等待</span>
          <select
            value={draftApi.maxWaitSeconds || 0}
            onChange={(e) => updateApi({ maxWaitSeconds: Number(e.target.value) })}
          >
            <option value={0}>不限制</option>
            <option value={60}>1 分钟</option>
            <option value={120}>2 分钟</option>
            <option value={300}>5 分钟</option>
            <option value={600}>10 分钟</option>
          </select>
        </label>

        <div className="modal-divider">朱雀增强（可选 · 反检测特征）</div>
        <p className="modal-tip">
          叠加方言词汇、句中插入语、主观意见短语、括号自语、句式片段等特征， 干扰 AI
          文本检测器的统计空间。强度 ≥0.5 时效果更明显。送检朱雀前建议开启。
        </p>
        <label className="row">
          <span>朱雀增强模式</span>
          <input
            type="checkbox"
            checked={draftZhuque}
            onChange={(e) => setDraftZhuque(e.target.checked)}
          />
        </label>

        <div className="modal-divider">困惑度体检（第 8 项 · 本地 ONNX 小模型）</div>
        <p className="modal-tip">
          用本地小模型近似朱雀官方点名的「困惑度」指标：均值过低＝对语言模型过于可预测，
          曲线过平＝全文置信度缺乏人类起伏。首次使用需下载约 100MB 模型，之后完全离线。
          关闭后指纹体检只跑前 7 项。
        </p>
        <label className="row">
          <span>启用困惑度检查</span>
          <input
            type="checkbox"
            checked={draftPpl}
            onChange={(e) => setDraftPpl(e.target.checked)}
          />
        </label>

        <div className="modal-divider">本地引擎（离线，零成本）</div>
        <p className="modal-tip">
          多候选择优：本地引擎一次跑多个随机种子各出一稿，按「高危指纹 &lt; 本地 AI 味分」挑最优，
          候选先过硬门槛（忠实度不过 / 长度比跑偏 0.6~1.4 之外直接淘汰）。只作用于本地引擎路径（含
          API 失败回退）。
        </p>
        <label className="row">
          <span>多候选择优</span>
          <input
            type="checkbox"
            checked={draftLocal.bestOf}
            onChange={(e) => setDraftLocal({ ...draftLocal, bestOf: e.target.checked })}
          />
        </label>
        <label className="row">
          <span>候选数（1~30）</span>
          <input
            type="number"
            min={1}
            max={30}
            step={1}
            value={draftLocal.candidates}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setDraftLocal({ ...draftLocal, candidates: Number.isFinite(v) ? Math.max(1, Math.min(30, v)) : 8 });
            }}
          />
        </label>

        <div className="modal-divider">对标检测器（可选 · 如朱雀）</div>
        <p className="modal-tip">
          把 {`{text}`} POST 到你的检测器接口，从返回 JSON
          按路径取分数。朱雀 API 用户填入 EdgeOne 网关域名 + Key 即可。
        </p>
        <p className="modal-tip" style={{ marginTop: -6 }}>
          <b>朱雀一键配置</b>：在腾讯云 EdgeOne 控制台创建 AI 网关后，
          将网关域名和 API Key 填入下方，点「朱雀预设」自动配好路径和刻度。
          网关路由 = <code>{`/v1/providers/zhuque-text/classify`}</code>
        </p>
        <label className="row">
          <span>朱雀预设</span>
          <button
            className="ghost sm"
            onClick={() =>
              updateDetector({
                enabled: true,
                url: (draftDetector.url.replace(/\/+$/, "") || "https://your-gateway.edgeone.app") + "/v1/providers/zhuque-text/classify",
                scorePath: "softmax_confidence",
                scale: "0-1",
              })
            }
          >
            填入朱雀默认值
          </button>
        </label>
        <label className="row">
          <span>启用检测器</span>
          <input
            type="checkbox"
            checked={draftDetector.enabled}
            onChange={(e) => updateDetector({ enabled: e.target.checked })}
          />
        </label>
        <label className="row">
          <span>接口 URL</span>
          <input
            value={draftDetector.url}
            onChange={(e) => updateDetector({ url: e.target.value })}
            placeholder={DEFAULT_DETECTOR.url || "https://your-detector/api"}
          />
        </label>
        <label className="row">
          <span>API Key</span>
          <input
            type="password"
            value={draftDetector.apiKey}
            onChange={(e) => updateDetector({ apiKey: e.target.value })}
            placeholder="可选"
          />
        </label>
        <label className="row">
          <span>分数路径</span>
          <input
            value={draftDetector.scorePath}
            onChange={(e) => updateDetector({ scorePath: e.target.value })}
            placeholder="score 或 data.prob"
          />
        </label>
        <label className="row">
          <span>刻度</span>
          <select
            value={draftDetector.scale}
            onChange={(e) => updateDetector({ scale: e.target.value as "0-100" | "0-1" })}
          >
            <option value="0-100">0-100</option>
            <option value="0-1">0-1</option>
          </select>
        </label>

        <div className="modal-actions">
          <button
            className="primary"
            onClick={() => onSave(draftApi, draftDetector, draftZhuque, draftPpl, draftLocal)}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
