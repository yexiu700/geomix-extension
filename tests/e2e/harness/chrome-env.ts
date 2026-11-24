import { vi } from 'vitest';
import {
  EXPECTED_HOST_PERMISSIONS,
  EXPECTED_MANIFEST_PERMISSIONS,
  EXPECTED_OPTIONAL_HOST_PERMISSIONS,
  type ManifestV3Shape,
} from './contract-types.js';
import { getCapturedShadowRoots } from './dom-harness.js';

export type RuntimeContext =
  | { kind: 'sw' }
  | { kind: 'popup' }
  | { kind: 'content'; tabId: number; url?: string };

export type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void | Promise<unknown>;

export type TabUpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
) => void;

export type TabRemovedListener = (
  tabId: number,
  removeInfo: chrome.tabs.OnRemovedInfo,
) => void;

export type TabCreatedListener = (tab: chrome.tabs.Tab) => void;

export type StorageChangedListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: 'local' | 'session' | 'sync' | 'managed',
) => void;

export interface ChromeMv3EnvOptions {
  extensionId?: string;
  manifest?: ManifestV3Shape;
  permissionPolicy?:
    | 'grant'
    | 'deny'
    | ((req: chrome.permissions.Permissions) => boolean | Promise<boolean>);
  initialTabs?: Array<{ id?: number; url: string; active?: boolean; status?: string }>;
  autoCompleteNewTabs?: boolean;
}

export interface RecordedContentMessage {
  tabId: number;
  payload: unknown;
}

export interface RecordedRuntimeMessage {
  senderKind: 'popup' | 'content';
  tabId?: number;
  payload: unknown;
}

export interface ChromeMv3Controller {
  readonly chrome: typeof chrome;
  readonly localStore: Map<string, unknown>;
  readonly sessionStore: Map<string, unknown>;
  readonly tabs: Map<number, chrome.tabs.Tab>;
  readonly grantedOrigins: Set<string>;
  readonly permissionRequests: chrome.permissions.Permissions[];
  readonly contentBoundMessages: RecordedContentMessage[];
  readonly runtimeMessages: RecordedRuntimeMessage[];
  readonly scriptingInvocations: Array<{ kind: 'executeScript' | 'insertCSS'; args: unknown }>;
  readonly consoleEntries: Array<{ level: string; args: unknown[] }>;
  setContext(ctx: RuntimeContext): void;
  withContext<T>(ctx: RuntimeContext, fn: () => Promise<T> | T): Promise<T>;
  setPermissionPolicy(
    policy:
      | 'grant'
      | 'deny'
      | ((req: chrome.permissions.Permissions) => boolean | Promise<boolean>),
  ): void;
  setTabAutoBootHandler(
    handler: ((tab: chrome.tabs.Tab) => Promise<void> | void) | null,
  ): void;
  attachTabContentListener(tabId: number, listener: MessageListener): () => void;
  clearTabContentListeners(tabId: number): void;
  updateTabUrl(
    tabId: number,
    url: string,
    status?: 'loading' | 'complete',
  ): chrome.tabs.Tab;
  removeTab(tabId: number): void;
  sendFromPopup<T = unknown>(message: unknown): Promise<T>;
  sendFromContent<T = unknown>(tabId: number, message: unknown): Promise<T>;
  sendToTab<T = unknown>(tabId: number, message: unknown): Promise<T>;
  simulateServiceWorkerRestart(bootSwFn: () => Promise<unknown>): Promise<void>;
  captureConsoleLogs(): () => void;
  assertZeroTokenLeakage(tokenOrSentinel: string): void;
  resetAll(): void;
  restore(): void;
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}

function matchChromePattern(pattern: string, urlStr: string): boolean {
  if (pattern === '<all_urls>') {
    return true;
  }
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(urlStr);
}

function createDefaultManifest(): ManifestV3Shape {
  return {
    manifest_version: 3,
    name: 'GeoMix Extension',
    version: '0.1.0',
    description: 'GeoMix MV3 companion extension',
    permissions: [...EXPECTED_MANIFEST_PERMISSIONS],
    host_permissions: [...EXPECTED_HOST_PERMISSIONS],
    optional_host_permissions: [...EXPECTED_OPTIONAL_HOST_PERMISSIONS],
    background: { service_worker: 'background.js', type: 'module' },
  };
}

function createStorageArea(
  areaName: 'local' | 'session',
  backingMap: Map<string, unknown>,
  onChangedListeners: Set<StorageChangedListener>,
) {
  const emitChanges = (
    changes: Record<string, chrome.storage.StorageChange>,
  ): void => {
    if (Object.keys(changes).length === 0) {
      return;
    }
    for (const listener of onChangedListeners) {
      listener(cloneValue(changes), areaName);
    }
  };

  const get = (
    keys?: string | string[] | Record<string, unknown> | null,
    callback?: (items: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> => {
    const result: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      for (const [k, v] of backingMap.entries()) {
        result[k] = cloneValue(v);
      }
    } else if (typeof keys === 'string') {
      if (backingMap.has(keys)) {
        result[keys] = cloneValue(backingMap.get(keys));
      }
    } else if (Array.isArray(keys)) {
      for (const k of keys) {
        if (backingMap.has(k)) {
          result[k] = cloneValue(backingMap.get(k));
        }
      }
    } else {
      for (const [k, defaultVal] of Object.entries(keys)) {
        result[k] = backingMap.has(k)
          ? cloneValue(backingMap.get(k))
          : cloneValue(defaultVal);
      }
    }
    if (callback) {
      callback(result);
    }
    return Promise.resolve(result);
  };

  const set = (
    items: Record<string, unknown>,
    callback?: () => void,
  ): Promise<void> => {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      const oldValue = backingMap.has(k) ? cloneValue(backingMap.get(k)) : undefined;
      const newValue = cloneValue(v);
      backingMap.set(k, newValue);
      changes[k] = { oldValue, newValue };
    }
    emitChanges(changes);
    if (callback) {
      callback();
    }
    return Promise.resolve();
  };

  const remove = (
    keys: string | string[],
    callback?: () => void,
  ): Promise<void> => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const k of keyList) {
      if (backingMap.has(k)) {
        changes[k] = { oldValue: cloneValue(backingMap.get(k)), newValue: undefined };
        backingMap.delete(k);
      }
    }
    emitChanges(changes);
    if (callback) {
      callback();
    }
    return Promise.resolve();
  };

  const clear = (callback?: () => void): Promise<void> => {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [k, v] of backingMap.entries()) {
      changes[k] = { oldValue: cloneValue(v), newValue: undefined };
    }
    backingMap.clear();
    emitChanges(changes);
    if (callback) {
      callback();
    }
    return Promise.resolve();
  };

  const getBytesInUse = (
    keys?: string | string[] | null,
    callback?: (bytesInUse: number) => void,
  ): Promise<number> => {
    let subset: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      subset = Object.fromEntries(backingMap.entries());
    } else {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        if (backingMap.has(k)) {
          subset[k] = backingMap.get(k);
        }
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(subset)).byteLength;
    if (callback) {
      callback(bytes);
    }
    return Promise.resolve(bytes);
  };

  return {
    get,
    set,
    remove,
    clear,
    getBytesInUse,
    onChanged: {
      addListener(listener: (changes: Record<string, chrome.storage.StorageChange>) => void) {
        const wrapped: StorageChangedListener = (changes, changedArea) => {
          if (changedArea === areaName) {
            listener(changes);
          }
        };
        onChangedListeners.add(wrapped);
      },
      removeListener() {
        // no-op for simplified per-area listener
      },
      hasListener() {
        return false;
      },
    },
  };
}

function invokeListeners(
  listeners: Iterable<MessageListener>,
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<{ handled: boolean; response: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let asyncPending = false;
    let anyHandled = false;

    const finish = (response: unknown): void => {
      if (!settled) {
        settled = true;
        resolve({ handled: true, response: cloneValue(response) });
      }
    };

    for (const listener of listeners) {
      anyHandled = true;
      try {
        const ret = listener(cloneValue(message), cloneValue(sender), (resp) => {
          finish(resp);
        });
        if (ret === true) {
          asyncPending = true;
        } else if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          asyncPending = true;
          (ret as Promise<unknown>).then(
            (val) => finish(val),
            (err) => {
              if (!settled) {
                settled = true;
                reject(err);
              }
            },
          );
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }
    }

    if (!settled && !asyncPending) {
      settled = true;
      resolve({ handled: anyHandled, response: undefined });
    }
  });
}

export function createChromeMv3Env(
  options: ChromeMv3EnvOptions = {},
): ChromeMv3Controller {
  const extensionId = options.extensionId ?? 'geomixdemoextensionid000000000001';
  const manifest = options.manifest ?? createDefaultManifest();
  let permissionPolicy = options.permissionPolicy ?? 'grant';
  const autoCompleteNewTabs = options.autoCompleteNewTabs ?? true;

  const localStore = new Map<string, unknown>();
  const sessionStore = new Map<string, unknown>();
  const storageOnChangedListeners = new Set<StorageChangedListener>();

  const tabsMap = new Map<number, chrome.tabs.Tab>();
  let nextTabId = 100;

  const grantedOrigins = new Set<string>(manifest.host_permissions ?? []);
  const permissionRequests: chrome.permissions.Permissions[] = [];
  const contentBoundMessages: RecordedContentMessage[] = [];
  const runtimeMessages: RecordedRuntimeMessage[] = [];
  const scriptingInvocations: Array<{
    kind: 'executeScript' | 'insertCSS';
    args: unknown;
  }> = [];
  const consoleEntries: Array<{ level: string; args: unknown[] }> = [];

  const swRuntimeListeners = new Set<MessageListener>();
  const tabContentListeners = new Map<number, Set<MessageListener>>();
  const tabCreatedListeners = new Set<TabCreatedListener>();
  const tabUpdatedListeners = new Set<TabUpdatedListener>();
  const tabRemovedListeners = new Set<TabRemovedListener>();
  const installedListeners = new Set<() => void>();
  const startupListeners = new Set<() => void>();

  let currentContext: RuntimeContext = { kind: 'sw' };
  let runtimeLastError: chrome.runtime.LastError | undefined;
  let consoleRestore: (() => void) | null = null;
  let tabAutoBootHandler: ((tab: chrome.tabs.Tab) => Promise<void> | void) | null =
    null;

  const previousChrome = (globalThis as unknown as { chrome?: typeof chrome }).chrome;

  if (options.initialTabs) {
    for (const initTab of options.initialTabs) {
      const id = initTab.id ?? nextTabId++;
      if (id >= nextTabId) {
        nextTabId = id + 1;
      }
      tabsMap.set(id, {
        id,
        index: tabsMap.size,
        windowId: 1,
        highlighted: Boolean(initTab.active),
        active: Boolean(initTab.active),
        pinned: false,
        incognito: false,
        selected: Boolean(initTab.active),
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
        url: initTab.url,
        status: initTab.status ?? 'complete',
      } as chrome.tabs.Tab);
    }
  }

  const dispatchToSw = async <T = unknown>(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<T> => {
    runtimeLastError = undefined;
    if (swRuntimeListeners.size === 0) {
      const errMsg = 'Could not establish connection. Receiving end does not exist.';
      runtimeLastError = { message: errMsg };
      throw new Error(errMsg);
    }
    // Keep currentContext untouched across async SW handling so concurrent
    // chrome.runtime.sendMessage calls (e.g. LocalImageUploader concurrency = 2)
    // continue to observe the caller's content-tab sender context.
    const { response } = await invokeListeners(swRuntimeListeners, message, sender);
    return response as T;
  };

  const dispatchToTab = async <T = unknown>(
    tabId: number,
    message: unknown,
  ): Promise<T> => {
    runtimeLastError = undefined;
    contentBoundMessages.push({ tabId, payload: cloneValue(message) });
    const listeners = tabContentListeners.get(tabId);
    if (!listeners || listeners.size === 0) {
      const errMsg = 'Could not establish connection. Receiving end does not exist.';
      runtimeLastError = { message: errMsg };
      throw new Error(errMsg);
    }
    const tab = tabsMap.get(tabId);
    const sender: chrome.runtime.MessageSender = {
      id: extensionId,
      url: `chrome-extension://${extensionId}/background.js`,
    };
    const prevContext = currentContext;
    currentContext = { kind: 'content', tabId, url: tab?.url };
    try {
      const { response } = await invokeListeners(listeners, message, sender);
      return response as T;
    } finally {
      currentContext = prevContext;
    }
  };

  const chromeMock = {
    storage: {
      local: createStorageArea('local', localStore, storageOnChangedListeners),
      session: createStorageArea('session', sessionStore, storageOnChangedListeners),
      onChanged: {
        addListener(listener: StorageChangedListener) {
          storageOnChangedListeners.add(listener);
        },
        removeListener(listener: StorageChangedListener) {
          storageOnChangedListeners.delete(listener);
        },
        hasListener(listener: StorageChangedListener) {
          return storageOnChangedListeners.has(listener);
        },
      },
    },
    tabs: {
      create: vi.fn(
        async (
          createProperties: chrome.tabs.CreateProperties,
          callback?: (tab: chrome.tabs.Tab) => void,
        ): Promise<chrome.tabs.Tab> => {
          const id = nextTabId++;
          const active = createProperties.active ?? true;
          if (active) {
            for (const existing of tabsMap.values()) {
              existing.active = false;
            }
          }
          const tab: chrome.tabs.Tab = {
            id,
            index: tabsMap.size,
            windowId: createProperties.windowId ?? 1,
            highlighted: active,
            active,
            pinned: false,
            incognito: false,
            selected: active,
            discarded: false,
            autoDiscardable: true,
            groupId: -1,
            url: createProperties.url ?? 'about:blank',
            status: autoCompleteNewTabs ? 'complete' : 'loading',
          } as chrome.tabs.Tab;
          tabsMap.set(id, tab);
          for (const listener of tabCreatedListeners) {
            listener(cloneValue(tab));
          }
          if (tabAutoBootHandler) {
            const handler = tabAutoBootHandler;
            await controller.withContext(
              { kind: 'content', tabId: id, url: tab.url },
              () => handler(cloneValue(tab)),
            );
          }
          if (autoCompleteNewTabs && tab.url) {
            for (const listener of tabUpdatedListeners) {
              listener(
                id,
                { status: 'complete', url: tab.url },
                cloneValue(tab),
              );
            }
          }
          if (callback) {
            callback(cloneValue(tab));
          }
          return cloneValue(tab);
        },
      ),
      update: vi.fn(
        async (
          tabIdOrProps: number | chrome.tabs.UpdateProperties,
          updatePropertiesOrCb?:
            | chrome.tabs.UpdateProperties
            | ((tab?: chrome.tabs.Tab) => void),
          maybeCallback?: (tab?: chrome.tabs.Tab) => void,
        ): Promise<chrome.tabs.Tab> => {
          const tabId =
            typeof tabIdOrProps === 'number'
              ? tabIdOrProps
              : Array.from(tabsMap.values()).find((t) => t.active)?.id ?? -1;
          const props =
            typeof tabIdOrProps === 'number'
              ? ((typeof updatePropertiesOrCb === 'object'
                  ? updatePropertiesOrCb
                  : {}) as chrome.tabs.UpdateProperties)
              : tabIdOrProps;
          const callback =
            typeof updatePropertiesOrCb === 'function'
              ? updatePropertiesOrCb
              : maybeCallback;

          const tab = tabsMap.get(tabId);
          if (!tab) {
            throw new Error(`No tab with id: ${tabId}`);
          }
          if (props.active) {
            for (const existing of tabsMap.values()) {
              existing.active = existing.id === tabId;
            }
          }
          const changeInfo: chrome.tabs.OnUpdatedInfo = {};
          if (props.url !== undefined && props.url !== tab.url) {
            tab.url = props.url;
            tab.status = autoCompleteNewTabs ? 'complete' : 'loading';
            changeInfo.url = props.url;
            changeInfo.status = tab.status;
          }
          if (changeInfo.url || changeInfo.status) {
            for (const listener of tabUpdatedListeners) {
              listener(tabId, cloneValue(changeInfo), cloneValue(tab));
            }
          }
          if (callback) {
            callback(cloneValue(tab));
          }
          return cloneValue(tab);
        },
      ),
      get: vi.fn(
        async (
          tabId: number,
          callback?: (tab: chrome.tabs.Tab) => void,
        ): Promise<chrome.tabs.Tab> => {
          const tab = tabsMap.get(tabId);
          if (!tab) {
            throw new Error(`No tab with id: ${tabId}`);
          }
          if (callback) {
            callback(cloneValue(tab));
          }
          return cloneValue(tab);
        },
      ),
      query: vi.fn(
        async (
          queryInfo: chrome.tabs.QueryInfo,
          callback?: (result: chrome.tabs.Tab[]) => void,
        ): Promise<chrome.tabs.Tab[]> => {
          const matches = Array.from(tabsMap.values()).filter((tab) => {
            if (queryInfo.active !== undefined && tab.active !== queryInfo.active) {
              return false;
            }
            if (queryInfo.status !== undefined && tab.status !== queryInfo.status) {
              return false;
            }
            if (queryInfo.url !== undefined) {
              const patterns = Array.isArray(queryInfo.url)
                ? queryInfo.url
                : [queryInfo.url];
              const tabUrl = tab.url ?? '';
              if (!patterns.some((p) => matchChromePattern(p, tabUrl))) {
                return false;
              }
            }
            return true;
          });
          const cloned = matches.map((t) => cloneValue(t));
          if (callback) {
            callback(cloned);
          }
          return cloned;
        },
      ),
      remove: vi.fn(
        async (
          tabIds: number | number[],
          callback?: () => void,
        ): Promise<void> => {
          const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
          for (const id of ids) {
            tabsMap.delete(id);
            tabContentListeners.delete(id);
            for (const listener of tabRemovedListeners) {
              listener(id, { windowId: 1, isWindowClosing: false });
            }
          }
          if (callback) {
            callback();
          }
        },
      ),
      sendMessage: vi.fn(
        (
          tabId: number,
          message: unknown,
          optionsOrCallback?: unknown,
          maybeCallback?: (response: unknown) => void,
        ): Promise<unknown> | void => {
          const callback =
            typeof optionsOrCallback === 'function'
              ? (optionsOrCallback as (response: unknown) => void)
              : maybeCallback;

          const promise = dispatchToTab(tabId, message);
          if (callback) {
            promise.then(
              (resp) => callback(resp),
              () => callback(undefined),
            );
            return;
          }
          return promise;
        },
      ),
      onCreated: {
        addListener(listener: TabCreatedListener) {
          tabCreatedListeners.add(listener);
        },
        removeListener(listener: TabCreatedListener) {
          tabCreatedListeners.delete(listener);
        },
        hasListener(listener: TabCreatedListener) {
          return tabCreatedListeners.has(listener);
        },
      },
      onUpdated: {
        addListener(listener: TabUpdatedListener) {
          tabUpdatedListeners.add(listener);
        },
        removeListener(listener: TabUpdatedListener) {
          tabUpdatedListeners.delete(listener);
        },
        hasListener(listener: TabUpdatedListener) {
          return tabUpdatedListeners.has(listener);
        },
      },
      onRemoved: {
        addListener(listener: TabRemovedListener) {
          tabRemovedListeners.add(listener);
        },
        removeListener(listener: TabRemovedListener) {
          tabRemovedListeners.delete(listener);
        },
        hasListener(listener: TabRemovedListener) {
          return tabRemovedListeners.has(listener);
        },
      },
    },
    runtime: {
      id: extensionId,
      get lastError(): chrome.runtime.LastError | undefined {
        return runtimeLastError;
      },
      getManifest: vi.fn(() => cloneValue(manifest)),
      getURL: vi.fn((path: string) => {
        const clean = path.replace(/^\/+/, '');
        return `chrome-extension://${extensionId}/${clean}`;
      }),
      sendMessage: vi.fn(
        (
          message: unknown,
          optionsOrCallback?: unknown,
          maybeCallback?: (response: unknown) => void,
        ): Promise<unknown> | void => {
          const callback =
            typeof optionsOrCallback === 'function'
              ? (optionsOrCallback as (response: unknown) => void)
              : maybeCallback;

          const sender: chrome.runtime.MessageSender =
            currentContext.kind === 'content'
              ? {
                  id: extensionId,
                  tab: tabsMap.get(currentContext.tabId),
                  url:
                    currentContext.url ??
                    tabsMap.get(currentContext.tabId)?.url ??
                    (typeof window !== 'undefined' ? window.location.href : undefined),
                }
              : {
                  id: extensionId,
                  url: `chrome-extension://${extensionId}/src/popup/index.html`,
                };

          runtimeMessages.push({
            senderKind: currentContext.kind === 'content' ? 'content' : 'popup',
            tabId: currentContext.kind === 'content' ? currentContext.tabId : undefined,
            payload: cloneValue(message),
          });

          const promise = dispatchToSw(message, sender);
          if (callback) {
            promise.then(
              (resp) => callback(resp),
              () => callback(undefined),
            );
            return;
          }
          return promise;
        },
      ),
      onMessage: {
        addListener(listener: MessageListener) {
          if (currentContext.kind === 'content') {
            const set =
              tabContentListeners.get(currentContext.tabId) ??
              new Set<MessageListener>();
            set.add(listener);
            tabContentListeners.set(currentContext.tabId, set);
          } else {
            swRuntimeListeners.add(listener);
          }
        },
        removeListener(listener: MessageListener) {
          swRuntimeListeners.delete(listener);
          for (const set of tabContentListeners.values()) {
            set.delete(listener);
          }
        },
        hasListener(listener: MessageListener) {
          if (swRuntimeListeners.has(listener)) {
            return true;
          }
          for (const set of tabContentListeners.values()) {
            if (set.has(listener)) {
              return true;
            }
          }
          return false;
        },
      },
      onInstalled: {
        addListener(listener: () => void) {
          installedListeners.add(listener);
        },
        removeListener(listener: () => void) {
          installedListeners.delete(listener);
        },
        hasListener(listener: () => void) {
          return installedListeners.has(listener);
        },
      },
      onStartup: {
        addListener(listener: () => void) {
          startupListeners.add(listener);
        },
        removeListener(listener: () => void) {
          startupListeners.delete(listener);
        },
        hasListener(listener: () => void) {
          return startupListeners.has(listener);
        },
      },
    },
    permissions: {
      contains: vi.fn(
        async (
          permissions: chrome.permissions.Permissions,
          callback?: (result: boolean) => void,
        ): Promise<boolean> => {
          const origins = permissions.origins ?? [];
          const hasAll = origins.every((o) => grantedOrigins.has(o));
          if (callback) {
            callback(hasAll);
          }
          return hasAll;
        },
      ),
      request: vi.fn(
        async (
          permissions: chrome.permissions.Permissions,
          callback?: (granted: boolean) => void,
        ): Promise<boolean> => {
          permissionRequests.push(cloneValue(permissions));
          let granted = false;
          if (permissionPolicy === 'grant') {
            granted = true;
          } else if (permissionPolicy === 'deny') {
            granted = false;
          } else {
            granted = await permissionPolicy(cloneValue(permissions));
          }
          if (granted) {
            for (const origin of permissions.origins ?? []) {
              grantedOrigins.add(origin);
            }
          }
          if (callback) {
            callback(granted);
          }
          return granted;
        },
      ),
      remove: vi.fn(
        async (
          permissions: chrome.permissions.Permissions,
          callback?: (removed: boolean) => void,
        ): Promise<boolean> => {
          for (const origin of permissions.origins ?? []) {
            grantedOrigins.delete(origin);
          }
          if (callback) {
            callback(true);
          }
          return true;
        },
      ),
    },
    scripting: {
      executeScript: vi.fn(async (injection: unknown) => {
        scriptingInvocations.push({
          kind: 'executeScript',
          args: cloneValue(injection),
        });
        return [];
      }),
      insertCSS: vi.fn(async (injection: unknown) => {
        scriptingInvocations.push({
          kind: 'insertCSS',
          args: cloneValue(injection),
        });
      }),
    },
  } as unknown as typeof chrome;

  Object.defineProperty(globalThis, 'chrome', {
    value: chromeMock,
    writable: true,
    configurable: true,
  });

  const captureConsoleLogs = (): (() => void) => {
    if (consoleRestore) {
      return consoleRestore;
    }
    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = new Map<string, (...args: unknown[]) => void>();
    for (const level of levels) {
      const orig = console[level].bind(console);
      originals.set(level, orig);
      console[level] = (...args: unknown[]) => {
        consoleEntries.push({ level, args });
      };
    }
    consoleRestore = () => {
      for (const level of levels) {
        const orig = originals.get(level);
        if (orig) {
          console[level] = orig;
        }
      }
      consoleRestore = null;
    };
    return consoleRestore;
  };

  const controller: ChromeMv3Controller = {
    chrome: chromeMock,
    localStore,
    sessionStore,
    tabs: tabsMap,
    grantedOrigins,
    permissionRequests,
    contentBoundMessages,
    runtimeMessages,
    scriptingInvocations,
    consoleEntries,

    setContext(ctx: RuntimeContext) {
      currentContext = ctx;
    },

    async withContext<T>(
      ctx: RuntimeContext,
      fn: () => Promise<T> | T,
    ): Promise<T> {
      const prev = currentContext;
      currentContext = ctx;
      try {
        return await fn();
      } finally {
        currentContext = prev;
      }
    },

    setPermissionPolicy(policy) {
      permissionPolicy = policy;
    },

    setTabAutoBootHandler(handler) {
      tabAutoBootHandler = handler;
    },

    attachTabContentListener(tabId: number, listener: MessageListener) {
      const set = tabContentListeners.get(tabId) ?? new Set<MessageListener>();
      set.add(listener);
      tabContentListeners.set(tabId, set);
      return () => {
        set.delete(listener);
      };
    },

    clearTabContentListeners(tabId: number) {
      tabContentListeners.delete(tabId);
    },

    updateTabUrl(
      tabId: number,
      url: string,
      status: 'loading' | 'complete' = 'complete',
    ): chrome.tabs.Tab {
      const existing = tabsMap.get(tabId);
      if (!existing) {
        throw new Error(`No tab with id: ${tabId}`);
      }
      existing.url = url;
      existing.status = status;
      for (const listener of tabUpdatedListeners) {
        listener(tabId, { url, status }, cloneValue(existing));
      }
      return cloneValue(existing);
    },

    removeTab(tabId: number) {
      tabsMap.delete(tabId);
      tabContentListeners.delete(tabId);
      for (const listener of tabRemovedListeners) {
        listener(tabId, { windowId: 1, isWindowClosing: false });
      }
    },

    async sendFromPopup<T = unknown>(message: unknown): Promise<T> {
      return dispatchToSw<T>(message, {
        id: extensionId,
        url: `chrome-extension://${extensionId}/src/popup/index.html`,
      });
    },

    async sendFromContent<T = unknown>(
      tabId: number,
      message: unknown,
    ): Promise<T> {
      const tab = tabsMap.get(tabId);
      return dispatchToSw<T>(message, {
        id: extensionId,
        tab: tab ? cloneValue(tab) : undefined,
        url: tab?.url,
      });
    },

    async sendToTab<T = unknown>(tabId: number, message: unknown): Promise<T> {
      return dispatchToTab<T>(tabId, message);
    },

    async simulateServiceWorkerRestart(
      bootSwFn: () => Promise<unknown>,
    ): Promise<void> {
      // Preserve localStore, sessionStore, tabsMap, and tabContentListeners.
      // Wipe ONLY SW-owned listeners and all in-memory SW module state!
      swRuntimeListeners.clear();
      tabCreatedListeners.clear();
      tabUpdatedListeners.clear();
      tabRemovedListeners.clear();
      installedListeners.clear();
      startupListeners.clear();
      vi.resetModules();
      await controller.withContext({ kind: 'sw' }, async () => {
        await bootSwFn();
      });
    },

    captureConsoleLogs,

    assertZeroTokenLeakage(tokenOrSentinel: string) {
      const safeSerialize = (value: unknown): string => {
        try {
          if (typeof value === 'string') {
            return value;
          }
          if (value instanceof Error) {
            return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
          }
          return JSON.stringify(value) ?? String(value);
        } catch {
          return String(value);
        }
      };

      // 1. window.localStorage & window.sessionStorage
      if (typeof window !== 'undefined') {
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i) ?? '';
          const v = window.localStorage.getItem(k) ?? '';
          if (k.includes(tokenOrSentinel) || v.includes(tokenOrSentinel)) {
            throw new Error(
              `Token leakage detected in window.localStorage under key "${k}"`,
            );
          }
        }
        for (let i = 0; i < window.sessionStorage.length; i += 1) {
          const k = window.sessionStorage.key(i) ?? '';
          const v = window.sessionStorage.getItem(k) ?? '';
          if (k.includes(tokenOrSentinel) || v.includes(tokenOrSentinel)) {
            throw new Error(
              `Token leakage detected in window.sessionStorage under key "${k}"`,
            );
          }
        }
      }

      // 2. Host DOM + Shadow DOM (exclude masked <input type="password"> user-typed values)
      if (typeof document !== 'undefined') {
        const bodyText = document.body?.textContent ?? '';
        if (bodyText.includes(tokenOrSentinel)) {
          throw new Error('Token leakage detected in document.body textContent');
        }
        const clone = document.documentElement?.cloneNode(true) as
          | HTMLElement
          | undefined;
        if (clone) {
          for (const pwInput of Array.from(
            clone.querySelectorAll('input[type="password"]'),
          )) {
            pwInput.removeAttribute('value');
          }
          if (clone.innerHTML.includes(tokenOrSentinel)) {
            throw new Error(
              'Token leakage detected in non-password document DOM innerHTML',
            );
          }
        }
        for (const entry of getCapturedShadowRoots()) {
          if (entry.root.innerHTML.includes(tokenOrSentinel)) {
            throw new Error('Token leakage detected inside ShadowRoot innerHTML');
          }
        }
      }

      // 3. Console logs
      for (const entry of consoleEntries) {
        const serialized = entry.args.map(safeSerialize).join(' ');
        if (serialized.includes(tokenOrSentinel)) {
          throw new Error(
            `Token leakage detected in console.${entry.level} output`,
          );
        }
      }

      // 4. Content-bound IPC payloads (chrome.tabs.sendMessage)
      for (const msg of contentBoundMessages) {
        const serialized = safeSerialize(msg.payload);
        if (serialized.includes(tokenOrSentinel)) {
          throw new Error(
            `Token leakage detected in chrome.tabs.sendMessage payload to tab ${msg.tabId}`,
          );
        }
      }
    },

    resetAll() {
      localStore.clear();
      sessionStore.clear();
      tabsMap.clear();
      swRuntimeListeners.clear();
      tabContentListeners.clear();
      tabCreatedListeners.clear();
      tabUpdatedListeners.clear();
      tabRemovedListeners.clear();
      permissionRequests.length = 0;
      contentBoundMessages.length = 0;
      runtimeMessages.length = 0;
      scriptingInvocations.length = 0;
      consoleEntries.length = 0;
      tabAutoBootHandler = null;
    },

    restore() {
      if (consoleRestore) {
        consoleRestore();
      }
      if (previousChrome === undefined) {
        delete (globalThis as unknown as { chrome?: typeof chrome }).chrome;
      } else {
        Object.defineProperty(globalThis, 'chrome', {
          value: previousChrome,
          writable: true,
          configurable: true,
        });
      }
    },
  };

  return controller;
}
