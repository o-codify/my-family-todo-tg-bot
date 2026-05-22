import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ToastProvider } from './components/Toast';
import './styles/global.css';

/**
 * Multiplayer-flavoured query defaults.
 *
 * Until we get push (BullMQ + WebSocket / Telegram update fan-out) we lean
 * on TanStack's polling so that what one family member did shows up for the
 * others without a manual refresh. Numbers tuned for the Telegram WebApp:
 *  - `refetchInterval: 8s`            — background polling cadence. With
 *    `staleTime: 5s` repeat work is suppressed when the user just acted.
 *  - `refetchOnWindowFocus: true`     — coming back to the tab/app refetches
 *    immediately (iOS especially: the WebApp is suspended in the background).
 *  - `refetchIntervalInBackground: false` — don't keep polling when the page
 *    is hidden; we'd rather pay the focus-refetch than burn battery.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      refetchInterval: 8_000,
      refetchIntervalInBackground: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
