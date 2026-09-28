import type {AudioFile} from './audio';

export const BROWSER_HELPER_CHANNEL = 'SHIYIN_BROWSER_HELPER_V1';
export type BrowserAudioFile = AudioFile & {delivery: 'browser'; helperId: string};
export type CollectedAudioFile = AudioFile | BrowserAudioFile;
export type BrowserHelperPing = {version: string; capabilities: string[]; siteOrigin: string};
export type BrowserHelperScanResult = {title: string; files: BrowserAudioFile[]; warnings: string[]};
export type BrowserDownloadSnapshot = {
  id: string; kind: 'file' | 'bundle'; title: string;
  state: 'waiting' | 'preparing' | 'transferring' | 'completed' | 'partial' | 'failed';
  bytes: number; totalBytes?: number; completedFiles: number; totalFiles: number;
  error?: string; failures?: string[];
};
type ResultMap = {
  ping: BrowserHelperPing;
  scan: BrowserHelperScanResult;
  cancelScan: {canceled: boolean};
  download: BrowserDownloadSnapshot;
  downloadBatch: BrowserDownloadSnapshot;
  getDownloadStatus: BrowserDownloadSnapshot;
};
type PayloadMap = {
  ping: undefined;
  scan: {url: string};
  cancelScan: {requestId: string};
  download: {helperId: string};
  downloadBatch: {helperIds: string[]};
  getDownloadStatus: {id: string};
};
export type BrowserHelperAction = keyof ResultMap;
export type BrowserHelperRequestOptions = {signal?: AbortSignal; timeoutMs?: number; onProgress?: (message: string) => void};
export interface BrowserHelperTarget {
  readonly location: {readonly origin: string};
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
export interface BrowserHelperTransport {
  request<A extends BrowserHelperAction>(action: A, payload?: PayloadMap[A], options?: BrowserHelperRequestOptions): Promise<ResultMap[A]>;
  cancelPausedScan(): Promise<void>;
  dispose(): void;
}
export class BrowserHelperError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'BrowserHelperError'; }
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max = 200): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function strings(value: unknown, count: number, max: number): value is string[] { return Array.isArray(value) && value.length <= count && value.every(item => text(item, max)); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function canonicalBiliSource(raw: unknown): raw is string {
  if (!text(raw, 4096)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'www.bilibili.com' && !url.username && !url.password && !url.port && !url.hash
      && /^\/video\/BV[a-zA-Z0-9]{10}\/?$/.test(url.pathname)
      && [...url.searchParams].every(([key, value]) => key === 'p' && /^[1-9]\d{0,5}$/.test(value)) && [...url.searchParams].length <= 1;
  } catch { return false; }
}
export function isBilibiliPage(raw: string) {
  try { const url = new URL(raw); return /^https?:$/.test(url.protocol) && /(?:^|\.)bilibili\.com$/i.test(url.hostname) && /\/video\/BV[a-zA-Z0-9]{10}(?:\/|$)/.test(url.pathname); }
  catch { return false; }
}
export function canonicalBilibiliPage(raw: string) {
  if (!isBilibiliPage(raw)) throw new BrowserHelperError('INVALID_REQUEST', '请使用含 BV 号的哔哩哔哩视频链接');
  const url = new URL(raw), id = url.pathname.match(/\/video\/(BV[a-zA-Z0-9]{10})(?:\/|$)/)?.[1];
  const part = url.searchParams.get('p');
  if (part !== null && !/^[1-9]\d{0,5}$/.test(part)) throw new BrowserHelperError('INVALID_REQUEST', '哔哩哔哩分 P 参数无效');
  return 'https://www.bilibili.com/video/' + id + '/' + (part ? '?p=' + part : '');
}
export function hasBrowserDelivery(file: AudioFile): boolean {
  return (file as Partial<BrowserAudioFile>).delivery === 'browser' || /^browser-helper:/i.test(file.url);
}
export function isBrowserAudioFile(value: unknown): value is BrowserAudioFile {
  if (!object(value)) return false;
  return value.delivery === 'browser' && text(value.helperId) && value.url === 'browser-helper:' + value.helperId
    && canonicalBiliSource(value.source) && text(value.title, 500) && text(value.filename, 180) && !/[\/\\]/.test(value.filename)
    && value.format === 'm4a' && value.codec === 'aac' && value.size === 0 && value.mode === 'direct' && value.sourceFormat === '独立音轨'
    && finite(value.duration) && value.duration > 0;
}
export function isBrowserDownloadSnapshot(value: unknown): value is BrowserDownloadSnapshot {
  if (!object(value) || !text(value.id) || !text(value.title) || (value.kind !== 'file' && value.kind !== 'bundle')
    || typeof value.state !== 'string' || !['waiting', 'preparing', 'transferring', 'completed', 'partial', 'failed'].includes(value.state)
    || !finite(value.bytes) || !Number.isInteger(value.completedFiles) || !Number.isInteger(value.totalFiles)) return false;
  const completed = value.completedFiles as number, total = value.totalFiles as number;
  return total >= 1 && total <= 100 && completed >= 0 && completed <= total && (value.kind !== 'file' || total === 1)
    && (value.totalBytes === undefined || finite(value.totalBytes))
    && (value.error === undefined || text(value.error, 1500))
    && (value.failures === undefined || strings(value.failures, 100, 1500));
}
function validResult(action: BrowserHelperAction, value: unknown, origin: string) {
  if (!object(value)) return false;
  if (action === 'ping') {
    const capabilities = value.capabilities;
    return value.version === '1.0.0' && value.siteOrigin === origin && strings(capabilities, 20, 100)
      && ['bilibili-scan', 'native-download', 'native-batch'].every(capability => capabilities.includes(capability));
  }
  if (action === 'scan') return text(value.title, 500) && Array.isArray(value.files) && value.files.length <= 100 && value.files.every(isBrowserAudioFile)
    && strings(value.warnings, 100, 1500) && new Set(value.files.map(file => file.helperId)).size === value.files.length;
  if (action === 'cancelScan') return typeof value.canceled === 'boolean';
  return isBrowserDownloadSnapshot(value);
}
function validPayload(action: BrowserHelperAction, payload: unknown) {
  if (action === 'ping') return payload === undefined;
  if (!object(payload)) return false;
  const key = {scan: 'url', cancelScan: 'requestId', download: 'helperId', downloadBatch: 'helperIds', getDownloadStatus: 'id'}[action];
  if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, key)) return false;
  if (action === 'scan') return text(payload.url, 4096) && isBilibiliPage(payload.url);
  if (action === 'cancelScan') return text(payload.requestId);
  if (action === 'download') return text(payload.helperId);
  if (action === 'getDownloadStatus') return text(payload.id);
  return Array.isArray(payload.helperIds) && payload.helperIds.length > 0 && payload.helperIds.length <= 100
    && payload.helperIds.every(id => text(id)) && new Set(payload.helperIds).size === payload.helperIds.length;
}

let sequence = 0;
function requestId() { return 'shiyin-' + Date.now().toString(36) + '-' + (++sequence).toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

// Browser globals are deliberately supplied by the caller after mounting.
// Correlation IDs do not require secure-context-only crypto.randomUUID().
export function createBrowserHelperTransport(target: BrowserHelperTarget, defaults: {timeoutMs?: number} = {}): BrowserHelperTransport {
  const origin = target.location.origin;
  const pending = new Set<() => void>();
  const paused = new Map<string, string>();
  let cancelingPause: Promise<void> | undefined;
  let disposed = false;
  const cancelScan = (id: string) => {
    try { target.postMessage({channel: BROWSER_HELPER_CHANNEL, direction: 'to-helper', id: requestId(), action: 'cancelScan', payload: {requestId: id}}, origin); }
    catch { /* The user can stop the scan in the helper if the bridge has gone away. */ }
  };
  const transport: BrowserHelperTransport = {
    request<A extends BrowserHelperAction>(action: A, payload?: PayloadMap[A], options: BrowserHelperRequestOptions = {}) {
      return new Promise<ResultMap[A]>((resolve, reject) => {
        if (disposed) { reject(new BrowserHelperError('DISPOSED', '浏览器助手连接已关闭，请重新连接')); return; }
        if (!/^https?:\/\//.test(origin)) { reject(new BrowserHelperError('UNAVAILABLE', '请在 HTTP 或 HTTPS 网页中连接浏览器助手')); return; }
        if (!validPayload(action, payload)) { reject(new BrowserHelperError('INVALID_REQUEST', '浏览器助手请求无效，请重新扫描后再试')); return; }
        if (action === 'scan') {
          try { payload = {url: canonicalBilibiliPage((payload as PayloadMap['scan']).url)} as PayloadMap[A]; }
          catch (error) { reject(error); return; }
        }
        if (options.signal?.aborted) { reject(new BrowserHelperError('ABORTED', '扫描已停止')); return; }
        const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? 15_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { reject(new BrowserHelperError('INVALID_REQUEST', '浏览器助手等待时间无效')); return; }
        const id = requestId();
        let settled = false, timer: ReturnType<typeof setTimeout>;
        function clean() { clearTimeout(timer); target.removeEventListener('message', onMessage); options.signal?.removeEventListener('abort', onAbort); pending.delete(onDispose); }
        function fail(error: BrowserHelperError, cancel = false) { if (settled) return; settled = true; clean(); if (cancel && action === 'scan') cancelScan(id); reject(error); }
        function onAbort() { fail(new BrowserHelperError('ABORTED', '扫描已停止'), true); }
        function onDispose() { fail(new BrowserHelperError('DISPOSED', '浏览器助手连接已关闭，请重新连接'), true); }
        function onMessage(event: MessageEvent) {
          if (event.source !== target || event.origin !== origin || !object(event.data)) return;
          const data = event.data;
          if (data.channel !== BROWSER_HELPER_CHANNEL || data.direction !== 'to-page') return;
          if (data.event === 'scan-progress') {
            if (action === 'scan' && data.requestId === id && text(data.message, 500)) options.onProgress?.(data.message);
            return;
          }
          if (data.id !== id) return;
          if (typeof data.ok !== 'boolean') { fail(new BrowserHelperError('INVALID_RESPONSE', '浏览器助手返回的信息无效，请重新连接后重试')); return; }
          if (!data.ok) {
            if (data.result !== undefined || !object(data.error) || !text(data.error.code, 80) || !text(data.error.message, 1500)) {
              fail(new BrowserHelperError('INVALID_RESPONSE', '浏览器助手返回的错误信息无效，请重新连接后重试')); return;
            }
            if (action === 'scan' && data.error.code === 'NEEDS_USER') paused.set((payload as PayloadMap['scan']).url, id);
            fail(new BrowserHelperError(data.error.code, data.error.message)); return;
          }
          if (data.error !== undefined || !validResult(action, data.result, origin)
            || (action === 'getDownloadStatus' && object(data.result) && data.result.id !== (payload as PayloadMap['getDownloadStatus'] | undefined)?.id)
            || (action === 'download' && object(data.result) && data.result.kind !== 'file')
            || (action === 'downloadBatch' && object(data.result) && data.result.kind !== 'bundle')) {
            fail(new BrowserHelperError('INVALID_RESPONSE', '浏览器助手返回的信息无效，请更新助手后重试')); return;
          }
          if (action === 'scan') paused.clear();
          settled = true; clean(); resolve(data.result as ResultMap[A]);
        }
        target.addEventListener('message', onMessage);
        options.signal?.addEventListener('abort', onAbort, {once: true});
        pending.add(onDispose);
        timer = setTimeout(() => fail(new BrowserHelperError('TIMEOUT', action === 'scan' ? '浏览器助手扫描超时，请查看已打开的来源页面并重试' : '浏览器助手没有回应，请确认已安装并连接当前网站后重试'), true), timeoutMs);
        try { target.postMessage({channel: BROWSER_HELPER_CHANNEL, direction: 'to-helper', id, action, ...(payload ? {payload} : {})}, origin); }
        catch { fail(new BrowserHelperError('UNAVAILABLE', '无法连接浏览器助手，请重新连接后重试'), true); }
      });
    },
    cancelPausedScan() {
      if (cancelingPause) return cancelingPause;
      const scans = [...paused];
      if (!scans.length) return Promise.resolve();
      cancelingPause = Promise.all(scans.map(async ([url, id]) => {
        await transport.request('cancelScan', {requestId: id}, {timeoutMs: 5000});
        if (paused.get(url) === id) paused.delete(url);
      })).then(() => {}).finally(() => { cancelingPause = undefined; });
      return cancelingPause;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of [...pending]) cancel();
      for (const id of paused.values()) cancelScan(id);
      pending.clear(); paused.clear();
    },
  };
  return transport;
}
