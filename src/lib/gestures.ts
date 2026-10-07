/**
 * 长按手势的统一处理（手机上用 App 的形态用，长按是「删除」而不是选字）。
 *
 * 文字选中交给 CSS（`user-select: none`，见 `styles/app.css`）；这里只补一件
 * CSS 管不到的事：长按链接 / 图片时 WebView 会自己弹系统菜单（复制链接、存图、
 * 打开方式…），在 Android WebView 里就是那个 `contextmenu`。不拦下来的话，
 * 用户在菜谱库长按一条菜谱想删除，先冒出来的是系统的链接菜单。
 *
 * **输入框里必须放行** —— 那里需要选词、移动光标、粘贴。
 */

/** 落在输入框 / 可编辑区域里的长按该不该放行（放行 = 不拦系统菜单） */
export function keepsNativeLongPress(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, [contenteditable="true"]') !== null;
}

/** 在整页装一次长按菜单拦截；返回卸载函数 */
export function installLongPressGuard(doc: Document = document): () => void {
  const onContextMenu = (e: Event) => {
    if (!keepsNativeLongPress(e.target)) e.preventDefault();
  };
  doc.addEventListener('contextmenu', onContextMenu);
  return () => doc.removeEventListener('contextmenu', onContextMenu);
}
