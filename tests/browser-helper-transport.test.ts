import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {AudioFile} from '../lib/audio';
import {
  BROWSER_HELPER_CHANNEL, BrowserHelperError, createBrowserHelperTransport,
  hasBrowserDelivery, isBrowserAudioFile, type BrowserHelperTarget,
} from '../lib/browser-helper';

const SOURCE = 'https://www.bilibili.com/video/BV1T8D7BWE6S/';
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
type Posted = {message: {id: string; action: string; payload?: Record<string, unknown>}; targetOrigin: string};

// A minimal message surface tests the website/extension protocol boundary.
// It does not stand in for Chrome's downloads API or a real browser visit.
class FakeTarget {
  location = {origin: 'http://audio.fixtures.net:8080'};
  listeners = new Set<(event: MessageEvent) => void>();
  posts: Posted[] = [];
  throwOnPost = false;
  addEventListener(type: string, callback: (event: MessageEvent) => void) {
    assert.equal(type, 'message'); this.listeners.add(callback);
  }
  removeEventListener(type: string, callback: (event: MessageEvent) => void) {
    assert.equal(type, 'message'); this.listeners.delete(callback);
  }
  postMessage(message: Posted['message'], targetOrigin: string) {
    if (this.throwOnPost) throw new Error('fixture postMessage failed');
    this.posts.push({message, targetOrigin});
  }
  emit(data: unknown, options: {source?: unknown; origin?: string} = {}) {
    const event = {data, source: options.source ?? this, origin: options.origin ?? this.location.origin} as unknown as MessageEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
  request(action: string) {
    const posted = [...this.posts].reverse().find(item => item.message.action === action);
    assert.ok(posted, `expected a posted ${action} request`); return posted.message;
  }
  reply(id: string, result: unknown) {
    this.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id, ok: true, result});
  }
  get surface() { return this as unknown as BrowserHelperTarget; }
}

function ping(target: FakeTarget) {
  return {version: '1.0.0', capabilities: ['bilibili-scan', 'native-download', 'native-batch'], siteOrigin: target.location.origin};
}
function browserFile(change: Record<string, unknown> = {}) {
  return {
    url: 'browser-helper:' + MEDIA_ID, helperId: MEDIA_ID, delivery: 'browser', source: SOURCE,
    title: '公开完整音轨', filename: '公开完整音轨.m4a', format: 'm4a', codec: 'aac', duration: 600,
    size: 0, mode: 'direct', sourceFormat: '独立音轨', ...change,
  };
}
function scanResult(change: Record<string, unknown> = {}) {
  return {title: '公开完整音轨', files: [browserFile()], warnings: [], ...change};
}
function downloadSnapshot(change: Record<string, unknown> = {}) {
  return {id: JOB_ID, kind: 'file', title: '公开音轨', state: 'transferring', bytes: 12, totalBytes: 24, completedFiles: 0, totalFiles: 1, failures: [], ...change};
}
const errorCode = (code: string) => (error: unknown) => error instanceof BrowserHelperError && error.code === code;

test('HTTP websites can connect without crypto.randomUUID and always target the exact origin', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {configurable: true, value: undefined});
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else Reflect.deleteProperty(globalThis, 'crypto'); });
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const first = transport.request('ping'), second = transport.request('ping');
  const requests = target.posts.map(post => post.message);
  assert.notEqual(requests[0].id, requests[1].id);
  assert.ok(target.posts.every(post => post.targetOrigin === target.location.origin));
  assert.ok(target.posts.every(post => post.targetOrigin !== '*'));
  target.reply(requests[1].id, ping(target)); target.reply(requests[0].id, ping(target));
  assert.deepEqual(await first, ping(target)); assert.deepEqual(await second, ping(target));
  assert.equal(target.listeners.size, 0);
});

test('foreign source, origin, channel, direction and correlation IDs cannot resolve a pending request', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const pending = transport.request('ping'), id = target.request('ping').id;
  const response = {channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id, ok: true, result: ping(target)};
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  target.emit(response, {source: {location: target.location}});
  target.emit(response, {origin: target.location.origin + '.evil.net'});
  target.emit({...response, channel: 'OTHER_CHANNEL'});
  target.emit({...response, direction: 'to-helper'});
  target.emit({...response, id: 'unrelated-request'});
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(target.listeners.size, 1);
  target.reply(id, ping(target)); await pending;
  assert.equal(target.listeners.size, 0);
});

test('independent concurrent requests accept only their own results, including out-of-order replies', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const scanning = transport.request('scan', {url: SOURCE}), scanId = target.request('scan').id;
  const status = transport.request('getDownloadStatus', {id: JOB_ID}), statusId = target.request('getDownloadStatus').id;
  target.reply(statusId, downloadSnapshot());
  assert.deepEqual(await status, downloadSnapshot());
  assert.equal(target.listeners.size, 1);
  target.reply(scanId, scanResult());
  assert.deepEqual(await scanning, scanResult());
  assert.equal(target.listeners.size, 0);
});

test('scan progress is scoped to the same trusted source, origin and request', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const progress: string[] = [];
  const pending = transport.request('scan', {url: SOURCE}, {onProgress: message => progress.push(message)});
  const id = target.request('scan').id;
  const event = {channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', event: 'scan-progress', requestId: id, message: '正在读取页面'};
  target.emit({...event, requestId: 'other-request'});
  target.emit(event, {origin: 'https://foreign.fixtures.net'});
  target.emit(event, {source: {}});
  target.emit(event);
  assert.deepEqual(progress, ['正在读取页面']);
  target.reply(id, scanResult()); await pending;
});

for (const [name, mutate] of [
  ['missing capabilities', (value: ReturnType<typeof ping>) => ({...value, capabilities: ['bilibili-scan']})],
  ['a foreign bound website', (value: ReturnType<typeof ping>) => ({...value, siteOrigin: 'https://foreign.fixtures.net'})],
  ['an unsupported protocol version', (value: ReturnType<typeof ping>) => ({...value, version: '99.0.0'})],
] as const) {
  test(`connection negotiation rejects ${name}`, async t => {
    const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
    t.after(() => transport.dispose());
    const pending = transport.request('ping');
    target.reply(target.request('ping').id, mutate(ping(target)));
    await assert.rejects(pending, errorCode('INVALID_RESPONSE'));
    assert.equal(target.listeners.size, 0);
  });
}

for (const [name, change] of [
  ['a raw media URL', {url: 'https://upos-sz-mirrorali.bilivideo.com/audio.m4s'}],
  ['a synthetic key not matching the registered media ID', {url: 'browser-helper:other-media'}],
  ['a foreign source page', {source: 'https://www.bilibili.com.evil.net/video/BV1T8D7BWE6S/'}],
  ['an insecure source page', {source: SOURCE.replace('https:', 'http:')}],
  ['an unsupported codec', {codec: 'opus'}],
  ['server extraction mode', {mode: 'extract'}],
  ['a populated media body size', {size: 50000000}],
  ['unknown full length', {duration: 0}],
] as const) {
  test(`scan responses refuse ${name}`, async t => {
    const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
    t.after(() => transport.dispose());
    const pending = transport.request('scan', {url: SOURCE});
    target.reply(target.request('scan').id, scanResult({files: [browserFile(change)]}));
    await assert.rejects(pending, errorCode('INVALID_RESPONSE'));
    assert.equal(target.listeners.size, 0);
  });
}

test('browser delivery markers are intercepted even when the file fails strict helper validation', () => {
  const direct: AudioFile = {url: 'https://audio.fixtures.net/audio.m4a', source: SOURCE, title: '音频', filename: '音频.m4a', format: 'm4a', size: 0};
  const claimed = {...direct, delivery: 'browser'};
  assert.equal(isBrowserAudioFile(browserFile()), true);
  assert.equal(isBrowserAudioFile(browserFile({url: 'browser-helper:other-media'})), false);
  assert.equal(hasBrowserDelivery({...direct, url: 'browser-helper:unknown'}), true);
  assert.equal(hasBrowserDelivery(claimed), true);
  assert.equal(isBrowserAudioFile(claimed), false);
  assert.equal(hasBrowserDelivery(direct), false);
});

test('native-download commands carry registered IDs and never call a backend media endpoint', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('transport must not fetch media or server APIs'); });
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const pending = transport.request('download', {helperId: MEDIA_ID});
  const request = target.request('download');
  assert.deepEqual(request.payload, {helperId: MEDIA_ID});
  target.reply(request.id, downloadSnapshot({state: 'waiting', bytes: 0}));
  const result = await pending;
  assert.deepEqual(result, downloadSnapshot({state: 'waiting', bytes: 0}));
});

test('a native-download command cannot carry a webpage-supplied media URL into the helper', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const injected = {helperId: MEDIA_ID, url: 'https://evil.fixtures.net/audio.m4s'};
  await assert.rejects(transport.request('download', injected), errorCode('INVALID_REQUEST'));
  assert.equal(target.posts.length, 0); assert.equal(target.listeners.size, 0);
});

for (const [name, change] of [
  ['Chrome state names not normalized to the contract', {state: 'in_progress'}],
  ['negative transferred bytes', {bytes: -1}],
  ['a processed count above the manifest', {completedFiles: 2}],
  ['a batch above the supported file boundary', {kind: 'bundle', totalFiles: 101}],
  ['non-text failure details', {failures: [{url: 'https://evil.fixtures.net'}]}],
] as const) {
  test(`download snapshots reject ${name}`, async t => {
    const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
    t.after(() => transport.dispose());
    const pending = transport.request('getDownloadStatus', {id: JOB_ID});
    target.reply(target.request('getDownloadStatus').id, downloadSnapshot(change));
    await assert.rejects(pending, errorCode('INVALID_RESPONSE'));
  });
}

test('matching malformed envelopes fail promptly and clear their listener', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const pending = transport.request('ping');
  target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id: target.request('ping').id, ok: 'true', result: ping(target)});
  await assert.rejects(pending, errorCode('INVALID_RESPONSE'));
  assert.equal(target.listeners.size, 0);
});

for (const ok of [true, false]) {
  test(`a contradictory result-plus-error envelope cannot resolve or create a pause (ok=${ok})`, async () => {
    const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
    const pending = transport.request('scan', {url: SOURCE});
    target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id: target.request('scan').id, ok, result: scanResult(), error: {code: 'NEEDS_USER', message: '请在来源页面播放'}});
    await assert.rejects(pending, errorCode('INVALID_RESPONSE'));
    await transport.cancelPausedScan(); transport.dispose();
    assert.equal(target.listeners.size, 0);
    assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 0);
  });
}

test('trusted helper errors preserve the user-action instruction without marking the operation successful', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const pending = transport.request('scan', {url: SOURCE});
  target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id: target.request('scan').id, ok: false, error: {code: 'NEEDS_USER', message: '请在打开的官方页面完成验证后重试'}});
  await assert.rejects(pending, error => errorCode('NEEDS_USER')(error) && /官方页面完成验证/.test((error as Error).message));
  assert.equal(target.listeners.size, 0);
});

test('reset retains a rejected paused scan ID until its own cancellation is acknowledged', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const scanning = transport.request('scan', {url: SOURCE});
  const original = target.request('scan');
  target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id: original.id, ok: false, error: {code: 'NEEDS_USER', message: '请在来源页面完成验证'}});
  await assert.rejects(scanning, errorCode('NEEDS_USER'));
  assert.equal(target.listeners.size, 0);
  assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 0);
  const reset = transport.cancelPausedScan(), duplicateReset = transport.cancelPausedScan();
  const cancellation = target.request('cancelScan');
  assert.notEqual(cancellation.id, original.id);
  assert.deepEqual(cancellation.payload, {requestId: original.id});
  assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 1);
  let resetDone = false; void reset.then(() => { resetDone = true; });
  await Promise.resolve(); assert.equal(resetDone, false);
  target.reply(cancellation.id, {canceled: true});
  await Promise.all([reset, duplicateReset]);
  assert.equal(target.listeners.size, 0);
  await transport.cancelPausedScan(); transport.dispose();
  assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 1);
});

test('resuming the same paused video preserves its page and retires its original ID after success', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const first = transport.request('scan', {url: SOURCE});
  target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id: target.request('scan').id, ok: false, error: {code: 'NEEDS_USER', message: '请手动点击播放后继续'}});
  await assert.rejects(first, errorCode('NEEDS_USER'));
  const resumed = transport.request('scan', {url: SOURCE});
  assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 0);
  target.reply(target.request('scan').id, scanResult()); await resumed;
  await transport.cancelPausedScan(); transport.dispose();
  assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 0);
  assert.equal(target.listeners.size, 0);
});

test('repeated verification failures retain the latest paused request for cleanup', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const ids: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const scanning = transport.request('scan', {url: SOURCE + '?share_source=copy_web'});
    const id = target.request('scan').id; ids.push(id);
    target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id, ok: false, error: {code: 'NEEDS_USER', message: '请先在来源页面播放'}});
    await assert.rejects(scanning, errorCode('NEEDS_USER'));
  }
  const reset = transport.cancelPausedScan();
  const cancellation = target.request('cancelScan');
  assert.deepEqual(cancellation.payload, {requestId: ids[1]});
  assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 1);
  target.reply(cancellation.id, {canceled: true}); await reset;
});

test('a failed pause cancellation keeps its original ID available for the next reset', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const scanning = transport.request('scan', {url: SOURCE}), original = target.request('scan').id;
  target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id: original, ok: false, error: {code: 'NEEDS_USER', message: '请先播放来源页面'}});
  await assert.rejects(scanning, errorCode('NEEDS_USER'));
  const failedReset = transport.cancelPausedScan(), firstCancellation = target.request('cancelScan');
  target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id: firstCancellation.id, ok: false, error: {code: 'HELPER_ERROR', message: '暂时无法确认扫描已停止'}});
  await assert.rejects(failedReset, errorCode('HELPER_ERROR'));
  assert.equal(target.listeners.size, 0);
  const retriedReset = transport.cancelPausedScan(), retry = target.request('cancelScan');
  assert.notEqual(retry.id, firstCancellation.id);
  assert.deepEqual(retry.payload, {requestId: original});
  target.reply(retry.id, {canceled: true}); await retriedReset;
  assert.equal(target.listeners.size, 0);
});

test('disposing a rejected paused scan cancels it once without creating another listener', async () => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  const scanning = transport.request('scan', {url: SOURCE}), id = target.request('scan').id;
  target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id, ok: false, error: {code: 'NEEDS_USER', message: '请完成手动验证'}});
  await assert.rejects(scanning, errorCode('NEEDS_USER'));
  transport.dispose(); transport.dispose();
  assert.deepEqual(target.request('cancelScan').payload, {requestId: id});
  assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 1);
  assert.equal(target.listeners.size, 0);
});

test('resetting one website transport cannot cancel a different window paused request', async t => {
  const firstTarget = new FakeTarget(), secondTarget = new FakeTarget();
  const first = createBrowserHelperTransport(firstTarget.surface), second = createBrowserHelperTransport(secondTarget.surface);
  t.after(() => { first.dispose(); second.dispose(); });
  const failures = [first.request('scan', {url: SOURCE}), second.request('scan', {url: SOURCE})];
  for (const target of [firstTarget, secondTarget]) {
    target.emit({channel: BROWSER_HELPER_CHANNEL, direction: 'to-page', id: target.request('scan').id, ok: false, error: {code: 'NEEDS_USER', message: '请在自己的来源页面验证'}});
  }
  await Promise.all(failures.map(pending => assert.rejects(pending, errorCode('NEEDS_USER'))));
  const reset = first.cancelPausedScan(), cancellation = firstTarget.request('cancelScan');
  assert.deepEqual(cancellation.payload, {requestId: firstTarget.request('scan').id});
  assert.equal(secondTarget.posts.filter(post => post.message.action === 'cancelScan').length, 0);
  firstTarget.reply(cancellation.id, {canceled: true}); await reset;
  assert.equal(firstTarget.listeners.size, 0); assert.equal(secondTarget.listeners.size, 0);
});

test('a scan timeout clears all listeners and sends a cancel for only its own original request', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const pending = transport.request('scan', {url: SOURCE}, {timeoutMs: 20});
  const scan = target.request('scan');
  await assert.rejects(pending, errorCode('TIMEOUT'));
  assert.equal(target.listeners.size, 0);
  const cancel = target.request('cancelScan');
  assert.notEqual(cancel.id, scan.id);
  assert.deepEqual(cancel.payload, {requestId: scan.id});
});

test('abort before submission posts nothing, while an active scan abort cancels and releases its listener', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(transport.request('scan', {url: SOURCE}, {signal: aborted.signal}), errorCode('ABORTED'));
  assert.equal(target.posts.length, 0); assert.equal(target.listeners.size, 0);
  const active = new AbortController(), pending = transport.request('scan', {url: SOURCE}, {signal: active.signal});
  const scan = target.request('scan'); active.abort();
  await assert.rejects(pending, errorCode('ABORTED'));
  assert.equal(target.listeners.size, 0);
  assert.deepEqual(target.request('cancelScan').payload, {requestId: scan.id});
});

test('disposing multiple pending operations rejects each once and prevents later requests', async () => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  const scan = transport.request('scan', {url: SOURCE}), scanId = target.request('scan').id;
  const status = transport.request('getDownloadStatus', {id: JOB_ID});
  const scanRejected = assert.rejects(scan, errorCode('DISPOSED'));
  const statusRejected = assert.rejects(status, errorCode('DISPOSED'));
  transport.dispose(); transport.dispose();
  await Promise.all([scanRejected, statusRejected]);
  assert.equal(target.listeners.size, 0);
  assert.deepEqual(target.request('cancelScan').payload, {requestId: scanId});
  await assert.rejects(transport.request('ping'), errorCode('DISPOSED'));
});

test('successful scans clear the timeout instead of later canceling an already-completed request', async t => {
  const target = new FakeTarget(), transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  const pending = transport.request('scan', {url: SOURCE}, {timeoutMs: 20});
  target.reply(target.request('scan').id, scanResult()); await pending;
  await delay(35);
  assert.equal(target.listeners.size, 0);
  assert.equal(target.posts.filter(post => post.message.action === 'cancelScan').length, 0);
});

test('postMessage failures release the listener and report an unavailable helper', async t => {
  const target = new FakeTarget(); target.throwOnPost = true;
  const transport = createBrowserHelperTransport(target.surface);
  t.after(() => transport.dispose());
  await assert.rejects(transport.request('ping'), errorCode('UNAVAILABLE'));
  assert.equal(target.listeners.size, 0);
});
