import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

type EventListenerFn = (...args: unknown[]) => unknown;

interface MockChromeEvent {
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  hasListener: ReturnType<typeof vi.fn>;
  clearListeners: () => void;
  listeners: Set<EventListenerFn>;
}

function createMockEvent(): MockChromeEvent {
  const listeners = new Set<EventListenerFn>();
  return {
    listeners,
    addListener: vi.fn((fn: EventListenerFn) => {
      listeners.add(fn);
    }),
    removeListener: vi.fn((fn: EventListenerFn) => {
      listeners.delete(fn);
    }),
    hasListener: vi.fn((fn: EventListenerFn) => listeners.has(fn)),
    clearListeners: () => {
      listeners.clear();
    },
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

interface MockStorageArea {
  store: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  reset: () => void;
}

function createMockStorageArea(): MockStorageArea {
  const store = new Map<string, unknown>();

  const getImpl = async (
    keys?: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> => {
    const result: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      for (const [key, value] of store.entries()) {
        result[key] = cloneValue(value);
      }
      return result;
    }
    if (typeof keys === 'string') {
      if (store.has(keys)) {
        result[keys] = cloneValue(store.get(keys));
      }
      return result;
    }
    if (Array.isArray(keys)) {
      for (const key of keys) {
        if (store.has(key)) {
          result[key] = cloneValue(store.get(key));
        }
      }
      return result;
    }
    for (const [key, fallback] of Object.entries(keys)) {
      result[key] = store.has(key) ? cloneValue(store.get(key)) : cloneValue(fallback);
    }
    return result;
  };

  const setImpl = async (items: Record<string, unknown>): Promise<void> => {
    for (const [key, value] of Object.entries(items)) {
      store.set(key, cloneValue(value));
    }
  };

  const removeImpl = async (keys: string | string[]): Promise<void> => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      store.delete(key);
    }
  };

  const clearImpl = async (): Promise<void> => {
    store.clear();
  };

  const area: MockStorageArea = {
    store,
    get: vi.fn(getImpl),
    set: vi.fn(setImpl),
    remove: vi.fn(removeImpl),
    clear: vi.fn(clearImpl),
    reset() {
      store.clear();
      area.get.mockReset();
      area.get.mockImplementation(getImpl);
      area.set.mockReset();
      area.set.mockImplementation(setImpl);
      area.remove.mockReset();
      area.remove.mockImplementation(removeImpl);
      area.clear.mockReset();
      area.clear.mockImplementation(clearImpl);
    },
  };

  return area;
}

type PolyfillDataTransferItem = {
  readonly kind: 'file' | 'string';
  readonly type: string;
  getAsFile: () => File | null;
  getAsString: (callback: ((data: string) => void) | null) => void;
};

class PolyfillDataTransferItemList {
  readonly #files: File[] = [];
  readonly #strings: Map<string, string>;

  constructor(strings: Map<string, string>) {
    this.#strings = strings;
    return new Proxy(this, {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return target.#getItemAt(Number(prop));
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  #allItems(): PolyfillDataTransferItem[] {
    const fileItems: PolyfillDataTransferItem[] = this.#files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
      getAsString: () => {},
    }));
    const stringItems: PolyfillDataTransferItem[] = [...this.#strings.entries()].map(
      ([type, value]) => ({
        kind: 'string',
        type,
        getAsFile: () => null,
        getAsString: (callback) => {
          callback?.(value);
        },
      }),
    );
    return [...fileItems, ...stringItems];
  }

  #getItemAt(index: number): PolyfillDataTransferItem | undefined {
    return this.#allItems()[index];
  }

  get length(): number {
    return this.#files.length + this.#strings.size;
  }

  get files(): File[] {
    return this.#files;
  }

  add(data: File | string, type?: string): void {
    if (typeof data === 'string') {
      this.#strings.set(type ?? 'text/plain', data);
      return;
    }
    this.#files.push(data);
  }

  clear(): void {
    this.#files.length = 0;
    this.#strings.clear();
  }

  [Symbol.iterator](): IterableIterator<PolyfillDataTransferItem> {
    return this.#allItems()[Symbol.iterator]();
  }
}

function createFileList(files: File[]): FileList {
  const list: Record<number, File> & {
    length: number;
    item: (index: number) => File | null;
    [Symbol.iterator]: () => IterableIterator<File>;
  } = {
    get length() {
      return files.length;
    },
    item(index: number): File | null {
      return files[index] ?? null;
    },
    [Symbol.iterator](): IterableIterator<File> {
      return files[Symbol.iterator]();
    },
  };

  return new Proxy(list, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        return files[Number(prop)];
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as FileList;
}

class PolyfillDataTransfer {
  readonly #strings = new Map<string, string>();
  readonly items = new PolyfillDataTransferItemList(this.#strings);

  get files(): FileList {
    return createFileList(this.items.files);
  }

  get types(): readonly string[] {
    const keys = [...this.#strings.keys()];
    if (this.items.files.length > 0 && !keys.includes('Files')) {
      keys.push('Files');
    }
    return keys;
  }

  setData(format: string, data: string): void {
    this.#strings.set(format, data);
  }

  getData(format: string): string {
    return this.#strings.get(format) ?? '';
  }

  clearData(format?: string): void {
    if (format === undefined) {
      this.#strings.clear();
      return;
    }
    this.#strings.delete(format);
  }
}

class PolyfillClipboardEvent extends Event {
  readonly clipboardData: DataTransfer | null;

  constructor(
    type: string,
    eventInitDict?: {
      clipboardData?: DataTransfer | null;
      bubbles?: boolean;
      cancelable?: boolean;
      composed?: boolean;
    },
  ) {
    super(type, eventInitDict);
    this.clipboardData = eventInitDict?.clipboardData ?? null;
  }
}

if (typeof globalThis.DataTransfer === 'undefined') {
  Object.defineProperty(globalThis, 'DataTransfer', {
    value: PolyfillDataTransfer,
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.ClipboardEvent === 'undefined') {
  Object.defineProperty(globalThis, 'ClipboardEvent', {
    value: PolyfillClipboardEvent,
    configurable: true,
    writable: true,
  });
}

const localStorageArea = createMockStorageArea();
const sessionStorageArea = createMockStorageArea();
const runtimeOnMessage = createMockEvent();
const tabsOnUpdated = createMockEvent();
const tabsOnRemoved = createMockEvent();

const defaultManifest = () => ({
  manifest_version: 3,
  name: 'GeoMix 渠道草稿助手',
  version: '0.1.0',
});

const chromeMock = {
  storage: {
    local: localStorageArea,
    session: sessionStorageArea,
  },
  runtime: {
    id: 'geomix-test-extension-id',
    lastError: undefined as chrome.runtime.LastError | undefined,
    getManifest: vi.fn(defaultManifest),
    sendMessage: vi.fn(async () => ({ ok: true, data: null })),
    onMessage: runtimeOnMessage,
  },
  tabs: {
    query: vi.fn(async () => []),
    create: vi.fn(async (createProperties: chrome.tabs.CreateProperties) => ({
      id: 101,
      url: createProperties.url,
      status: 'complete' as const,
      active: createProperties.active ?? true,
    })),
    update: vi.fn(async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => ({
      id: tabId,
      url: updateProperties.url,
      status: 'complete' as const,
      active: updateProperties.active ?? true,
    })),
    get: vi.fn(async (tabId: number) => ({ id: tabId, status: 'complete' as const })),
    sendMessage: vi.fn(async () => ({ ok: true })),
    onUpdated: tabsOnUpdated,
    onRemoved: tabsOnRemoved,
  },
  scripting: {
    executeScript: vi.fn(async () => []),
  },
  permissions: {
    contains: vi.fn(async () => true),
    request: vi.fn(async () => true),
    remove: vi.fn(async () => true),
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  configurable: true,
  writable: true,
});

export function resetChromeMocks(): void {
  localStorageArea.reset();
  sessionStorageArea.reset();
  runtimeOnMessage.clearListeners();
  tabsOnUpdated.clearListeners();
  tabsOnRemoved.clearListeners();

  chromeMock.runtime.id = 'geomix-test-extension-id';
  chromeMock.runtime.lastError = undefined;
  chromeMock.runtime.getManifest.mockReset();
  chromeMock.runtime.getManifest.mockImplementation(defaultManifest);
  chromeMock.runtime.sendMessage.mockReset();
  chromeMock.runtime.sendMessage.mockImplementation(async () => ({ ok: true, data: null }));

  chromeMock.tabs.query.mockReset();
  chromeMock.tabs.query.mockImplementation(async () => []);
  chromeMock.tabs.create.mockReset();
  chromeMock.tabs.create.mockImplementation(
    async (createProperties: chrome.tabs.CreateProperties) => ({
      id: 101,
      url: createProperties.url,
      status: 'complete' as const,
      active: createProperties.active ?? true,
    }),
  );
  chromeMock.tabs.update.mockReset();
  chromeMock.tabs.update.mockImplementation(
    async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => ({
      id: tabId,
      url: updateProperties.url,
      status: 'complete' as const,
      active: updateProperties.active ?? true,
    }),
  );
  chromeMock.tabs.get.mockReset();
  chromeMock.tabs.get.mockImplementation(async (tabId: number) => ({
    id: tabId,
    status: 'complete' as const,
  }));
  chromeMock.tabs.sendMessage.mockReset();
  chromeMock.tabs.sendMessage.mockImplementation(async () => ({ ok: true }));

  chromeMock.scripting.executeScript.mockReset();
  chromeMock.scripting.executeScript.mockImplementation(async () => []);

  chromeMock.permissions.contains.mockReset();
  chromeMock.permissions.contains.mockImplementation(async () => true);
  chromeMock.permissions.request.mockReset();
  chromeMock.permissions.request.mockImplementation(async () => true);
  chromeMock.permissions.remove.mockReset();
  chromeMock.permissions.remove.mockImplementation(async () => true);
}

beforeEach(() => {
  resetChromeMocks();
});

afterEach(() => {
  cleanup();
});
