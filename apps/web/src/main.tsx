import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app/App';
import './ui/tokens.css';
import './ui/base.css';

const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
