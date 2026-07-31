import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './i18n';

// 一次性数据迁移:清除旧 uuid 项目(改用短 genId 后,旧 36 字符 uuid 项目作废)
try {
  const raw = localStorage.getItem('capybara-projects');
  if (raw) {
    const arr = JSON.parse(raw) as unknown;
    if (
      Array.isArray(arr) &&
      arr.some(
        (p: { id?: string }) => typeof p.id === 'string' && p.id.length === 36 && p.id.includes('-')
      )
    ) {
      localStorage.removeItem('capybara-projects');
      localStorage.removeItem('capybara-active-project-id');
      console.info('[capybara] cleared legacy uuid projects (migrated to short ids)');
    }
  }
} catch {
  /* ignore parse errors */
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
