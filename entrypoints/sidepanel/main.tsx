/**
 * The side panel: the same UI as the popup, docked beside the page.
 *
 * Why it exists: Chrome closes a popup the moment the browser loses focus,
 * so switching to another app mid-sync or mid-trade dropped the user out,
 * and the trade panel (which advances the trade while it is open) stopped.
 * The side panel stays until the user clicks its X. The toolbar icon opens
 * it; see background.ts.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../popup/App';
import '../popup/style.css';
import '../popup/ghosty.css';

const root = document.getElementById('root');
if (!root) throw new Error('side panel root missing');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
