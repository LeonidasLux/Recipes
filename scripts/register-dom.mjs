/* 用 node --import 预加载：必须在 bundle 里任何模块（尤其是 react-dom）求值之前
   就把 jsdom 的 window/document 装到全局。

   为什么不能用 `import './dom-env'`：esbuild 会把那个文件内联进 bundle，
   于是它变成「模块体」的一部分，而 ESM 会先把所有 import 求值完再跑模块体 ——
   react-dom 就会在 document 还不存在时完成初始化（isEventSupported('input') 判false），
   结果是纯 jsdom 环境下受控 input 的 onChange 永远不触发。 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true },
);

/* Node 里部分全局（navigator 等）是只读 getter，统一用 defineProperty 覆盖 */
function install(key, value) {
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

install('window', dom.window);
install('document', dom.window.document);
install('navigator', dom.window.navigator);
install('HTMLElement', dom.window.HTMLElement);
install('HTMLInputElement', dom.window.HTMLInputElement);
install('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
install('Element', dom.window.Element);
install('Node', dom.window.Node);
install('Event', dom.window.Event);
install('InputEvent', dom.window.InputEvent);
install('MouseEvent', dom.window.MouseEvent);
install('KeyboardEvent', dom.window.KeyboardEvent);
install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
install('localStorage', dom.window.localStorage);
install('sessionStorage', dom.window.sessionStorage);
install('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
install('cancelAnimationFrame', (id) => clearTimeout(id));
install('IS_REACT_ACT_ENVIRONMENT', true);
