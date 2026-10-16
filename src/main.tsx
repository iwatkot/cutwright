import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadPersistedTransitions } from './lib/store';
import './styles.css';

loadPersistedTransitions();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
