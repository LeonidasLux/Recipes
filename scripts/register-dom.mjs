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
install('DOMParser', dom.window.DOMParser);
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

/* jsdom 没有 canvas（没装 canvas npm 包）：把 getContext 明确固定成 null，
   等价于「这台设备没有 canvas 2d」。应用代码据此退回原始 data URL，
   顺带不用在每张图的压缩里刷一屏 jsdom 的「Not implemented」日志。 */
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return null;
};

/* ─── 虚拟时钟 ───────────────────────────────────────────────
   各屏的「进场骨架」、同步防抖、后台轮询都是 setTimeout / setInterval 驱动的。
   冒烟测试要挂载 60+ 次，每次都真的等 700ms 挂钟，整个套件因此要跑一分多钟 ——
   其中约 88% 的时间是在空等定时器。

   这里提供一个可推进的虚拟时钟：**未武装（arm 之前）一律透传真实定时器**，
   所以 dump / live-connect 这类走真实网络、依赖真实时间的脚本完全不受影响；
   只有主动调用 `globalThis.__domClock.arm()` 的脚本（冒烟测试）才改由
   `__domClock.advance(ms)` 显式推进时间，不再空等。

   只在 register-dom 里做（而不是在 bundle 里 import 一个模块），是因为 esbuild
   会把被 import 的模块内联进 bundle，得到的是另一份实例，状态对不上。 */

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);
const realSetImmediate = globalThis.setImmediate.bind(globalThis);

const clock = (() => {
  let armed = false;
  let now = 0;
  let seq = 1;
  /** id → { handle, repeat }（真实）或 { time, fn, args, every }（虚拟） */
  const tasks = new Map();

  function addTask(fn, ms, args, repeat) {
    const id = seq++;
    const delay = Math.max(0, Number(ms) || 0);
    if (!armed) {
      const fire = (...a) => {
        if (!repeat) tasks.delete(id);
        fn(...a);
      };
      const handle = repeat ? realSetInterval(fire, delay, ...args) : realSetTimeout(fire, delay, ...args);
      tasks.set(id, { handle, repeat });
      return id;
    }
    tasks.set(id, { time: now + delay, fn, args, every: repeat ? delay : null });
    return id;
  }

  function removeTask(id) {
    const t = tasks.get(id);
    if (!t) return;
    tasks.delete(id);
    if (t.handle !== undefined) (t.repeat ? realClearInterval : realClearTimeout)(t.handle);
  }

  /** 取 target 之内最早到期的一个虚拟任务（同刻按 id 先后，和真实定时器一致） */
  function earliestDue(target) {
    let best = null;
    for (const [id, t] of tasks) {
      if (t.time === undefined || t.time > target) continue;
      if (!best || t.time < best.t.time || (t.time === best.t.time && id < best.id)) best = { id, t };
    }
    return best;
  }

  /* 让出一整个事件循环回合：微任务队列会被冲干净，依赖真实宏任务的
     React 调度（Scheduler 走 MessageChannel）也能跑完。 */
  const drain = () => new Promise((r) => realSetImmediate(r));

  async function advance(ms) {
    const target = now + Math.max(0, Number(ms) || 0);
    let guard = 0;
    for (;;) {
      if (++guard > 20000) throw new Error('虚拟时钟：疑似有定时器在自我重排导致死循环');
      await drain();
      const next = earliestDue(target);
      if (next) {
        const { id, t } = next;
        if (t.time > now) now = t.time;
        if (t.every === null) tasks.delete(id);
        else t.time = now + t.every;
        t.fn(...t.args);
        continue;
      }
      if (now < target) {
        now = target;
        continue;
      }
      break;
    }
    await drain();
  }

  function arm() {
    armed = true;
    now = 0;
  }

  return {
    get armed() {
      return armed;
    },
    get now() {
      return now;
    },
    arm,
    advance,
    setTimeout: (fn, ms, ...args) => addTask(fn, ms, args, false),
    setInterval: (fn, ms, ...args) => addTask(fn, ms, args, true),
    clearTimeout: removeTask,
    clearInterval: removeTask,
  };
})();

Object.defineProperty(globalThis, '__domClock', {
  value: clock,
  writable: true,
  configurable: true,
  enumerable: false,
});

/* 应用代码里 window.setTimeout 与裸 setTimeout 都有（github.ts 用的是裸的），
   两边一起接管，避免漏网。 */
const timerGlobals = {
  setTimeout: clock.setTimeout,
  clearTimeout: clock.clearTimeout,
  setInterval: clock.setInterval,
  clearInterval: clock.clearInterval,
};
for (const [key, value] of Object.entries(timerGlobals)) {
  install(key, value);
  Object.defineProperty(dom.window, key, { value, writable: true, configurable: true, enumerable: false });
}
