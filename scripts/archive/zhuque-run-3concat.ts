// scripts/zhuque-run-3concat.ts
// 朱雀免费版要求单文本 > 350 字（实测提示 350 字下限）。我们 A/B/C 各组单段均 <350 字。
// 策略：把同档位的 3 组文本拼接成 1 段长文本。共跑 3 次官方检测：
//   1) 原文档拼接 = A原文 + (过渡句) + B原文 + (过渡句) + C原文   → 加权 aiScore_x1 → 官方 y1
//   2) 基础档拼接 = A基础档 + (过渡句) + B基础档 + (过渡句) + C基础档 → 加权 aiScore_x2 → 官方 y2
//   3) 朱雀档拼接 = A朱雀档 + (过渡句) + B朱雀档 + (过渡句) + C朱雀档 → 加权 aiScore_x3 → 官方 y3
// 得到 3 个新 (x,y) 点。加上 docs 里原 3 点，总 n=6 重跑 OLS。
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DATA = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'calibration-data.json'), 'utf-8'));
const OUTL = path.join(process.cwd(), 'scripts', 'zhuque-results.jsonl');
const SESSION = 'zhuque';
// 过渡句（中性真人随笔语气，避免拉高/拉低 AI 判定；总字数撑到 > 700）
const BRIDGE = [
  '这让我想起早些时候和朋友聊天时提到过的一件小事，其实生活里很多看似宏大的结论，拆开来也无非就是这几段日常的、没什么修饰的话拼在一起。',
  '说起来你可能不信，我后来又把这些内容翻来覆去读了两遍，越读越觉得——原文到底是怎么写出来的并不重要，重要的是读者读完以后脑子里留下的东西。',
];

type Point = { key: string; xAiScore: number; weightedByChars: number; text: string };
function buildConcat(level: '原文' | '基础档' | '朱雀档'): Point {
  const items = DATA.filter((e: any) => e.level === level);
  let text = '';
  let charsSum = 0;
  let weighted = 0;
  items.forEach((e: any, i: number) => {
    if (i > 0) text += '\n\n' + BRIDGE[(i - 1) % BRIDGE.length] + '\n\n';
    text += e.text;
    const ch = [...e.text].length;
    charsSum += ch;
    weighted += e.aiScore * ch;
  });
  return {
    key: level,
    xAiScore: Math.round((weighted / charsSum) * 100) / 100,
    weightedByChars: charsSum,
    text,
  };
}

const POINTS: Point[] = (['原文', '基础档', '朱雀档'] as const).map(buildConcat);
console.log('3 次拼接任务：');
for (const p of POINTS) {
  console.log(`  · ${p.key}: x=aiScore ${p.xAiScore}, 总字数=${[...p.text].length}`);
}

function run(args: string, timeoutMs = 60_000): string {
  try {
    return execSync(`npx agent-browser --session ${SESSION} ${args}`, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (e: any) {
    const msg: string = e.stdout ? e.stdout.toString() : '';
    const err: string = e.stderr ? e.stderr.toString() : '';
    return `__EXEC_ERROR__ ${msg} ${err}`.slice(0, 3000);
  }
}
function evalJS(js: string, timeout = 30_000): any {
  const b64 = Buffer.from(js, 'utf-8').toString('base64');
  const out = run(`eval -b ${b64}`, timeout);
  if (out.startsWith('__EXEC_ERROR__')) {
    console.error('[eval error]', out.slice(0, 300));
    return null;
  }
  try {
    return JSON.parse(out.trim().replace(/^"(.*)"$/s, '$1').replace(/\\"/g, '"'));
  } catch {
    return out.trim();
  }
}
function sleepSync(ms: number) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}
function waitForResult(timeoutMs = 25_000): { ok: boolean; officialPct: number | null; snippet: string; err?: string } {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const got = evalJS(`(() => {
      var allText = document.body.innerText || '';
      var hasKW = allText.indexOf('AI生成概率') >= 0 || allText.indexOf('AI生成可能性') >= 0 || allText.indexOf('疑似AI内容') >= 0 || allText.indexOf('人工创作特征') >= 0 || allText.indexOf('检测结果') >= 0 || allText.indexOf('AI特征') >= 0;
      var pctMatches = [];
      var re = /(\\d{1,3}(?:\\.\\d{1,2})?)%/g;
      var m;
      while ((m = re.exec(allText)) !== null) {
        var n = Number(m[1]);
        if (!isNaN(n) && n <= 100 && n >= 0) pctMatches.push(n);
      }
      var hasShort = allText.indexOf('检测文本长度需大于350字') >= 0;
      var hasLogin = allText.indexOf('登录') >= 0;
      var limited = allText.indexOf('今日剩余') >= 0 && allText.indexOf('0次') >= 0;
      if (hasShort) return JSON.stringify({ok:false, err:'LENGTH_UNDER_350', pctMatches: pctMatches, snapshot: allText.slice(0,500)});
      if (limited) return JSON.stringify({ok:false, err:'QUOTA_ZERO', pctMatches: pctMatches, snapshot: allText.slice(0,300)});
      if (hasLogin && !hasKW) return JSON.stringify({ok:false, err:'NEED_LOGIN', snapshot: allText.slice(0,300)});
      if (hasKW && pctMatches.length > 0) {
        var strongHuman = allText.indexOf('人工创作特征较强') >= 0 || allText.indexOf('人工创作特征明显') >= 0 || allText.indexOf('人工创作特征高') >= 0;
        var mn = Math.min.apply(null, pctMatches);
        var mx = Math.max.apply(null, pctMatches);
        var pct = strongHuman ? mn : mx;
        return JSON.stringify({ok:true, pct:pct, pctMatches:pctMatches, snapshot:allText.slice(0,500)});
      }
      return JSON.stringify({ok:false, wait:true, pctMatches:pctMatches, snapshot: allText.slice(0,200)});
    })()`);
    if (got && typeof got === 'object') {
      if (got.ok === true) return { ok: true, officialPct: got.pct, snippet: got.snapshot };
      if (got.ok === false && got.wait !== true) return { ok: false, officialPct: null, snippet: got.snapshot, err: got.err || 'STOP' };
    }
    sleepSync(700);
  }
  return { ok: false, officialPct: null, snippet: '', err: 'TIMEOUT' };
}

async function main() {
  for (let i = 0; i < POINTS.length; i++) {
    const p = POINTS[i];
    console.log(`\n=== [${i + 1}/${POINTS.length}] 拼接档=${p.key}  x(加权aiScore)=${p.xAiScore}  总字数=${[...p.text].length} ===`);

    // 每次都重新打开检测页（避免检测完之后 DOM 结构换成结果页导致找不到 textarea）
    run(`open https://matrix.tencent.com/ai-detect/ai_gen`);
    sleepSync(4500);
    // 切到「文本」tab（如果按钮可见），然后等 textarea 出现
    evalJS(`(() => {
      for (const btn of document.querySelectorAll('button')) {
        const t = (btn.textContent || '').trim();
        if (t === '文本' || /文本$/.test(t) || t.includes('\uE785')) { btn.click(); return 'TXT_TAB'; }
      }
      return 'NO_TAB';
    })()`);
    sleepSync(600);
    // 等 textarea 就绪（最多 5s）
    let taReady = false;
    for (let w = 0; w < 10; w++) {
      const ok = evalJS(`(() => { const ta = document.querySelector('textarea'); return !!(ta && ta.clientWidth > 100); })()`);
      if (ok === true) { taReady = true; break; }
      sleepSync(500);
    }
    if (!taReady) {
      const line = JSON.stringify({ ts: new Date().toISOString(), key: p.key, xAiScore: p.xAiScore, officialPct: null, error: 'TEXTAREA_NOT_READY' });
      fs.appendFileSync(OUTL, line + '\n', 'utf-8');
      console.log('  skip: TEXTAREA 未就绪');
      continue;
    }

    // 2) 填 textarea（Vue/React 受控组件双保险）
    const fillR = evalJS(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return JSON.stringify({ok:false, e:'NO_TA'});
      const txt = ${JSON.stringify(p.text)};
      ta.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) { nativeSetter.call(ta, txt); } else { ta.value = txt; }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      let btnInfo = { enabled:false, label:'' };
      for (const btn of document.querySelectorAll('button')) {
        const t = (btn.textContent || '').trim();
        if (/立即检测/.test(t)) { btnInfo = { enabled: !btn.disabled, label: t }; break; }
      }
      return JSON.stringify({ ok:true, len: ta.value.length, btnInfo });
    })()`);
    console.log('  fill:', fillR);
    sleepSync(500);

    // 3) 点立即检测
    if (!fillR || !fillR.btnInfo || !fillR.btnInfo.enabled) {
      const line = JSON.stringify({ ts: new Date().toISOString(), key: p.key, xAiScore: p.xAiScore, officialPct: null, error: 'BTN_DISABLED', detail: fillR });
      fs.appendFileSync(OUTL, line + '\n', 'utf-8');
      continue;
    }
    evalJS(`(() => {
      for (const btn of document.querySelectorAll('button')) {
        const t = (btn.textContent || '').trim();
        if (/立即检测/.test(t) && !btn.disabled) { btn.click(); return 'CLICKED'; }
      }
      return 'NO_CLICK';
    })()`);

    // 4) 等结果
    const r = waitForResult(30_000);
    console.log('  detect:', r.ok ? ('OK %=' + r.officialPct) : ('FAIL: ' + (r.err || 'no-res')));
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      key: p.key,
      xAiScore: p.xAiScore,
      charsTotal: [...p.text].length,
      officialPct: r.officialPct,
      error: r.err || null,
      snippet: r.snippet,
    });
    fs.appendFileSync(OUTL, line + '\n', 'utf-8');
    // 避免限频
    await new Promise(r2 => setTimeout(r2, 3000));
  }
  console.log('\n✅ 完成。输出：', OUTL);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
