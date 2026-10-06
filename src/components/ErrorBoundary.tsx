import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 兜底错误边界：渲染期抛错不该让用户看到整页白屏。
 *
 * 现场白屏是最没法自证的故障 —— 用户描述不出原因，界面上也没有线索。
 * 这里换成人话 + 原始报错 + 一个重新加载按钮；数据都在本机缓存与仓库里，重载即可继续。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('记食本 · 界面崩溃：', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app">
        <main className="scroll">
          <section className="pad" style={{ paddingTop: '10vh' }}>
            <div className="card sticker" style={{ padding: '20px 18px', textAlign: 'center' }}>
              <h1 className="ptitle" style={{ fontSize: 22 }}>
                界面出了点问题
              </h1>
              <p style={{ margin: '10px 0 4px', color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
                数据没丢 —— 都在本机缓存和你的仓库里。重新加载一下就能接着用。
              </p>
              <p className="meta ellip" style={{ margin: '0 0 16px', fontSize: 11.5 }}>
                {error.message}
              </p>
              <button className="btn-primary" onClick={() => window.location.reload()}>
                重新加载
              </button>
            </div>
          </section>
        </main>
      </div>
    );
  }
}
