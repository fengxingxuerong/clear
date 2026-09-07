"""拖动滑块完成拼图验证码（分步模拟人类拖动轨迹）。"""
import subprocess, time, sys

NB = r"C:\Users\Admin（无密码）\.box-agent\box-agent-runtime\runtimes\node\versions\node-v24.15.0-win-x64\npx.CMD"

def ab(*args, timeout=30):
    return subprocess.run([NB, "agent-browser", *args, "--session", "zhuque"],
                          capture_output=True, text=True, timeout=timeout)

# 起点（滑块手柄中心）与目标位移
start_x, y = 516, 398
dx_total = 152

r1 = ab("mouse", "move", str(start_x), str(y)); time.sleep(0.15)
r2 = ab("mouse", "down", "left"); time.sleep(0.2)
if r2.returncode != 0:
    print("down failed:", r2.stderr[-200:]); sys.exit(1)

# 分12步拖动，带轻微过冲回弹（模拟人类）
steps = 12
overshoot = 2
for i in range(1, steps + 1):
    progress = i / steps
    x = start_x + dx_total * progress + (overshoot if i == steps else 0)
    jitter_y = y + (1 if i % 3 == 0 else 0)
    ab("mouse", "move", str(int(x)), str(jitter_y))
    time.sleep(0.06)
# 回弹校正
ab("mouse", "move", str(int(start_x + dx_total)), str(y))
time.sleep(0.15)
ab("mouse", "up", "left")
print("dragged done")
