// First: no eval probe under the Content-Security-Policy (lib/no-eval.ts).
import './lib/no-eval';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createAppRouter, createQueryClient } from './app/router';
import { applyPrefs, getPrefs } from './lib/prefs';
import { trackActivity } from './lib/activity';
import './styles.css';

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

applyPrefs(getPrefs());
// Requests count as the person's activity only right after they interact (lib/activity.ts).
trackActivity();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
