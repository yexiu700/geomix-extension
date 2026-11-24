import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  clearCapturedShadowRoots,
  installDomPolyfills,
  installShadowRootSpy,
} from './harness/dom-harness.js';

// Enable React 19 act() support in jsdom
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

installDomPolyfills();
installShadowRootSpy();

const pristinePushState =
  typeof window !== 'undefined'
    ? Object.getOwnPropertyDescriptor(History.prototype, 'pushState')
    : undefined;
const pristineReplaceState =
  typeof window !== 'undefined'
    ? Object.getOwnPropertyDescriptor(History.prototype, 'replaceState')
    : undefined;

// Capture baseline window own keys AFTER polyfills & shadow spy installation
const PROTECTED_WINDOW_PREFIXES = ['__vitest', '__vite'] as const;
const PROTECTED_WINDOW_KEYS = new Set<string | symbol>([
  'chrome',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
]);

const baselineWindowKeys: ReadonlySet<string | symbol> =
  typeof window !== 'undefined' ? new Set(Reflect.ownKeys(window)) : new Set();

// Track SPA/navigation listeners registered on window during tests so stale
// content-script popstate/hashchange handlers cannot leak across tests in the same fork
const NAV_EVENT_TYPES = new Set([
  'popstate',
  'hashchange',
  'pageshow',
  'beforeunload',
  'message',
]);

type TrackedListener = {
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
};

const trackedWindowListeners = new Set<TrackedListener>();

if (typeof window !== 'undefined') {
  const origAdd = window.addEventListener.bind(window);
  const origRemove = window.removeEventListener.bind(window);

  window.addEventListener = function patchedAddEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener && NAV_EVENT_TYPES.has(type)) {
      trackedWindowListeners.add({ type, listener, options });
    }
    origAdd(type, listener as EventListenerOrEventListenerObject, options);
  };

  window.removeEventListener = function patchedRemoveEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (listener && NAV_EVENT_TYPES.has(type)) {
      for (const entry of trackedWindowListeners) {
        if (entry.type === type && entry.listener === listener) {
          trackedWindowListeners.delete(entry);
        }
      }
    }
    origRemove(type, listener as EventListenerOrEventListenerObject, options);
  };
}

function cleanupWindowTestState(): void {
  if (typeof window === 'undefined') {
    return;
  }

  // 1. Remove stale navigation listeners from previous content-script boots
  for (const entry of Array.from(trackedWindowListeners)) {
    window.removeEventListener(entry.type, entry.listener, entry.options);
  }
  trackedWindowListeners.clear();

  // 2. Delete non-baseline configurable own keys added to window during the test
  const winRecord = window as unknown as Record<string | symbol, unknown>;
  for (const key of Reflect.ownKeys(window)) {
    if (baselineWindowKeys.has(key) || PROTECTED_WINDOW_KEYS.has(key)) {
      continue;
    }
    if (
      typeof key === 'string' &&
      PROTECTED_WINDOW_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(window, key);
    if (desc?.configurable) {
      try {
        delete winRecord[key];
      } catch {
        // ignore non-deletable host properties
      }
    }
  }

  // 3. Defensively clear any __geomix* runtime flags
  for (const key of Object.keys(window)) {
    if (key.startsWith('__geomix')) {
      try {
        delete winRecord[key];
      } catch {
        // ignore
      }
    }
  }
}

function cleanupDocumentDom(): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.documentElement) {
    for (const child of Array.from(document.documentElement.children)) {
      if (child !== document.head && child !== document.body) {
        child.remove();
      }
    }
  }
  if (document.body) {
    document.body.innerHTML = '';
  }
  if (document.head) {
    document.head.innerHTML = '';
  }
}

beforeEach(() => {
  cleanupWindowTestState();
  cleanupDocumentDom();
  clearCapturedShadowRoots();
});

afterEach(() => {
  cleanup();

  if (typeof window !== 'undefined') {
    if (pristinePushState) {
      Object.defineProperty(History.prototype, 'pushState', pristinePushState);
      if (Object.prototype.hasOwnProperty.call(window.history, 'pushState')) {
        delete (window.history as unknown as Record<string, unknown>).pushState;
      }
    }
    if (pristineReplaceState) {
      Object.defineProperty(History.prototype, 'replaceState', pristineReplaceState);
      if (Object.prototype.hasOwnProperty.call(window.history, 'replaceState')) {
        delete (window.history as unknown as Record<string, unknown>).replaceState;
      }
    }

    cleanupWindowTestState();

    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // ignore opaque origin storage errors
    }

    cleanupDocumentDom();
  }

  clearCapturedShadowRoots();
  vi.useRealTimers();
});
