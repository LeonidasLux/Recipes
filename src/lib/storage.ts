/* ============================================================
   本机存储（localStorage）可用性探针

   token、仓库名、DeepSeek Key 都只存在本机 localStorage（不进仓库、不外发），
   而 localStorage 是**按来源隔离**的（协议 + 主机 + 端口）。所以「每次进来都要
   重填 token / 仓库 / Key」通常只有两种原因：

     ① 浏览器不让本站存数据 —— 无痕窗口，或者开了「关闭浏览器时清除 Cookie
        和站点数据」；
     ② 换了地址 —— localhost ↔ 局域网 IP、5173 ↔ 4173 都是**不同的来源**，
        各存各的一份，看起来就像「数据没了」。

   ① 在页面里当场就能探出来（写一次读一次），所以直接提示用户；
   ② 没法从页面里判断（另一个来源的数据这里根本看不见），只能靠 dev server
   别偷偷换端口（见 vite.config.ts 的 strictPort）。
   ============================================================ */

/**
 * 本机存不下数据？
 * 探针本身也会因为同样的原因失败：无痕模式下 Chrome 允许读、多数浏览器直接抛错。
 *
 * @returns 存不了（或压根没有 localStorage）返回 true
 */
export function localStorageBroken(): boolean {
  try {
    const key = 'jishiben-storage-probe';
    globalThis.localStorage.setItem(key, '1');
    globalThis.localStorage.removeItem(key);
    return false;
  } catch {
    return true;
  }
}
