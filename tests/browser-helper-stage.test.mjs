import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {createContext, runInContext} from 'node:vm';
import {BufferTarget, EncodedAudioPacketSource, EncodedPacket, Mp4OutputFormat, Output} from 'mediabunny';

const SOURCE = 'https://www.bilibili.com/video/BV1T8D7BWE6S/';
const CDN = 'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/fixture/audio.m4s';
const TOKEN = '11111111-1111-4111-8111-111111111111';
const MAX_BYTES = 3 * 1024 ** 3;
const API = '__SHIYIN_AUDIO_SAVE_V1__';
const script = await readFile(new URL('../browser-helper/audio-save-page.js', import.meta.url), 'utf8');

// Independent AAC-LC fragmented MP4 fixture, muxed by mediabunny rather than
// copied from the stage parser. The packets encode silence; no remote media,
// browser codec, FFmpeg, Cookie or user recording is required.
async function audioFixture(seconds = 8) {
  const target = new BufferTarget(), interval = 1024 / 48000;
  const output = new Output({format: new Mp4OutputFormat({fastStart: 'fragmented', minimumFragmentDuration: 1}), target});
  const audio = new EncodedAudioPacketSource('aac'); output.addAudioTrack(audio); await output.start();
  const packets = Math.ceil(seconds / interval);
  for (let index = 0; index < packets; index++) {
    await audio.add(new EncodedPacket(new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]), 'key', index * interval, interval), index === 0
      ? {decoderConfig: {codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90])}}
      : undefined);
  }
  audio.close(); await output.finalize();
  const bytes = new Uint8Array(target.buffer), view = new DataView(bytes.buffer);
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset), type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    assert.ok(length >= 8 && offset + length <= bytes.length);
    if (type === 'mfra') return {bytes: bytes.slice(0, offset), duration: packets * interval};
    offset += length;
  }
  return {bytes, duration: packets * interval};
}
const fixture = await audioFixture();

// A deterministic OPFS/DOM boundary model runs the actual MAIN-world script
// with real streaming bodies. It does not prove Chrome storage/download APIs.
function stageEnvironment({bytes = fixture.bytes, length = bytes.length, contentType = 'audio/mp4', contentRange = null, quota = MAX_BYTES * 2, usage = 0, status = 200, automatic = true, writeError} = {}) {
  const files = new Map(), writes = [], fetches = [], responseHeaderReads = [], anchors = [], createdUrls = [], revokedUrls = [], diskFiles = new Set();
  const events = new Map();
  let controller, offset = 0, closed = false, aborted = 0, writesActive = 0, maxWritesActive = 0, writeGate, releaseWrite;
  const stream = new ReadableStream({
    start(value) { controller = value; },
    pull(value) {
      if (!automatic || closed) return;
      if (offset === bytes.length) { closed = true; value.close(); return; }
      const chunk = bytes.slice(offset, offset + 137); offset += chunk.length; value.enqueue(chunk);
    },
    cancel() { aborted++; },
  });
  const headers = new Map([['content-type', contentType], ['content-range', contentRange], ['content-length', length === undefined || length === null ? null : String(length)]]);
  const response = {status, ok: status >= 200 && status < 300, body: stream, headers: {
    get(name) {
      responseHeaderReads.push(name.toLowerCase());
      assert.ok(headers.has(name.toLowerCase()), 'stage must not inspect private response headers');
      return headers.get(name.toLowerCase());
    },
  }, arrayBuffer() { throw new Error('whole-body reads are forbidden'); }, text() { throw new Error('whole-body reads are forbidden'); }, json() { throw new Error('whole-body reads are forbidden'); }};
  const directory = {
    async getFileHandle(name, options) {
      if (!files.has(name)) { assert.equal(options?.create, true); files.set(name, {parts: [], closed: false, aborted: false}); }
      const file = files.get(name);
      return {
        async createWritable() { return {
          async write(value) {
            const data = value?.type === 'write' ? value.data : value;
            assert.ok(data instanceof Uint8Array, 'the disk sink must receive bounded byte chunks');
            writesActive++; maxWritesActive = Math.max(maxWritesActive, writesActive);
            try {
              if (writeGate) await writeGate;
              if (writeError) throw writeError;
              file.parts.push(data.slice()); writes.push(data.length);
            } finally { writesActive--; }
          },
          async close() { file.closed = true; },
          async abort() { file.aborted = true; },
        }; },
        async getFile() {
          assert.equal(file.closed, true, 'file-backed Blob cannot be created before the disk sink closes');
          const value = new File(file.parts, name, {type: 'audio/mp4'}); diskFiles.add(value); return value;
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
    async *entries() { for (const [name, value] of files) yield [name, value]; },
  };
  const body = {appendChild(value) { return value; }, append(value) { return value; }};
  const document = {body, documentElement: body, createElement(name) {
    assert.equal(name, 'a');
    return {href: '', download: '', style: {}, rel: '', click() { anchors.push({href: this.href, download: this.download}); }, remove() {}};
  }};
  Object.defineProperty(document, 'cookie', {get() { throw new Error('Cookie must never be read'); }});
  const nativeURL = class extends URL {};
  nativeURL.createObjectURL = value => {
    assert.ok(diskFiles.has(value), 'object URLs must be backed by the completed OPFS File');
    const url = 'blob:https://www.bilibili.com/00000000-0000-4000-8000-' + String(createdUrls.length + 1).padStart(12, '0');
    createdUrls.push({url, value}); return url;
  };
  nativeURL.revokeObjectURL = value => revokedUrls.push(value);
  const FileBackedBlob = function (parts, options) {
    assert.equal(parts.length, 1);
    assert.ok(diskFiles.has(parts[0]), 'a Blob may wrap only the OPFS File, never accumulated network chunks');
    const value = new Blob(parts, options); diskFiles.add(value); return value;
  };
  const context = {location: {href: SOURCE, origin: 'https://www.bilibili.com'}, document,
    navigator: {storage: {async estimate() { return {quota, usage}; }, async getDirectory() { return directory; }}},
    URL: nativeURL, Blob: FileBackedBlob, File, TextDecoder, TextEncoder, Uint8Array, DataView, ArrayBuffer, AbortController, DOMException,
    setTimeout, clearTimeout, console,
    async fetch(url, options) {
      fetches.push({url, options});
      options?.signal?.addEventListener('abort', () => {
        aborted++;
        if (!closed) { closed = true; try { controller.error(new DOMException('aborted', 'AbortError')); } catch {} }
      }, {once: true});
      return response;
    },
    addEventListener(type, listener) { if (!events.has(type)) events.set(type, []); events.get(type).push(listener); },
    removeEventListener(type, listener) { events.set(type, (events.get(type) || []).filter(item => item !== listener)); },
  };
  context.window = context; context.self = context;
  const vm = createContext(context); runInContext(script, vm, {timeout: 1000});
  const command = value => context[API].command(value);
  return {command, files, writes, fetches, responseHeaderReads, anchors, createdUrls, revokedUrls, context,
    get maxWritesActive() { return maxWritesActive; }, get aborted() { return aborted; },
    start(change = {}) { return command({action: 'start', token: TOKEN, url: CDN, source: SOURCE, filename: '公开完整音轨.m4a', duration: fixture.duration, maxBytes: MAX_BYTES, ...change}); },
    poll() { return command({action: 'poll', token: TOKEN}); },
    enqueue(value) { controller.enqueue(value); },
    finish() { closed = true; controller.close(); },
    fail(error) { closed = true; controller.error(error); },
    pauseWrites() { writeGate = new Promise(resolve => { releaseWrite = resolve; }); },
    releaseWrites() { releaseWrite?.(); writeGate = undefined; },
    async settle() { for (let index = 0; index < 5; index++) await setImmediate(); },
    async terminal() {
      for (let index = 0; index < 100; index++) {
        const state = this.poll(); if (['ready', 'failed', 'disposed', 'handing_off'].includes(state.state)) return state;
        await setImmediate();
      }
      assert.fail('stage did not reach a terminal preparation state');
    },
  };
}

test('a complete AAC stream is written sequentially to OPFS and handed off only once from a file-backed Blob', async () => {
  const env = stageEnvironment();
  const started = env.start(); assert.equal(started.token, TOKEN);
  env.start();
  const ready = await env.terminal();
  assert.equal(ready.state, 'ready', ready.error);
  assert.equal(ready.bytes, fixture.bytes.length); assert.equal(ready.expectedBytes, fixture.bytes.length);
  assert.equal(env.fetches.length, 1); assert.equal(env.fetches[0].url, CDN);
  assert.equal(env.fetches[0].options.credentials, 'omit');
  assert.equal(env.fetches[0].options.headers, undefined);
  assert.equal(env.maxWritesActive, 1); assert.ok(env.writes.length > 1); assert.ok(env.writes.every(length => length <= 64 * 1024));
  const saved = new Uint8Array(await env.createdUrls[0].value.arrayBuffer());
  assert.deepEqual(saved, fixture.bytes);
  assert.equal(env.anchors.length, 0);
  assert.equal(env.command({action: 'handoff', token: TOKEN}).state, 'handing_off');
  env.command({action: 'handoff', token: TOKEN});
  assert.equal(env.anchors.length, 1); assert.equal(env.anchors[0].href, ready.blobUrl);
  assert.equal(env.anchors[0].download, '公开完整音轨.m4a');
  env.command({action: 'cleanup', token: TOKEN}); await env.settle();
  assert.equal(env.files.size, 0); assert.deepEqual(env.revokedUrls, [ready.blobUrl]);
});

test('matching declared bytes alone cannot mark an unfinished body ready', async () => {
  const env = stageEnvironment({automatic: false}); env.start(); await env.settle();
  env.enqueue(fixture.bytes); await env.settle();
  assert.equal(env.poll().state, 'loading'); assert.equal(env.createdUrls.length, 0); assert.equal(env.anchors.length, 0);
  env.finish(); const ready = await env.terminal(); assert.equal(ready.state, 'ready', ready.error);
  env.command({action: 'cleanup', token: TOKEN}); await env.settle();
});

for (const [name, options, code] of [
  ['missing length', {length: null}, 'INCOMPLETE_MEDIA'],
  ['short EOF', {length: fixture.bytes.length + 1}, 'INCOMPLETE_MEDIA'],
  ['more bytes than declared', {bytes: new Uint8Array([...fixture.bytes, 0]), length: fixture.bytes.length}, 'INCOMPLETE_MEDIA'],
  ['the 3GB limit', {length: MAX_BYTES + 1}, 'SIZE_LIMIT'],
  ['insufficient OPFS quota', {quota: 1}, 'STORAGE_FULL'],
  ['an HTTP error', {status: 403}, 'HTTP_ERROR'],
  ['an HTML response', {bytes: new TextEncoder().encode('<html>access denied</html>'), contentType: 'text/html'}, 'INVALID_MEDIA'],
  ['a disk quota failure', {writeError: new DOMException('fixture URL must not leak', 'QuotaExceededError')}, 'STORAGE_FULL'],
]) {
  test('stage refuses ' + name + ' and removes unfinished media without an anchor', async () => {
    const env = stageEnvironment(options); env.start();
    const failed = await env.terminal();
    assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, code, failed.error);
    assert.equal(env.anchors.length, 0); assert.equal(env.createdUrls.length, 0);
    await env.settle(); assert.equal(env.files.size, 0);
    assert.ok(!String(failed.error).includes('fixture URL'));
  });
}

for (const [name, from, to] of [['a video handler', 'soun', 'vide'], ['encrypted audio', 'mp4a', 'enca'], ['missing initialization', 'moov', 'free']]) {
  test('the actual streamed container rejects ' + name + ' despite public AAC page metadata', async () => {
    const bytes = fixture.bytes.slice(), marker = new TextEncoder().encode(from);
    const offset = bytes.findIndex((_, index) => marker.every((value, relative) => bytes[index + relative] === value));
    assert.ok(offset >= 0); bytes.set(new TextEncoder().encode(to), offset);
    const env = stageEnvironment({bytes}); env.start();
    const failed = await env.terminal(); assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'INVALID_MEDIA', failed.error);
    assert.equal(env.anchors.length, 0); assert.equal(env.createdUrls.length, 0); await env.settle(); assert.equal(env.files.size, 0);
  });
}

test('a valid fragmented recording with a shorter actual duration cannot satisfy the full-length page hint', async () => {
  const env = stageEnvironment(); env.start({duration: 60});
  const failed = await env.terminal(); assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'INCOMPLETE_MEDIA', failed.error);
  assert.equal(env.createdUrls.length, 0); assert.equal(env.anchors.length, 0); await env.settle(); assert.equal(env.files.size, 0);
});

test('cleanup aborts an unfinished network body and deletes its private file without handing it off', async () => {
  const env = stageEnvironment({automatic: false}); env.start(); await env.settle();
  env.enqueue(fixture.bytes.slice(0, 150)); await env.settle();
  env.command({action: 'cleanup', token: TOKEN}); await env.settle();
  assert.equal(env.poll().state, 'disposed'); assert.ok(env.aborted > 0);
  assert.equal(env.files.size, 0); assert.equal(env.anchors.length, 0); assert.equal(env.createdUrls.length, 0);
});

test('network errors are sanitized and cannot leave a partial file or private signed URL in status', async () => {
  const env = stageEnvironment({automatic: false}); env.start(); await env.settle();
  env.enqueue(fixture.bytes.slice(0, 150)); await env.settle();
  env.fail(new Error(CDN + '?private-signature-fixture=1'));
  const failed = await env.terminal(); assert.equal(failed.state, 'failed');
  assert.ok(!JSON.stringify(failed).includes('private-signature-fixture')); assert.ok(!JSON.stringify(failed).includes('bilivideo.com'));
  await env.settle(); assert.equal(env.files.size, 0); assert.equal(env.anchors.length, 0);
});

test('the disk sink applies backpressure instead of queuing the whole network body in memory', async () => {
  const env = stageEnvironment(); env.pauseWrites(); env.start(); await env.settle();
  assert.equal(env.maxWritesActive, 1); assert.equal(env.writes.length, 0);
  assert.equal(env.poll().bytes, 0); assert.equal(env.createdUrls.length, 0);
  env.releaseWrites(); const ready = await env.terminal(); assert.equal(ready.state, 'ready', ready.error);
  assert.equal(env.maxWritesActive, 1); assert.equal(ready.bytes, fixture.bytes.length);
  await env.command({action: 'cleanup', token: TOKEN}); assert.equal(env.files.size, 0);
});

test('a full-range 206 response is accepted only when its complete range agrees with Content-Length', async () => {
  const length = fixture.bytes.length;
  const env = stageEnvironment({status: 206, contentRange: `bytes 0-${length - 1}/${length}`}); env.start();
  const ready = await env.terminal(); assert.equal(ready.state, 'ready', ready.error);
  assert.deepEqual([...new Set(env.responseHeaderReads)].sort(), ['content-length', 'content-range', 'content-type']);
  await env.command({action: 'cleanup', token: TOKEN});
});

test('a partial range cannot be disguised as a complete file with a matching body length', async () => {
  const env = stageEnvironment({status: 206, contentRange: `bytes 0-${fixture.bytes.length - 1}/${fixture.bytes.length + 100}`}); env.start();
  const failed = await env.terminal(); assert.equal(failed.errorCode, 'INCOMPLETE_MEDIA');
  assert.equal(env.createdUrls.length, 0); assert.equal(env.anchors.length, 0); assert.equal(env.files.size, 0);
});

test('deleting a final AAC packet and rewriting both HTTP and mdat lengths cannot evade sample-size validation', async () => {
  const view = new DataView(fixture.bytes.buffer, fixture.bytes.byteOffset, fixture.bytes.byteLength);
  let finalMdat;
  for (let offset = 0; offset < fixture.bytes.length;) {
    const size = view.getUint32(offset);
    if (new TextDecoder().decode(fixture.bytes.subarray(offset + 4, offset + 8)) === 'mdat') finalMdat = {offset, size};
    offset += size;
  }
  assert.ok(finalMdat); assert.equal(finalMdat.offset + finalMdat.size, fixture.bytes.length);
  const bytes = fixture.bytes.slice(0, -6);
  new DataView(bytes.buffer).setUint32(finalMdat.offset, finalMdat.size - 6);
  const env = stageEnvironment({bytes, length: bytes.length}); env.start();
  const failed = await env.terminal(); assert.equal(failed.state, 'failed');
  assert.equal(failed.errorCode, 'INVALID_MEDIA', failed.error);
  assert.equal(env.createdUrls.length, 0); assert.equal(env.anchors.length, 0);
  await env.settle(); assert.equal(env.files.size, 0);
});

test('opaque task tokens isolate cleanup and a changed source page cannot hand off an old recording', async () => {
  const env = stageEnvironment(); env.start(); const ready = await env.terminal(); assert.equal(ready.state, 'ready');
  await env.command({action: 'cleanup', token: '22222222-2222-4222-8222-222222222222'});
  assert.equal(env.poll().state, 'ready'); assert.equal(env.files.size, 1); assert.equal(env.revokedUrls.length, 0);
  env.context.location.href = SOURCE + '?p=2';
  const failed = env.command({action: 'handoff', token: TOKEN});
  assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'PAGE_CHANGED'); assert.equal(env.anchors.length, 0);
  await env.command({action: 'cleanup', token: TOKEN}); assert.equal(env.files.size, 0); assert.equal(env.revokedUrls.length, 1);
});
