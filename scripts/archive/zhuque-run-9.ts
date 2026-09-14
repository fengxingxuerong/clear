// scripts/zhuque-run-9.ts
// 在 agent-browser 里开朱雀页，对 calibration-data.json 的 9 段文本逐段送检。
// 流程：fill textarea -> 点立即检测 -> 等"AI生成概率/%"出现 -> 读百分比 -> 清空。
// 结果追加写入 scripts/zhuque-results.jsonl（每行一个 JSON，出错也记录）
// 安全：若检测按钮显示"今日剩余0次"或遇到限额弹窗→中止并写 LAST=ABORT。
// 运行: npx tsx scripts/zhuque-run-9.ts
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DATA = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'calibration-data.json'), 'utf-8'));
const OUTL = path.join(process.cwd(), 'scripts', 'zhuque-results.jsonl');
const SESSION = 'zhuque';

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
    console.error('[eval error]', out.slice(0, 400));
    return null;
  }
  try {
    return JSON.parse(out.trim().replace(/^"(.*)"$/s, '$1').replace(/\\"/g, '"'));
  } catch {
    return out.trim();
  }
}

function waitForResult(timeoutMs = 20_000): { ok: boolean; raw: string } {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const got = evalJS(`(() => {
      const el = document.querySelector('textarea');
      // 结果面板通常出现在右侧或者结果替换；扫描页面所有文本里是否包含百分号，并找"AI生成概率""AI生成可能性""AI概率""疑似AI内容占比""人工创作特征"等关键词
      const allText = document.body.innerText || '';
      const percentMatches = [...allText.matchAll(/(\\d{1,3}(?:\\.\\d{1,2})?)%/g)].map(m => m[1]);
      const hasResultKeyword = /(AI生成概率|AI生成可能性|疑似AI内容|人工创作特征|检测结果|AI的概率|生成的概率)/i.test(allText);
      // 如果遇到 立即检测按钮的剩余次数为 0 或 登录/限频 文字
      const limited = /(今日剩余[^\\d]*0次|登录|限频|已达上限|超出)/i.test(allText);
      return JSON.stringify({ hasResultKeyword, percentMatches, limited, snapshot: allText.slice(0, 800) });
    })()`);
    if (got && typeof got === 'object') {
      if (got.limited) return { ok: false, raw: 'LIMIT: ' + (got.snapshot || '').slice(0, 300) };
      if (got.hasResultKeyword && Array.isArray(got.percentMatches) && got.percentMatches.length > 0) {
        const nums = got.percentMatches.map(Number).filter((n: number) => !isNaN(n) && n <= 100);
        if (nums.length) return { ok: true, raw: JSON.stringify({ nums, snippet: got.snapshot.slice(0, 400) }) };
      }
    }
    execSync('powershell -Command "Start-Sleep -Milliseconds 500"', { stdio: 'ignore' });
  }
  return { ok: false, raw: 'TIMEOUT' };
}

async function main() {
  console.log('总样本数:', DATA.length);
  for (let i = 0; i < DATA.length; i++) {
    const e = DATA[i];
    const id = `${e.groupId}-${e.level}`;
    console.log(`\n=== [${i + 1}/${DATA.length}] ${id} aiScore=${e.aiScore} ===`);
    // 1) 清空：点"清空"按钮
    evalJS(`(() => {
      for (const btn of document.querySelectorAll('button')) {
        if ((btn.textContent || '').trim() === '清空') { btn.click(); return 'OK-clear'; }
      }
      // 没清空按钮就直接把 textarea value 清了
      const ta = document.querySelector('textarea'); if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', {bubbles:true})); return 'OK-val'; }
      return 'NO-CLEAR';
    })()`);
    await new Promise(r => setTimeout(r, 350));

    // 2) 填 textarea
    const textClean = e.text.replace(/\r/g, '');
    // 通过 dispatchEvent('change') + focus + 直接设置 value + 触发 input
    const fillJs = `(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return JSON.stringify({ ok:false, err:'NO_TA' });
      ta.focus();
      ta.value = ${JSON.stringify(textClean)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      // Vue/React 受控组件可能需要额外触发
      try {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) { nativeSetter.call(ta, ${JSON.stringify(textClean)}); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      } catch(_e) {}
      // 检查立即检测按钮是否可点
      let detectEnabled = false; let detectLabel = '';
      for (const btn of document.querySelectorAll('button')) {
        const t = (btn.textContent || '').trim();
        if (/立即检测/.test(t)) { detectEnabled = !btn.hasAttribute('disabled') && !btn.disabled; detectLabel = t; break; }
      }
      return JSON.stringify({ ok:true, charsSet: ta.value.length, detectEnabled, detectLabel });
    })()`;
    const fillResult = evalJS(fillJs);
    console.log('  fill:', fillResult);
    await new Promise(r => setTimeout(r, 450));

    // 3) 点立即检测
    const preBtn = evalJS(`(() => {
      for (const btn of document.querySelectorAll('button')) {
        const t = (btn.textContent || '').trim();
        if (/立即检测/.test(t)) {
          const disabled = btn.hasAttribute('disabled') || btn.disabled;
          return JSON.stringify({ label: t, disabled, willClick: !disabled });
        }
      }
      return JSON.stringify({ label: '', disabled: true, willClick: false });
    })()`);
    console.log('  btn:', preBtn);
    if (preBtn && preBtn.disabled === true) {
      const line = JSON.stringify({ ts: new Date().toISOString(), id, aiScore: e.aiScore, officialPct: null, error: 'BTN_DISABLED', detail: preBtn });
      fs.appendFileSync(OUTL, line + '\n', 'utf-8');
      if (/0次/.test(preBtn.label || '')) { console.log('❌ 今日额度 0，停止'); return; }
      continue;
    }
    evalJS(`(() => {
      for (const btn of document.querySelectorAll('button')) {
        const t = (btn.textContent || '').trim();
        if (/立即检测/.test(t) && !btn.hasAttribute('disabled') && !btn.disabled) {
          btn.click(); return 'CLICKED';
        }
      }
      return 'NO_CLICK';
    })()`);

    // 4) 等待结果（最多 20s）
    const res = waitForResult(22_000);
    console.log('  result:', res.ok ? res.raw.slice(0, 200) : 'FAIL=' + res.raw);
    let pct: number | null = null; let err: string | null = null;
    let detail: any = null;
    if (res.ok) {
      try {
        detail = JSON.parse(res.raw);
        // 取最可能的 AI%：最大的那个（朱雀的结果页会把"疑似AI内容概率"作为大百分比放前面）
        // 如果有"人工创作特征较强" → 人工概率高，我们取最小的%作为AI概率更安全
        const snippet: string = detail.snippet || '';
        const strongerHuman = /人工创作特征(较强|明显|高)/.test(snippet);
        const nums: number[] = detail.nums || [];
        pct = strongerHuman ? Math.min(...nums) : Math.max(...nums);
      } catch { err = 'PARSE_FAIL'; detail = res.raw; }
    } else {
      err = 'NOT_OK: ' + res.raw;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      id,
      groupId: e.groupId, level: e.level,
      aiScore: e.aiScore,
      burstiness: e.burstiness, formulaicHits: e.formulaicHits, avgLen: e.avgLen,
      chars: [...e.text].length,
      officialPct: pct,
      error: err,
      detail,
    });
    fs.appendFileSync(OUTL, line + '\n', 'utf-8');
    console.log('  → 官方分:', pct, err ? 'ERR=' + err : '');
    // 避免限频
    await new Promise(r => setTimeout(r, 2500));
  }
  console.log('\n✅ 完成。写入文件：', OUTL);
}
main().catch(err => { console.error('FATAL', err); process.exit(1); });
