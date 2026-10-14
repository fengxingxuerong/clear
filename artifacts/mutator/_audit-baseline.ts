/** 审计：标定数据里标为「原文/纯人写」的文本，真的不含 AI 套话吗？ */
import { readFileSync } from "node:fs";
const CLICHE =
  /值得注意的是|综上所述|与此同时|不仅|而且|具有重要意义|进一步地?|需要指出的是|赋能|闭环|底层逻辑|总而言之|由此可见|毋庸置疑|不言而喻|在[^，。]{1,8}的背景下/g;
const COLLOQ = /(?:就|挺|结果|顺手|赶紧|好像|折腾|不太|没喝完|唉|吧|呢|啊|呀|啥|一摊)/g;
const files = ["scripts/calibration-data-v2-genres.json"];
for (const f of files) {
  const all = JSON.parse(readFileSync(f, "utf8")) as {
    genre: string;
    level: string;
    text: string;
  }[];
  console.log(`\n${f}`);
  console.log("体裁        档位               字数  套话命中  口语标记  判定");
  for (const r of all) {
    if (!(r.level.includes("原文") || r.level.includes("无处理"))) continue;
    const c = (r.text.match(CLICHE) || []).length;
    const q = (r.text.match(COLLOQ) || []).length;
    const verdict =
      c >= 2
        ? "⚠️ 含明显套话，不可能是人写"
        : c === 1
          ? "⚠️ 含 1 处套话，可疑"
          : q === 0
            ? "⚠️ 无口语标记，偏书面"
            : "✅ 像人写";
    console.log(
      `${r.genre.padEnd(11)} ${r.level.padEnd(18)} ${String(r.text.length).padStart(4)}  ${String(c).padStart(6)}  ${String(q).padStart(7)}  ${verdict}`,
    );
    if (c > 0)
      console.log(`      套话样例：${(r.text.match(CLICHE) || []).slice(0, 4).join(" / ")}`);
  }
}
