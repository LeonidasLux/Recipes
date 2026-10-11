import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.leonidaslux.jishiben',
  appName: '记食本',
  webDir: 'dist',

  /* 应用整体只跟 https 打交道（api.github.com），不需要放开混合内容 */
  android: {
    allowMixedContent: false,
    backgroundColor: '#FCF7ED',
    /* 输入法 / 剪贴板 / 文字选区一律交回 WebView 自己管，别开 Capacitor 的
       input capture 开关（曾经在这儿开着）：它会把 WebView 的输入连接换成
       BaseInputConnection，于是从手机剪贴板点一下粘贴，字只被塞进 DOM、不发 input 事件，
       React 的受控 value 下一次渲染又把它抹掉 —— 表现就是「粘贴没反应」；
       长按选区菜单与输入法候选词也跟着走形。
       「键盘挡住输入框」那件事改由清单里的 windowSoftInputMode="adjustResize" 解决
       （见 android/app/src/main/AndroidManifest.xml）；布局本来就按 100dvh 伸缩，
       WebView 被顶小了会跟着收，弹键盘时输入框自然在键盘上面。 */
  },

  server: {
    /* WebView 里的页面源是 https://localhost —— 跨域规则和浏览器一致，
       api.github.com 给的是 Access-Control-Allow-Origin: *，所以同步照常可用 */
    androidScheme: 'https',
  },
};

export default config;
