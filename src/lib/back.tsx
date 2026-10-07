import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';

/**
 * 手机返回键（安卓物理返回键 / 全面屏手势返回）的接管。
 *
 * 为什么非接管不可：Capacitor 的 WebView 自己不处理返回键 —— 不接管的话，
 * 按返回就是直接 finish 掉 Activity，也就是**关掉应用回到桌面**。于是「添加菜谱」
 * 「菜谱详情」这类二级页上按返回，用户期望的回上一屏变成了退出应用。
 *
 * 接管后按三层决策（见 backAction）：
 *   1. 有遮罩（菜谱库长按删除提示、掌勺的菜品详情）→ 先关遮罩；
 *   2. 当前屏是一级页（底部四格 / 首次设置）→ 直接交给 Capacitor 退出应用。
 *      一级页**不互相回退**：从设置、点单、菜谱库按返回就是回桌面，不该退回
 *      「上一次用过的一级页」；
 *   3. 二级页（详情 / 添加）→ 有来路就回上一屏，深链进来没来路才落到菜谱库。
 *
 * 真机靠 `@capacitor/app` 的 backButton 事件接进 pressBack()；网页端浏览器自己管
 * 返回键，这里不接线（Capacitor.isNativePlatform() 为 false，退出分支也不执行）。
 */

export type NavType = 'PUSH' | 'POP' | 'REPLACE';
export type BackAction = 'overlay' | 'page' | 'home' | 'exit' | 'idle';

/** 一级页：底部四格那几屏 + 首次设置。它们上面按返回 = 退出应用 */
export const ROOT_PATHS = ['/', '/library', '/order', '/cook', '/sync', '/setup'];

/** 二级页没有来路（深链进来）时的兜底落点 */
export const HOME = '/library';

/** 当前屏是不是一级页（尾斜杠无所谓） */
export function isRootPath(pathname: string): boolean {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return ROOT_PATHS.includes(p);
}

/** 返回键决策（纯函数，便于单测）：先关遮罩 → 一级页直接退出 → 二级页回上一屏 */
export function backAction(o: {
  hasOverlay: boolean;
  /** 当前屏是一级页（底部四格 / 首次设置） */
  root: boolean;
  /** 页内返回栈深度，1 表示没有来路 */
  level: number;
  native: boolean;
}): BackAction {
  if (o.hasOverlay) return 'overlay';
  if (o.root) return o.native ? 'exit' : 'idle';
  if (o.level > 1) return 'page';
  /* 二级页但没来路（深链进来的）：落回菜谱库，别让用户卡在原地 */
  return 'home';
}

/**
 * 页内返回栈：push 加深一层、pop 变浅一层、replace 换掉栈顶（首个条目落栈）。
 * 栈深 > 1 才表示「还有上一屏可回」—— 光看 history.length 不行，它在 WebView 里只增不减。
 */
export function trackHistory(stack: readonly string[], key: string, type: NavType): string[] {
  if (!stack.length) return [key];
  if (type === 'PUSH') return [...stack, key];
  if (type === 'POP') return stack.length > 1 ? stack.slice(0, -1) : [...stack];
  return [...stack.slice(0, -1), key];
}

/* ─── 返回键登记口 ───────────────────────────── */

type Hook = () => void;

const backHooks = new Set<Hook>();
/** 遮罩栈：返回键先关盖在最上面的那层 */
const overlayClosers: Hook[] = [];

/**
 * 按下返回键：真机由 `@capacitor/app` 的 backButton 事件调这里，冒烟测试也走同一条路径，
 * 不另开测试专用分支。
 */
export function pressBack(): void {
  backHooks.forEach((fn) => fn());
}

/** 关掉最上面那层遮罩；一层都没有时返回 false */
export function closeTopOverlay(): boolean {
  const close = overlayClosers[overlayClosers.length - 1];
  if (!close) return false;
  close();
  return true;
}

/** 遮罩式界面开着时登记「返回键先关我」，关闭 / 卸载时自动注销 */
export function useBackClose(open: boolean, close: () => void): void {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  }, [close]);
  useEffect(() => {
    if (!open) return;
    const fn = () => latest.current();
    overlayClosers.push(fn);
    return () => {
      const i = overlayClosers.lastIndexOf(fn);
      if (i !== -1) overlayClosers.splice(i, 1);
    };
  }, [open]);
}

/* ─── 路由侧接线 ─────────────────────────────── */

interface BackCtx {
  /** 当前屏在页内返回栈里的层数：1 表示已经站在根屏上 */
  level: () => number;
}

const Ctx = createContext<BackCtx | null>(null);

/** 挂在路由内层（AppShell 里包住 Routes），接管整站的返回键 */
export function BackGuard({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType() as NavType;
  const stack = useRef<string[]>([]);
  const seen = useRef<string | null>(null);

  /* 记台账：每次路由变化更新返回栈，物理返回键据此判断「能回上一屏」还是「该退出」 */
  useEffect(() => {
    if (seen.current === location.key) return;
    seen.current = location.key;
    stack.current = trackHistory(stack.current, location.key, navType);
  }, [location.key, navType]);

  const level = useCallback(() => stack.current.length, []);

  useEffect(() => {
    const fn = () => {
      const action = backAction({
        hasOverlay: overlayClosers.length > 0,
        root: isRootPath(location.pathname),
        level: stack.current.length,
        native: Capacitor.isNativePlatform(),
      });
      if (action === 'overlay') closeTopOverlay();
      else if (action === 'page') navigate(-1);
      else if (action === 'home') navigate(HOME, { replace: true });
      else if (action === 'exit') void App.exitApp();
    };
    backHooks.add(fn);
    return () => {
      backHooks.delete(fn);
    };
  }, [navigate, location.pathname]);

  /* 真机接线：backButton 事件 → 统一入口。网页端不接线，交给浏览器自己的返回 */
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let dropped = false;
    let handle: PluginListenerHandle | null = null;
    void App.addListener('backButton', () => pressBack()).then((h) => {
      if (dropped) void h.remove();
      else handle = h;
    });
    return () => {
      dropped = true;
      if (handle) void handle.remove();
    };
  }, []);

  const value = useMemo(() => ({ level }), [level]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * 二级页「返回」按钮 / 保存、删除后的收尾：能页内回退就回退，否则落到 fallback
 * （用 replace 落屏，不给返回键留下一个已经离开的屏）。
 * 屏内按钮与物理返回键共用这套判断，两条路走出来的结果一致。
 */
export function usePageBack(fallback: string): () => void {
  const ctx = useContext(Ctx);
  const navigate = useNavigate();
  return useCallback(() => {
    if (ctx && ctx.level() > 1) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [ctx, navigate, fallback]);
}
