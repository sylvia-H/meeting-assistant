/**
 * 無頭瀏覽器 + CDP 的小工具，給 scripts/ 下的瀏覽器測試共用。
 * 不裝 playwright：直接用 Edge/Chrome 的 --remote-debugging-port。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(test: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(150);
  }
  throw new Error(`等待逾時：${label}`);
}

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser(): string {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('找不到 Edge 或 Chrome，無法跑瀏覽器測試');
  return found;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

function decodeConsoleError(method: string, params: unknown): string | null {
  if (method === 'Runtime.exceptionThrown') {
    const p = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
    return p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '頁面例外';
  }
  if (method === 'Runtime.consoleAPICalled') {
    const p = params as { type: string; args: { value?: unknown; description?: string }[] };
    if (p.type !== 'error') return null;
    return p.args.map((a) => String(a.value ?? a.description ?? '')).join(' ');
  }
  if (method === 'Log.entryAdded') {
    const p = params as { entry: { level: string; text: string } };
    if (p.entry.level !== 'error' || p.entry.text.includes('favicon')) return null;
    return p.entry.text;
  }
  return null;
}

export class Cdp {
  private seq = 0;
  private ws: WebSocket;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, ((params: never) => void)[]>();
  /** 頁面 console / 例外 / log 的錯誤訊息，測試最後可以斷言它是空的 */
  readonly consoleErrors: string[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
        params?: unknown;
      };
      if (typeof msg.id === 'number') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      const error = decodeConsoleError(msg.method, msg.params);
      if (error) this.consoleErrors.push(error);
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params as never);
    });
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: (params: never) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  async eval<T>(expression: string): Promise<T> {
    const res = await this.send<{ result: { value?: T }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(`頁面執行錯誤：${res.exceptionDetails.text}`);
    return res.result.value as T;
  }

  /**
   * 導覽到指定網址，等頁面真的換過去再回傳。
   * 不能只等 Page.loadEventFired：`#/a` → `#/b` 是同文件 hash 變更，不會觸發 load。
   * 所以改成「等 hash 對上 + readyState complete」，再留一點時間給畫面渲染。
   */
  async navigate(url: string, timeoutMs = 15000): Promise<void> {
    const expected = new URL(url).hash || '#/';
    const result = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (result.errorText) throw new Error(`導覽失敗：${result.errorText}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.eval<{ hash: string; ready: string }>(
        `({ hash: location.hash || '#/', ready: document.readyState })`,
      );
      if (state.hash === expected && state.ready === 'complete') {
        await sleep(250); // 讓前端路由把畫面畫完
        return;
      }
      await sleep(100);
    }
    throw new Error(`導覽逾時：${url}`);
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
  }

  close(): void {
    this.ws.close();
  }
}

export interface BrowserSession {
  cdp: Cdp;
  browser: ChildProcess;
  close(): void;
}

/** 開一個 headless 瀏覽器、連上 CDP，回傳可直接用的 client。 */
export async function launchBrowser(options: {
  port: number;
  profileDir: string;
  extraArgs?: string[];
}): Promise<BrowserSession> {
  const exe = findBrowser();
  const browser = spawn(
    exe,
    [
      '--headless=new',
      `--remote-debugging-port=${options.port}`,
      `--user-data-dir=${options.profileDir}`,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      '--window-size=1440,960',
      ...(options.extraArgs ?? []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let debugUrl = '';
  await until(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${options.port}/json/list`);
        const targets = (await res.json()) as { type: string; webSocketDebuggerUrl?: string }[];
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (!page?.webSocketDebuggerUrl) return false;
        debugUrl = page.webSocketDebuggerUrl;
        return true;
      } catch {
        return false;
      }
    },
    20000,
    `瀏覽器 debug port（${path.basename(exe)}）`,
  );

  const socket = new WebSocket(debugUrl);
  socket.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP 連線失敗')), { once: true });
  });

  const cdp = new Cdp(socket);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  return {
    cdp,
    browser,
    close() {
      cdp.close();
      browser.kill();
    },
  };
}
