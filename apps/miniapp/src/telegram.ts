/* eslint-disable @typescript-eslint/no-explicit-any */
type TelegramWebApp = {
  initData: string;
  initDataUnsafe: {
    user?: { id: number; first_name: string };
    start_param?: string;
  };
  themeParams: Record<string, string>;
  colorScheme: 'light' | 'dark';
  version?: string;
  ready: () => void;
  expand: () => void;
  enableClosingConfirmation?: () => void;
  // Bot API 7.7 (iOS): turns off the swipe-down-to-close gesture so that
  // pulling on the page doesn't drag the WebApp away.
  disableVerticalSwipes?: () => void;
  // Bot API 8.0 (iOS): keep the mini app at full height so a scroll past
  // the top doesn't shrink the WebApp into "compact" mode.
  requestFullscreen?: () => void;
  isVersionAtLeast?: (v: string) => boolean;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const DEV_FALLBACK_INIT_DATA = import.meta.env.VITE_DEV_INIT_DATA as string | undefined;

export function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function getInitData(): string {
  const wa = getWebApp();
  if (wa?.initData) return wa.initData;
  if (DEV_FALLBACK_INIT_DATA) return DEV_FALLBACK_INIT_DATA;
  return '';
}

export function applyThemeFromTelegram(): void {
  const wa = getWebApp();
  if (!wa) return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(wa.themeParams)) {
    root.style.setProperty(`--tg-${key.replaceAll('_', '-')}`, value);
  }
  root.dataset.theme = wa.colorScheme;
}

/**
 * Reads the `start_param` value either from Telegram's initDataUnsafe (preferred,
 * present when the Mini App is launched from a deep link with `?startapp=…`) or
 * from `?tgWebAppStartParam=…` in the URL (fallback for browser dev).
 */
export function getStartParam(): string | null {
  const wa = getWebApp();
  if (wa?.initDataUnsafe?.start_param) return wa.initDataUnsafe.start_param;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('tgWebAppStartParam');
  } catch {
    return null;
  }
}

export function initTelegram(): void {
  const wa = getWebApp();
  if (!wa) return;
  wa.ready();
  wa.expand();
  // iOS: prevent the swipe-down-to-close gesture so pulling on the page
  // doesn't drag the WebApp away. Safe to call on older clients — they
  // either expose the method or we no-op via the optional chain.
  try {
    wa.disableVerticalSwipes?.();
  } catch {
    // older clients throw on unknown methods — ignore
  }
  applyThemeFromTelegram();
}
