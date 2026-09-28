import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {createContext, runInContext} from 'node:vm';
import {HelperError, parsePageAudio} from '../browser-helper/core.mjs';

const VIDEO = 'BV1T8D7BWE6S';
const PAGE = 'https://www.bilibili.com/video/' + VIDEO + '/';
const API = 'https://api.bilibili.com/x/player/wbi/playurl?cid=101&bvid=' + VIDEO;
const CACHE = '__SHIYIN_BILI_PLAYINFO_V1__';
const SENTINEL = '__SHIYIN_BILI_CAPTURE_INSTALLED_V1__';
const script = await readFile(new URL('../browser-helper/page-capture.js', import.meta.url), 'utf8');

function playerBody(change = {}) {
  return {code: 0, message: 'success', data: {
    timelength: 600_250,
    dash: {duration: 600.25, audio: [{
      id: 30280, codecs: 'mp4a.40.2', mimeType: 'audio/mp4', bandwidth: 128000,
      baseUrl: 'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/fixture/audio.m4s',
      backupUrl: ['https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/fixture/audio.m4s'],
    }]}, ...change,
  }};
}
function pageState() {
  return {bvid: VIDEO, cid: 101, videoData: {
    bvid: VIDEO, cid: 101, title: '公开完整音轨', state: 0,
    rights: {pay: 0, ugc_pay: 0},
    pages: [{cid: 101, page: 1, part: '正片', duration: 600}],
  }};
}

// Execute the actual MAIN-world observer against native-like fetch/XHR surfaces.
// This checks DOM/API boundaries; it is not a real Bilibili or Chrome visit.
function environment({foreignPromise = false} = {}) {
  const calls = [], xhrCalls = [], headerReads = [], cloneReads = [];
  let queuedResponse, nativePromise, mainPromise;
  function nativeFetch(...args) {
    calls.push(args);
    const response = queuedResponse ?? new Response(JSON.stringify(playerBody()), {status: 200});
    queuedResponse = undefined;
    const nativeClone = response.clone.bind(response);
    Object.defineProperty(response, 'clone', {configurable: true, value() {
      const clone = nativeClone(), nativeReader = clone.body.getReader.bind(clone.body);
      Object.defineProperty(clone.body, 'getReader', {value() {
        const reader = nativeReader(), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
        let finished;
        cloneReads.push(new Promise(resolve => { finished = resolve; }));
        reader.read = async () => {
          try { const chunk = await read(); if (chunk.done) finished(); return chunk; }
          catch (error) { finished(); throw error; }
        };
        reader.cancel = (...args) => { finished(); return cancel(...args); };
        return reader;
      }});
      return clone;
    }});
    nativePromise = (foreignPromise ? Promise : mainPromise).resolve(response);
    return nativePromise;
  }
  class FakeXHR extends EventTarget {
    constructor() {
      super(); this.responseType = ''; this.status = 0; this.responseURL = '';
      this.readyState = 0; this._body = ''; this._response = undefined;
    }
    open(...args) {
      xhrCalls.push({method: 'open', args});
      this.method = args[0]; this.responseURL = new URL(String(args[1]), PAGE).href; this.readyState = 1;
    }
    send(...args) { xhrCalls.push({method: 'send', args}); }
    setRequestHeader(...args) { xhrCalls.push({method: 'setRequestHeader', args}); }
    getResponseHeader(name) { headerReads.push(name); throw new Error('observer must not read response headers'); }
    getAllResponseHeaders() { headerReads.push('*'); throw new Error('observer must not read response headers'); }
    get responseText() {
      if (!['', 'text'].includes(this.responseType)) throw new Error('InvalidStateError');
      return this._body;
    }
    get response() { return this._response; }
    finish(body, {type = '', status = 200} = {}) {
      this.responseType = type; this.status = status; this.readyState = 4;
      this._body = typeof body === 'string' ? body : JSON.stringify(body);
      this._response = type === 'json' ? body : this._body;
      const load = new Event('load');
      this.onload?.call(this, load); this.dispatchEvent(load);
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const context = {
    location: {href: PAGE, origin: 'https://www.bilibili.com'},
    fetch: nativeFetch, XMLHttpRequest: FakeXHR,
    Request, Response, URL, TextDecoder, TextEncoder, Uint8Array,
    Event, EventTarget, AbortController, setTimeout, clearTimeout,
    __INITIAL_STATE__: pageState(),
  };
  context.window = context; context.self = context;
  const vm = createContext(context);
  mainPromise = runInContext('Promise', vm);
  function install() { runInContext(script, vm, {timeout: 1000}); }
  install();
  return {
    window: context, calls, xhrCalls, headerReads, install,
    respondWith(response) { queuedResponse = response; },
    get nativePromise() { return nativePromise; },
    get cached() { return context[CACHE]; },
    async settle() {
      await Promise.resolve();
      await Promise.all(cloneReads);
      for (let step = 0; step < 3; step++) await setImmediate();
    },
  };
}
function coreSnapshot(captured) {
  return {location: {href: PAGE}, initialState: pageState(), playinfo: captured.playinfo};
}

test('passive fetch capture keeps the exact native promise, response and request count', async () => {
  const env = environment(), response = new Response(JSON.stringify(playerBody()), {status: 200});
  const options = {method: 'GET', credentials: 'include', headers: {'x-private-fixture': 'private-header-fixture'}};
  env.respondWith(response);
  const observed = env.window.fetch(API, options);
  assert.equal(observed, env.nativePromise);
  assert.equal(await observed, response);
  assert.deepEqual(await response.json(), playerBody());
  await env.settle();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0][0], API); assert.equal(env.calls[0][1], options);
  assert.equal(env.cached.requestCid, '101');
  assert.equal(env.cached.requestBvid, VIDEO);
  assert.equal(env.cached.playinfo.data.cid, 101);
  assert.equal(parsePageAudio(coreSnapshot(env.cached), PAGE).files[0].duration, 600.25);
});

test('a cross-realm player fetch promise is observed before the player consumes its original response', async () => {
  const env = environment({foreignPromise: true}), response = new Response(JSON.stringify(playerBody()), {status: 200});
  env.respondWith(response);
  const pending = env.window.fetch(API);
  assert.equal(pending, env.nativePromise); assert.equal(await pending, response);
  assert.deepEqual(await response.json(), playerBody()); await env.settle();
  assert.equal(env.calls.length, 1); assert.equal(env.cached.requestCid, '101');
  assert.equal(env.cached.playinfo.data.cid, 101);
});

test('the legacy official GET player path and Request objects are observed without reconstructing the request', async () => {
  const env = environment();
  const request = new Request('https://api.bilibili.com/x/player/playurl?cid=101&avid=202', {method: 'GET'});
  const response = await env.window.fetch(request);
  await response.text(); await env.settle();
  assert.equal(env.calls.length, 1); assert.equal(env.calls[0][0], request);
  assert.equal(env.cached.requestCid, '101'); assert.equal(env.cached.requestAid, '202');
});

for (const [name, url, method] of [
  ['a lookalike API hostname', 'https://api.bilibili.com.evil.net/x/player/wbi/playurl?cid=101', 'GET'],
  ['an insecure API', API.replace('https:', 'http:'), 'GET'],
  ['an alternate port', API.replace('api.bilibili.com', 'api.bilibili.com:8443'), 'GET'],
  ['an API URL with credentials', API.replace('https://', 'https://fixture:secret@'), 'GET'],
  ['an unrelated official API', 'https://api.bilibili.com/x/web-interface/view?cid=101', 'GET'],
  ['a path suffix', 'https://api.bilibili.com/x/player/wbi/playurl/extra?cid=101', 'GET'],
  ['a substring of the player path', 'https://api.bilibili.com/other/x/player/wbi/playurl?cid=101', 'GET'],
  ['a paid-series player API', 'https://api.bilibili.com/pgc/player/web/playurl?cid=101', 'GET'],
  ['a POST player request', API, 'POST'],
  ['duplicate CID parameters', API + '&cid=202', 'GET'],
  ['a nonnumeric CID', API.replace('cid=101', 'cid=not-a-cid'), 'GET'],
  ['an unsafe integer CID', API.replace('cid=101', 'cid=9007199254740992'), 'GET'],
  ['a missing CID', 'https://api.bilibili.com/x/player/wbi/playurl?bvid=' + VIDEO, 'GET'],
]) {
  test('passive capture ignores ' + name + ' while preserving the player response', async () => {
    const env = environment(), body = playerBody();
    const response = await env.window.fetch(url, {method});
    assert.deepEqual(await response.json(), body); await env.settle();
    assert.equal(env.calls.length, 1); assert.equal(env.cached, undefined);
  });
}

for (const [name, change] of [
  ['a different response CID', body => { body.data.cid = 202; }],
  ['a contradictory top-level CID', body => { body.cid = 202; }],
]) {
  test('capture refuses ' + name + ' rather than associating it with the current part', async () => {
    const env = environment(), body = playerBody(); change(body);
    env.respondWith(new Response(JSON.stringify(body), {status: 200}));
    const response = await env.window.fetch(API); await response.text(); await env.settle();
    assert.equal(env.calls.length, 1); assert.equal(env.cached, undefined);
  });
}

test('an official player error remains an error and cannot yield registered audio', async () => {
  const env = environment(), body = playerBody(); body.code = -403;
  env.respondWith(new Response(JSON.stringify(body), {status: 200}));
  const response = await env.window.fetch(API); await response.text(); await env.settle();
  assert.equal(env.cached.playinfo.code, -403);
  assert.equal(env.cached.playinfo.data.dash, undefined);
  assert.throws(() => parsePageAudio(coreSnapshot(env.cached), PAGE), error => error instanceof HelperError && error.code === 'NEEDS_USER');
  assert.equal(env.calls.length, 1);
});

for (const [name, change] of [
  ['paid', body => { body.data.is_pay = 1; }],
  ['preview', body => { body.data.is_preview = true; }],
  ['DRM', body => { body.data.drm_tech_type = 2; body.data.drm_key = 'private-drm-key-fixture'; }],
]) {
  test('passive capture preserves ' + name + ' restrictions for complete-media rejection', async () => {
    const env = environment(), body = playerBody(); change(body);
    env.respondWith(new Response(JSON.stringify(body), {status: 200}));
    const response = await env.window.fetch(API); await response.text(); await env.settle();
    assert.ok(env.cached);
    assert.throws(() => parsePageAudio(coreSnapshot(env.cached), PAGE), error => error instanceof HelperError && error.code === 'RESTRICTED_MEDIA');
    assert.ok(!JSON.stringify(env.cached).includes('private-drm-key-fixture'));
  });
}

test('the capture cache retains public audio metadata without request signatures, headers or unrelated response fields', async () => {
  const env = environment(), body = playerBody();
  body.cookie = 'private-cookie-fixture'; body.headers = {authorization: 'private-authorization-fixture'};
  body.data.userInfo = {session: 'private-session-fixture'};
  body.data.dash.video = [{baseUrl: 'https://private-video-fixture.invalid/video'}];
  body.data.dash.audio[0].unrelated = 'private-track-fixture';
  const url = API + '&w_rid=private-signature-fixture&wts=private-timestamp-fixture';
  env.respondWith(new Response(JSON.stringify(body), {status: 200}));
  const response = await env.window.fetch(url, {headers: {Cookie: 'private-cookie-header-fixture'}});
  await response.text(); await env.settle();
  assert.ok(env.cached);
  const saved = JSON.stringify(env.cached);
  for (const marker of ['private-cookie', 'private-authorization', 'private-session', 'private-video', 'private-track', 'private-signature', 'private-timestamp']) {
    assert.ok(!saved.includes(marker), 'cache must omit ' + marker);
  }
  assert.equal(env.calls.length, 1);
  assert.equal(env.cached.playinfo.data.dash.video, undefined);
});

for (const [name, text] of [
  ['damaged JSON', '{"code":0,"data":'],
  ['an oversized body', JSON.stringify({...playerBody(), ignored: 'x'.repeat(1024 * 1024 + 1)})],
]) {
  test(name + ' cannot interfere with the native player response or populate the cache', async () => {
    const env = environment(), response = new Response(text, {status: 200});
    env.respondWith(response);
    assert.equal(await env.window.fetch(API), response);
    assert.equal(await response.text(), text); await env.settle();
    assert.equal(env.calls.length, 1); assert.equal(env.cached, undefined);
  });
}

for (const type of ['', 'text', 'json']) {
  test('passive XHR observes a successful ' + (type || 'default text') + ' response without another request or header reads', async () => {
    const env = environment(), xhr = new env.window.XMLHttpRequest();
    const body = playerBody(); let playerLoads = 0;
    xhr.onload = () => { playerLoads++; };
    xhr.open('GET', API, true); xhr.setRequestHeader('x-private-fixture', 'private-xhr-header-fixture'); xhr.send();
    xhr.finish(body, {type}); await env.settle();
    assert.equal(playerLoads, 1);
    assert.equal(env.xhrCalls.filter(call => call.method === 'open').length, 1);
    assert.equal(env.xhrCalls.filter(call => call.method === 'send').length, 1);
    assert.deepEqual(env.headerReads, []);
    assert.equal(env.calls.length, 0);
    assert.equal(env.cached.requestCid, '101');
    assert.equal(env.cached.playinfo.data.cid, 101);
    assert.ok(!JSON.stringify(env.cached).includes('private-xhr-header-fixture'));
  });
}

test('unrelated or damaged XHR responses leave native load notifications intact', async () => {
  const env = environment();
  for (const [url, body, method = 'GET'] of [
    ['https://api.bilibili.com/x/web-interface/view?cid=101', playerBody()],
    ['https://api.bilibili.com.evil.net/x/player/wbi/playurl?cid=101', playerBody()],
    [API, playerBody(), 'POST'],
    [API, '{damaged-json'],
  ]) {
    const xhr = new env.window.XMLHttpRequest(); let loadCount = 0;
    xhr.onload = () => { loadCount++; }; xhr.open(method, url); xhr.send(); xhr.finish(body);
    assert.equal(loadCount, 1);
  }
  await env.settle();
  assert.equal(env.cached, undefined); assert.equal(env.calls.length, 0);
  assert.equal(env.xhrCalls.filter(call => call.method === 'send').length, 4);
});

test('a late player response cannot replace the newer request CID or revive audio after its error', async () => {
  const env = environment(), older = new env.window.XMLHttpRequest(), newer = new env.window.XMLHttpRequest();
  older.open('GET', API); older.send();
  newer.open('GET', API.replace('cid=101', 'cid=202')); newer.send();
  newer.finish(playerBody(), {type: 'json'});
  assert.equal(env.cached.requestCid, '202'); assert.equal(env.cached.playinfo.data.cid, 202);
  older.finish(playerBody(), {type: 'json'});
  assert.equal(env.cached.requestCid, '202');
  const failing = new env.window.XMLHttpRequest(); failing.open('GET', API.replace('cid=101', 'cid=303')); failing.send();
  assert.equal(env.cached, undefined, 'a new playback request must immediately retire the earlier audio metadata');
  failing.finish({...playerBody(), code: -403}, {type: 'json'});
  assert.equal(env.cached.requestCid, '303'); assert.equal(env.cached.playinfo.code, -403);
  assert.equal(env.cached.playinfo.data.dash, undefined);
  assert.equal(env.xhrCalls.filter(call => call.method === 'send').length, 3); assert.equal(env.calls.length, 0);
});

test('reinstalling the MAIN-world observer cannot wrap fetch or XHR twice', async () => {
  const env = environment(), fetch = env.window.fetch;
  const open = env.window.XMLHttpRequest.prototype.open, send = env.window.XMLHttpRequest.prototype.send;
  env.install(); env.install();
  assert.equal(env.window.fetch, fetch);
  assert.equal(env.window.XMLHttpRequest.prototype.open, open);
  assert.equal(env.window.XMLHttpRequest.prototype.send, send);
  assert.equal(Object.getOwnPropertyDescriptor(env.window, SENTINEL).enumerable, false);
  const response = await env.window.fetch(API); await response.text(); await env.settle();
  assert.equal(env.calls.length, 1); assert.ok(env.cached);
});
