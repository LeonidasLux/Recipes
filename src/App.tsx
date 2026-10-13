import { useEffect, useRef } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
/* 与下面本组件的默认导出 `App` 重名：这里按电容原生那侧叫 CapApp */
import { App as CapApp } from '@capacitor/app';
import { StoreProvider, useStore } from './data/store';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SyncProvider, useSync } from './lib/useSync';
import { BackGuard } from './lib/back';
import { installLongPressGuard } from './lib/gestures';
import { parseOrderLink } from './lib/shareOrder';
import { viewOf } from './data/helpers';

import Setup from './screens/Setup';
import Library from './screens/Library';
import RecipeDetail from './screens/RecipeDetail';
import AddRecipe from './screens/AddRecipe';
import OrderScreen from './screens/Order';
import CookToday from './screens/CookToday';
import SyncScreen from './screens/Sync';

/** 没走过首次设置 → 一律先去向导 */
function RequireSetup() {
  const { needsSetup } = useStore();
  if (needsSetup) return <Navigate to="/setup" replace />;
  return <Outlet />;
}

/**
 * 分享链接的落点（瞬时页）：`/o/<订单 id>` 不停在这里。
 *
 * 分享出去的那条链接（原生包 `jishiben://o/<id>`、网页版 `<本页地址>#/o/<id>`）点开都落到
 * 这条路由上，这里只做一件事 —— 把「这一单」翻成该去哪块屏：**我点的单进「点单」，
 * 对方点的进「掌勺」**，并带上 `?open=<id>` 让那一单直接展开（见 Order / CookToday）。
 * 本机还没拉到这张单（对方刚点、或刚换手机）就先顺手同步一次，落到那一屏之后它会自己出现。
 */
function OpenOrder() {
  const { id = '' } = useParams();
  const { db, me } = useStore();
  const { syncNow } = useSync();
  const navigate = useNavigate();
  const jumped = useRef(false);

  const order = db.orders.find((o) => o.id === id) ?? null;
  /* 认不出是哪张单（本机没有 / 链接被改过）：按本机当前角色选一边，不把人丢在空白页上 */
  const screen = order
    ? order.placedBy === me
      ? '/order'
      : '/cook'
    : viewOf(db.config) === 'cook'
      ? '/cook'
      : '/order';

  useEffect(() => {
    /* 只在进这一页时跳一次：之后同步把这张单拉回来，也不用再跳（人已经在那一屏上了） */
    if (jumped.current) return;
    jumped.current = true;
    if (!order) void syncNow({ toast: false });
    navigate(order ? `${screen}?open=${encodeURIComponent(id)}` : screen, { replace: true });
  }, []);

  return null;
}

/**
 * 真机上的分享链接交给路由：`@capacitor/app` 有两个来路 —— 应用没开着时点链接（冷启动，
 * 读 `getLaunchUrl()`）、应用已经开着时点链接（热启动，`appUrlOpen` 事件），
 * 两种都换到路由 `/o/<id>`，剩下的交给 OpenOrder。
 * 网页版不接线：那种链接本来就是本页地址（`#/o/<id>`），路由自己会处理。
 */
function DeepLinkWatcher() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let dropped = false;
    let handle: PluginListenerHandle | null = null;
    const go = (url?: string) => {
      const id = parseOrderLink(url);
      if (id) navigate(`/o/${encodeURIComponent(id)}`);
    };
    void CapApp.getLaunchUrl()
      .then((r) => {
        if (!dropped) go(r?.url);
      })
      .catch(() => {});
    void CapApp.addListener('appUrlOpen', (e) => go(e.url)).then((h) => {
      if (dropped) void h.remove();
      else handle = h;
    });
    return () => {
      dropped = true;
      if (handle) void handle.remove();
    };
  }, [navigate]);
  return null;
}

/** 路由表 + 数据/同步上下文（不含具体 Router，便于测试挂载） */
export function AppShell() {
  /* 长按是「删除」手势：整页不让选中文字，也拦掉系统的长按菜单（输入框除外） */
  useEffect(() => installLongPressGuard(), []);

  return (
    <StoreProvider>
      <ToastProvider>
        <SyncProvider>
          {/* 手机返回键统一接管（先关遮罩 → 回上一屏 → 根屏才退出应用） */}
          <BackGuard>
            {/* 分享链接（`jishiben://o/<id>`）点开时先换到对应路由 */}
            <DeepLinkWatcher />
            {/* 屏内渲染崩了也让用户看到一句人话，而不是整页白屏 */}
            <ErrorBoundary>
              <Routes>
                <Route path="/setup" element={<Setup />} />
                <Route element={<RequireSetup />}>
                  {/* 首页固定去菜谱库：两人都能点单也能掌勺，不再按身份分叉 */}
                  <Route path="/" element={<Navigate to="/library" replace />} />
                  <Route path="/library" element={<Library />} />
                  <Route path="/recipe/:id" element={<RecipeDetail />} />
                  <Route path="/add" element={<AddRecipe />} />
                  <Route path="/order" element={<OrderScreen />} />
                  <Route path="/cook" element={<CookToday />} />
                  <Route path="/sync" element={<SyncScreen />} />
                  {/* 分享链接的落点（瞬时页，见 OpenOrder） */}
                  <Route path="/o/:id" element={<OpenOrder />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </ErrorBoundary>
          </BackGuard>
        </SyncProvider>
      </ToastProvider>
    </StoreProvider>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
