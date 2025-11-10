import React from "react";

type ErrorBoundaryState = { hasError: boolean; error?: Error };

export class ErrorBoundary extends React.Component<React.PropsWithChildren<{}>, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren<{}>) {
    super(props);
    this.state = { hasError: false, error: undefined };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    // 可在此处上报错误到日志系统
    console.error("App crashed:", error, errorInfo);
  }

  handleReload = () => {
    try {
      // 在 Tauri/Web 环境均可用
      window.location.reload();
    } catch {}
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24 }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>出了点问题</div>
          <div style={{ fontSize: 14, color: "#666", marginBottom: 16 }}>
            应用遇到未捕获异常。你可以尝试刷新应用。
          </div>
          <button onClick={this.handleReload} style={{ border: "1px solid #ddd", background: "#fff", padding: "8px 12px", cursor: "pointer" }}>刷新</button>
          {this.state.error && (
            <pre style={{ marginTop: 16, fontSize: 12, color: "#999", whiteSpace: "pre-wrap" }}>
              {String(this.state.error?.message || this.state.error)}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children as React.ReactElement;
  }
}

export default ErrorBoundary;