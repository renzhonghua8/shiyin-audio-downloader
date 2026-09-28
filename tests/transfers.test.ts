import assert from 'node:assert/strict';
import {beforeEach, test, type TestContext} from 'node:test';
import {GET as transferGET, POST as transferPOST} from '../app/api/transfers/route';
import {GET as downloadGET} from '../app/api/download/route';
import {POST as bundlePOST} from '../app/api/bundle/route';
import {beginTransfer, wrapTransferStream, type TransferStatus} from '../lib/transfers';
import type {AudioFile} from '../lib/audio';

const BASE = 'https://shiyin-fixtures.net';
const MEDIA = 'https://media.shiyin-fixtures.net';

// Only reset shared fixture storage between tests. All assertions below use
// public API responses and actually consumed or canceled download bodies.
beforeEach(() => {
  (globalThis as typeof globalThis & {__shiyinTransfers?: Map<string, TransferStatus>}).__shiyinTransfers?.clear();
});

function postTransfer(payload: unknown) {
  return transferPOST(new Request(`${BASE}/api/transfers`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
  }));
}

async function create(kind: 'file' | 'bundle' = 'file', totalFiles = 1, title = '测试下载') {
  const response = await postTransfer({kind, totalFiles, title});
  assert.equal(response.status, 201);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  return await response.json() as TransferStatus;
}

function getResponse(id?: string) {
  return transferGET(new Request(`${BASE}/api/transfers${id === undefined ? '' : `?id=${encodeURIComponent(id)}`}`));
}

async function status(id: string) {
  const response = await getResponse(id);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  return await response.json() as TransferStatus;
}

function download(id: string, path = '/complete.m4a') {
  const query = new URLSearchParams({url: MEDIA + path, source: BASE + '/recording', filename: '测试音频.m4a', transferId: id});
  return downloadGET(new Request(`${BASE}/api/download?${query}`));
}

function mockMedia(t: TestContext, handle: (url: URL) => Response) {
  t.mock.method(globalThis, 'fetch', async (resource: string | URL | Request) => {
    const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url);
    if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') {
      return Response.json({Status: 0, Answer: [{type: 1, data: '1.1.1.1'}]});
    }
    assert.equal(url.hostname, new URL(MEDIA).hostname, 'unexpected network request');
    return handle(url);
  });
}

function gatedBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { canceled = true; },
  });
  return {body, get controller() { return controller; }, get canceled() { return canceled; }};
}

function mediaResponse(body: BodyInit, length: number) {
  return new Response(body, {headers: {'Content-Type': 'audio/mp4', 'Content-Length': String(length)}});
}

test('transfer creation returns a unique server ID and its waiting state is immediately queryable', async () => {
  const first = await create('file', 1, '  第一段音频  ');
  const second = await create('file', 1, '第二段音频');
  assert.notEqual(first.id, second.id);
  assert.ok(first.id.length > 0);
  assert.equal(first.title, '第一段音频');
  assert.equal(first.kind, 'file');
  assert.equal(first.state, 'waiting');
  assert.equal(first.bytes, 0);
  assert.equal(first.completedFiles, 0);
  assert.equal(first.totalFiles, 1);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(await status(first.id), first);
});

test('a real single-download route exposes bytes while streaming and completes only after EOF', async t => {
  const source = gatedBody();
  mockMedia(t, () => mediaResponse(source.body, 5));
  const task = await create();
  const response = await download(task.id);
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2]));
  const progress = await status(task.id);
  assert.equal(progress.state, 'transferring');
  assert.equal(progress.bytes, 2);
  assert.equal(progress.totalBytes, 5);
  assert.equal(progress.completedFiles, 0);
  source.controller.enqueue(new Uint8Array([3, 4, 5]));
  source.controller.close();
  assert.deepEqual((await reader.read()).value, new Uint8Array([3, 4, 5]));
  assert.equal((await reader.read()).done, true);
  const completed = await status(task.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.bytes, 5);
  assert.equal(completed.completedFiles, 1);
  assert.deepEqual(completed.failures, []);
  assert.equal(completed.error, undefined);
});

test('an upstream stream exception fails both the download reader and its visible task status', async t => {
  const source = gatedBody();
  mockMedia(t, () => mediaResponse(source.body, 5));
  const task = await create();
  const response = await download(task.id);
  assert.ok(response.body);
  const reader = response.body.getReader();
  await reader.read();
  source.controller.error(new Error('fixture upstream disconnected'));
  await assert.rejects(reader.read(), /fixture upstream disconnected/);
  const failed = await status(task.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.bytes, 2);
  assert.equal(failed.completedFiles, 0);
  assert.match(failed.error || '', /fixture upstream disconnected/);
});

test('canceling a browser download cancels its source and leaves an observable failed state', async t => {
  const source = gatedBody();
  mockMedia(t, () => mediaResponse(source.body, 5));
  const task = await create();
  const response = await download(task.id);
  assert.ok(response.body);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel('fixture user cancellation');
  assert.equal(source.canceled, true);
  const failed = await status(task.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.bytes, 2);
  assert.match(failed.error || '', /取消|断开/);
});

test('a premature EOF cannot report a successful file download', async t => {
  mockMedia(t, () => mediaResponse(new Uint8Array([1, 2]), 5));
  const task = await create();
  const response = await download(task.id);
  await assert.rejects(response.arrayBuffer(), /传输不完整/);
  const failed = await status(task.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.bytes, 2);
  assert.equal(failed.totalBytes, 5);
  assert.equal(failed.completedFiles, 0);
});

function manifest(path: string, filename: string): AudioFile {
  return {url: MEDIA + path, source: BASE + '/recording', title: filename, filename, format: 'm4a', size: 0, mode: 'direct'};
}

async function bundle(id: string, files: AudioFile[]) {
  return bundlePOST(new Request(`${BASE}/api/bundle`, {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({manifest: JSON.stringify(files), transferId: id}),
  }));
}

test('a ZIP with inaccessible and truncated files reports partial status and counts only requested files', async t => {
  mockMedia(t, url => {
    if (url.pathname === '/missing.m4a') return new Response(null, {status: 403});
    if (url.pathname === '/truncated.m4a') return mediaResponse(new Uint8Array([4, 5]), 5);
    assert.equal(url.pathname, '/complete.m4a');
    return mediaResponse(new Uint8Array([1, 2, 3]), 3);
  });
  const task = await create('bundle', 1, '三段音频');
  const response = await bundle(task.id, [
    manifest('/complete.m4a', 'complete.m4a'),
    manifest('/missing.m4a', 'missing.m4a'),
    manifest('/truncated.m4a', 'truncated.m4a'),
  ]);
  assert.equal(response.status, 200);
  const zip = new Uint8Array(await response.arrayBuffer());
  const progress = await status(task.id);
  assert.equal(progress.state, 'partial');
  assert.equal(progress.completedFiles, 3, 'completedFiles counts processed source files, including failures');
  assert.equal(progress.totalFiles, 3, 'the submitted manifest determines the actual file count');
  assert.equal(progress.bytes, zip.byteLength);
  assert.equal(progress.failures.length, 2);
  assert.ok(progress.failures.some(value => value.includes('missing.m4a')));
  assert.ok(progress.failures.some(value => value.includes('truncated.m4a')));
  assert.equal(progress.error, undefined);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50, 'partial archive still has a complete ZIP directory');
  assert.equal(view.getUint16(zip.length - 12, true), 3, 'two source entries and the generated explanation entry');
  assert.ok(new TextDecoder().decode(zip).includes('_下载异常说明.txt'));
});

test('an all-success ZIP reports completed status with the actual archive byte count', async t => {
  mockMedia(t, () => mediaResponse(new Uint8Array([1, 2, 3]), 3));
  const task = await create('bundle', 2);
  const response = await bundle(task.id, [manifest('/one.m4a', 'one.m4a'), manifest('/two.m4a', 'two.m4a')]);
  const zip = await response.arrayBuffer();
  const progress = await status(task.id);
  assert.equal(progress.state, 'completed');
  assert.equal(progress.completedFiles, 2);
  assert.equal(progress.totalFiles, 2);
  assert.equal(progress.bytes, zip.byteLength);
  assert.deepEqual(progress.failures, []);
});

test('missing and unknown IDs are rejected and duplicate claims cannot corrupt an existing download', async t => {
  assert.equal((await getResponse()).status, 400);
  assert.equal((await getResponse('not-a-task')).status, 400);
  assert.equal((await getResponse('00000000-0000-4000-8000-000000000000')).status, 404);
  const source = gatedBody();
  mockMedia(t, () => mediaResponse(source.body, 5));
  const task = await create();
  assert.throws(() => beginTransfer(task.id, 'bundle'), /类型不匹配/);
  assert.equal((await status(task.id)).state, 'waiting');
  const original = await download(task.id);
  assert.ok(original.body);
  const reader = original.body.getReader();
  await reader.read();
  const before = await status(task.id);
  const duplicate = await download(task.id);
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error, /已经开始/);
  assert.deepEqual(await status(task.id), before);
  source.controller.enqueue(new Uint8Array([3, 4, 5]));
  source.controller.close();
  while (!(await reader.read()).done) { /* consume the original response */ }
  assert.equal((await status(task.id)).state, 'completed');
  const unknown = await download('00000000-0000-4000-8000-000000000000');
  assert.equal(unknown.status, 400);
});

test('completed tasks expire after retention while stalled tasks become failed before expiration', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const completed = await create();
  beginTransfer(completed.id, 'file');
  const body = wrapTransferStream(new ReadableStream<Uint8Array>({start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); }}), completed.id, 1);
  await new Response(body).arrayBuffer();
  assert.equal((await status(completed.id)).state, 'completed');
  now += 15 * 60 * 1000 - 1;
  assert.equal((await getResponse(completed.id)).status, 200);
  now++;
  assert.equal((await getResponse(completed.id)).status, 404);
  const stalled = await create();
  now += 2 * 60 * 60 * 1000 - 1;
  assert.equal((await status(stalled.id)).state, 'waiting');
  now++;
  const timedOut = await status(stalled.id);
  assert.equal(timedOut.state, 'failed');
  assert.match(timedOut.error || '', /两小时/);
  now += 15 * 60 * 1000;
  assert.equal((await getResponse(stalled.id)).status, 404);
});

test('transfer creation enforces title, type, count and request-size boundaries', async () => {
  const invalid: unknown[] = [
    null, [], {kind: 'unknown', title: '音频'}, {kind: 'file', title: ''},
    {kind: 'file', title: '   '}, {kind: 'file', title: 'x'.repeat(201)},
    {kind: 'file', title: 'bad\u0000title'}, {kind: 'file', title: 123},
    {kind: 'file', title: '音频', totalFiles: 2},
    {kind: 'bundle', title: '音频', totalFiles: 0},
    {kind: 'bundle', title: '音频', totalFiles: 101},
    {kind: 'bundle', title: '音频', totalFiles: 1.5},
    {kind: 'bundle', title: '音频', totalFiles: '2'},
  ];
  for (const payload of invalid) {
    const response = await postTransfer(payload);
    assert.equal(response.status, 400, `invalid payload: ${JSON.stringify(payload)}`);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const upperBoundary = await create('bundle', 100, 'x'.repeat(200));
  assert.equal(upperBoundary.totalFiles, 100);
  assert.equal(upperBoundary.title.length, 200);
  for (const request of [
    new Request(`${BASE}/api/transfers`, {method: 'POST', body: '{broken'}),
    new Request(`${BASE}/api/transfers`, {method: 'POST', body: 'x'.repeat(4097)}),
    new Request(`${BASE}/api/transfers`, {method: 'POST', headers: {'Content-Length': '4097'}, body: '{}'}),
  ]) assert.equal((await transferPOST(request)).status, 400);
});

test('task capacity returns 429 and expired slots become available again', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const ids: string[] = [];
  let limited: Response | undefined;
  for (let i = 0; i < 401; i++) {
    const response = await postTransfer({kind: 'file', title: `下载 ${i}`});
    if (response.status === 429) { limited = response; break; }
    assert.equal(response.status, 201);
    ids.push((await response.json()).id);
  }
  assert.ok(limited, 'creation must eventually enforce a bounded task capacity');
  assert.ok(ids.length > 0);
  assert.match((await limited.json()).error, /任务过多/);
  assert.equal((await status(ids[0])).state, 'waiting');
  now += 2 * 60 * 60 * 1000;
  assert.equal((await status(ids[0])).state, 'failed');
  now += 15 * 60 * 1000;
  assert.equal((await postTransfer({kind: 'file', title: '过期后重新下载'})).status, 201);
});
