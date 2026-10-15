import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createAppRouter, createQueryClient } from './app/router';
import { applyPrefs, getPrefs } from './lib/prefs';
import './styles.css';

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

applyPrefs(getPrefs());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
