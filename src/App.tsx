import { useEffect } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { StoreProvider, useStore } from './data/store';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SyncProvider } from './lib/useSync';
import { BackGuard } from './lib/back';
import { installLongPressGuard } from './lib/gestures';

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
