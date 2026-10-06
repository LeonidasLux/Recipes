/* 把某个路由渲染后的真实 HTML 打到 stdout，用来做结构级目检。
   用法：
     npx esbuild scripts/dump.tsx --bundle --platform=node --format=esm --target=node20 \
       --loader:.css=empty --external:react --external:react-dom --external:react-dom/client \
       --external:react-router-dom --external:jsdom --outfile=.tmp/dump.mjs
     node --import ./scripts/register-dom.mjs .tmp/dump.mjs "/library"
   末尾加 --real-router 可走真正的 HashRouter（验证生成的是 #/... 链接）。   */



import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '../src/App';
import { DB_KEY, seed } from '../src/data/seed';

const db = seed();
db.configured = true;
db.config = {
  repo: 'xiaoman/family-recipes',
  branch: 'main',
  token: 'ghp_example_token_value',
  tokenMask: 'ghp_••••••••alue',
  me: (process.argv[3] as 'a' | 'b') ?? 'a',
  autoPull: true,
  intervalSec: 60,
  lastPulledAt: '12:05',
  lastPushedAt: '12:05',
};
localStorage.setItem(DB_KEY, JSON.stringify(db));

const path = process.argv[2] ?? '/library';
const useRealApp = process.argv.includes('--real-router');
const root = document.getElementById('root') as HTMLElement;

if (useRealApp) {
  /* 走真正的 App（HashRouter），验证生成的是 #/... 而不是 /... */
  window.location.hash = `#${path}`;
  const { default: App } = await import('../src/App');
  await act(async () => {
    createRoot(root).render(<App />);
  });
} else {
  await act(async () => {
    createRoot(root).render(
      <MemoryRouter initialEntries={[path]}>
        <AppShell />
      </MemoryRouter>,
    );
  });
}

await act(async () => {
  await new Promise((r) => setTimeout(r, 700));
});

/* 缩进一下，便于肉眼看嵌套 */
process.stdout.write(
  root.innerHTML.replace(/></g, '>\n<').replace(/\n(?=<)/g, '\n') + '\n',
);
process.exit(0);
