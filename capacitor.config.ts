import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.leonidaslux.jishiben',
  appName: '记食本',
  webDir: 'dist',

  /* 应用整体只跟 https 打交道（api.github.com），不需要放开混合内容 */
  android: {
    allowMixedContent: false,
    backgroundColor: '#FCF7ED',
    /* 键盘弹出时把 WebView 顶上去，否则输入框会被挡住 */
    captureInput: true,
  },

  server: {
    /* WebView 里的页面源是 https://localhost —— 跨域规则和浏览器一致，
       api.github.com 给的是 Access-Control-Allow-Origin: *，所以同步照常可用 */
    androidScheme: 'https',
  },
};

export default config;
