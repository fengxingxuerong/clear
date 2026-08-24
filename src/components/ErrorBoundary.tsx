/**
 * 趣AI味 · 全局错误边界：渲染层未捕获异常不再白屏，给出重载出口
 * （React 错误边界目前只能用 class 组件实现）
 */
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[QuAiWei] 渲染层异常:", error, info);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ padding: 40, color: "#e6e8f0", fontFamily: "system-ui, sans-serif" }}>
          <h2>界面出了点问题</h2>
          <p style={{ color: "#ff5d6c", whiteSpace: "pre-wrap" }}>{String(error?.message ?? error)}</p>
          <button onClick={() => location.reload()} style={{ padding: "8px 20px", cursor: "pointer" }}>
            重载应用
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
