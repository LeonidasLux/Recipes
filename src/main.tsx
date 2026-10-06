import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import './styles/screens.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
