/**
 * 趣AI味 · v0.9.3 多角色通道清单（Multi-Role Endpoints）
 * ---------------------------------------------------------
 * 全部通道 2026-09-12 宿主 curl 实测。Key 均来自用户提供（D:\Desktop\新建
 * Text Document.txt），不进 git（本文件已列入 .gitignore 由用户自行管理；
 * 若文件意外入库，推送远程前必须轮换全部 Key）。
 *
 * 通道健康档案：
 *  · sensenova  https://token.sensenova.cn/v1        ✅ 5 模型 3 Key（429 限流需冷却）
 *  · amd        https://developer.amd.com.cn/radeon/api/v1 ✅ DeepSeek-V4-Flash 1.0s
 *  · nvidia     https://integrate.api.nvidia.com/v1  ✅ glm-5.3-flash 2.7s
 *               （glm-5.2 已 410 下线；kimi-k3 超时未确认，暂不列席）
 *  · openrouter stealth/ox-alpha ❌ 404（测试期结束，指向 glm-5.3-flash 但 Key 402 余额不足）
 *
 * 角色分配原则（按 2026-09-12 合议庭实验设计）：
 *  · 写手（改写）：sensenova deepseek-v4-flash（质量最好）+ amd DeepSeek-V4-Flash（独立网关备份）
 *  · 质检（通顺/忠实）：amd DeepSeek-V4-Flash（非思考型响应快）
 *  · 合议庭裁判：三席跨网关——sensenova deepseek-v4-pro + amd DeepSeek-V4-Flash
 *    + nvidia glm-5.3-flash（glm 系需 max_tokens ≥4000）
 */

import { readFileSync } from "fs";
import { existsSync } from "fs";
import type { JudgeSeat } from "./judge-panel";

/** 用户提供的通道清单原文件路径（不进 git） */
const ENDPOINTS_FILE = ["endpoints.local.json", "../endpoints.local.json"];

export interface RoleEndpoints {
  /** 改写主力（sensenova deepseek-v4-flash） */
  writerBaseUrl: string;
  writerKeys: string[];
  writerModel: string;
  /** 改写备份（amd 独立网关） */
  altWriterBaseUrl: string;
  altWriterKey: string;
  altWriterModel: string;
  /** 质检通道 */
  qcBaseUrl: string;
  qcKey: string;
  qcModel: string;
  /** 合议庭席位 */
  judgeSeats: JudgeSeat[];
}

/** 内置通道（Key 从本地文件读取；文件缺失时 Key 为空、通道不可用） */
function loadKeys(): { sensenova: string[]; amd: string; nvidia: string } {
  // sensenova：复用项目既有 gitignored Key 文件
  let sensenova: string[] = [];
  try {
    sensenova = readFileSync("scripts/.sensenova-keys", "utf8")
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    /* 文件不存在时为空 */
  }
  // amd / nvidia：endpoints.local.json（格式 {"amd":"rc-...","nvidia":"nvapi-..."}）
  let amd = "";
  let nvidia = "";
  for (const p of ENDPOINTS_FILE) {
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        amd = String(j.amd ?? "");
        nvidia = String(j.nvidia ?? "");
        if (amd && nvidia) break;
      } catch {
        /* 解析失败视为缺省 */
      }
    }
  }
  return { sensenova, amd, nvidia };
}

/** 组装多角色通道配置（运行时调用；Key 缺失的席位自动剔除） */
export function buildRoleEndpoints(): {
  writer: { baseUrl: string; keys: string[]; model: string } | null;
  altWriter: { baseUrl: string; key: string; model: string } | null;
  qc: { baseUrl: string; key: string; model: string } | null;
  judgeSeats: JudgeSeat[];
} {
  const { sensenova, amd, nvidia } = loadKeys();
  const writer =
    sensenova.length > 0
      ? { baseUrl: "https://token.sensenova.cn/v1", keys: sensenova, model: "deepseek-v4-flash" }
      : null;
  const altWriter = amd
    ? {
        baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
        key: amd,
        model: "DeepSeek-V4-Flash",
      }
    : null;
  const qc = amd
    ? {
        baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
        key: amd,
        model: "DeepSeek-V4-Flash",
      }
    : null;
  const judgeSeats: JudgeSeat[] = [];
  if (sensenova.length > 0) {
    judgeSeats.push({
      id: "sensenova-ds-pro",
      baseUrl: "https://token.sensenova.cn/v1",
      apiKey: sensenova[0],
      model: "deepseek-v4-pro",
      weight: 1,
      maxTokens: 8000,
    });
  }
  if (amd) {
    judgeSeats.push({
      id: "amd-ds-flash",
      baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
      apiKey: amd,
      model: "DeepSeek-V4-Flash",
      weight: 1,
      maxTokens: 6000,
    });
  }
  if (nvidia) {
    judgeSeats.push({
      id: "nvidia-glm53",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: nvidia,
      model: "z-ai/glm-5.3-flash",
      weight: 1,
      // glm 系思考型：reasoning 吃 token，预算必须给足
      maxTokens: 4000,
    });
  }
  return { writer, altWriter, qc, judgeSeats };
}
