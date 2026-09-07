"""把送检稿注入朱雀输入区（execCommand insertText），然后触发检测。"""
import io, json, subprocess, sys

text = io.open('.tmp-submit/tech-submit.txt', encoding='utf-8').read()
# 构造 JS 安全字符串：JSON 编码即得合法 JS 字符串字面量
js_str = json.dumps(text, ensure_ascii=False)

js = (
    "(() => {"
    "const seg = document.querySelector('.txt-segment-box');"
    "if (!seg) return 'ERR no seg';"
    "seg.focus();"
    "document.execCommand('selectAll', false, null);"
    "const ok = document.execCommand('insertText', false, " + js_str + ");"
    "return 'insertText:' + ok + ' len:' + seg.textContent.length;"
    "})()"
)

r = subprocess.run(
    ["npx", "agent-browser", "eval", js, "--session", "zhuque"],
    capture_output=True, text=True, timeout=90, cwd=".",
)
print("STDOUT:", r.stdout[-400:])
if r.returncode != 0:
    print("STDERR:", r.stderr[-300:])
