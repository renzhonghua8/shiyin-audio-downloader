import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {runInNewContext} from 'node:vm';
import {
  CHANNEL, HelperError, assertOwner, audioFilename, mediaExpiry,
  isCompleteNativeFile, parseBilibiliUrl, parsePageAudio, snapshotDownloads, validateEnvelope,
  validateMediaUrl, validateSiteOrigin,
} from '../browser-helper/core.mjs';

const VIDEO = 'BV1T8D7BWE6S';
const PAGE = `https://www.bilibili.com/video/${VIDEO}/`;
const CDN = 'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/fixture/audio.m4s';
const BACKUP = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/fixture/audio.m4s';
const OWNER = {origin: 'http://audio.fixtures.net:8080', tabId: 17};

// Model the public fields supplied by Bilibili's normal player, without any
// cookies, fingerprints, real signed locations or playable saved recordings.
function pageSnapshot() {
  return {
    location: {href: PAGE},
    initialState: {
      bvid: VIDEO, cid: 101,
      videoData: {
        bvid: VIDEO, cid: 101, title: '公开完整音轨', state: 0,
        rights: {pay: 0, ugc_pay: 0},
        pages: [{cid: 101, page: 1, part: '正片', duration: 600}],
      },
    },
    playinfo: {code: 0, data: {
      cid: 101, timelength: 600_250,
      dash: {duration: 600.25, audio: [{
        id: 30280, codecs: 'mp4a.40.2', mimeType: 'audio/mp4', bandwidth: 128000,
        baseUrl: CDN, backupUrl: [BACKUP, CDN],
      }]},
    }},
  };
}

function multipartSnapshot(part, url) {
  const snapshot = pageSnapshot();
  const cid = part === 1 ? 101 : 202, duration = part === 1 ? 600 : 300;
  snapshot.location.href = url;
  snapshot.initialState.cid = cid;
  snapshot.initialState.videoData.pages = [
    {cid: 101, page: 1, part: '第一段', duration: 600},
    {cid: 202, page: 2, part: '第二段', duration: 300},
  ];
  snapshot.playinfo.data.cid = cid;
  snapshot.playinfo.data.timelength = (duration + 0.25) * 1000;
  snapshot.playinfo.data.dash.duration = duration + 0.25;
  snapshot.playinfo.data.dash.audio[0].baseUrl = CDN.replace('audio.m4s', 'part-' + part + '.m4s');
  snapshot.playinfo.data.dash.audio[0].backupUrl = [BACKUP.replace('audio.m4s', 'part-' + part + '.m4s')];
  return snapshot;
}

function throwsCode(operation, code) {
  assert.throws(operation, error => error instanceof HelperError && error.code === code);
}

test('a public complete AAC recording yields one canonical file and bounded official alternatives', () => {
  const result = parsePageAudio(pageSnapshot(), PAGE + '?share_source=copy_web');
  assert.equal(result.title, '公开完整音轨');
  assert.equal(result.files.length, 1);
  const file = result.files[0];
  assert.equal(file.format, 'm4a');
  assert.equal(file.codec, 'aac');
  assert.equal(file.duration, 600.25);
  assert.equal(file.cid, 101);
  assert.equal(file.page, 1);
  assert.equal(file.source, PAGE);
  assert.deepEqual(file.mediaUrls, [CDN, BACKUP]);
  assert.ok(file.filename.endsWith('.m4a'));
  assert.deepEqual(result.warnings, []);
});

test('selected P2 keeps its own CID, duration, title and canonical source', () => {
  const snapshot = pageSnapshot();
  snapshot.location.href = PAGE + '?p=2&share_source=copy_web';
  snapshot.initialState.cid = 202;
  snapshot.initialState.videoData.pages.push({cid: 202, page: 2, part: '第二段', duration: 300});
  snapshot.playinfo.data.cid = 202;
  snapshot.playinfo.data.timelength = 300_500;
  snapshot.playinfo.data.dash.duration = 300.5;
  const result = parsePageAudio(snapshot, PAGE + '?p=2');
  assert.equal(result.parts.length, 2);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].cid, 202);
  assert.equal(result.files[0].page, 2);
  assert.equal(result.files[0].duration, 300.5);
  assert.equal(result.files[0].source, PAGE + '?p=2');
  assert.match(result.files[0].title, /P2.*第二段/);
});

for (const [label, change, code] of [
  ['a different page BV', s => { s.location.href = 'https://www.bilibili.com/video/BV1LhqcYwEQD/'; }, 'PAGE_MISMATCH'],
  ['a different metadata BV', s => { s.initialState.videoData.bvid = 'BV1LhqcYwEQD'; }, 'PAGE_MISMATCH'],
  ['a different initial metadata BV', s => { s.initialState.bvid = 'BV1LhqcYwEQD'; }, 'PAGE_MISMATCH'],
  ['a stale current CID', s => { s.initialState.cid = 202; }, 'PAGE_MISMATCH'],
  ['a stale playback CID', s => { s.playinfo.data.cid = 202; }, 'PAGE_MISMATCH'],
  ['a redirected login page', s => { s.location.href = 'https://passport.bilibili.com/login'; }, 'NEEDS_USER'],
  ['missing player globals', s => { delete s.playinfo; }, 'NEEDS_USER'],
  ['a failed official playback response', s => { s.playinfo.code = -403; }, 'NEEDS_USER'],
  ['unknown public-access flags', s => { delete s.initialState.videoData.rights.ugc_pay; }, 'UNSUPPORTED_PERMISSION'],
]) {
  test(`page identity and availability reject ${label}`, () => {
    const snapshot = pageSnapshot(); change(snapshot);
    throwsCode(() => parsePageAudio(snapshot, PAGE), code);
  });
}

test('P2 requires an explicitly current CID instead of silently reusing the first part', () => {
  const snapshot = pageSnapshot();
  snapshot.location.href = PAGE + '?p=2';
  snapshot.initialState.videoData.pages.push({cid: 202, page: 2, part: '第二段', duration: 300});
  delete snapshot.initialState.cid;
  snapshot.playinfo.data.cid = 202;
  snapshot.playinfo.data.timelength = 300_000;
  snapshot.playinfo.data.dash.duration = 300;
  throwsCode(() => parsePageAudio(snapshot, PAGE + '?p=2'), 'PAGE_MISMATCH');
});

for (const [label, change] of [
  ['a short preview', s => { s.playinfo.data.timelength = 30_000; s.playinfo.data.dash.duration = 30; }],
  ['unknown complete duration', s => { delete s.playinfo.data.timelength; }],
  ['a shorter DASH stream', s => { s.playinfo.data.dash.duration = 30; }],
  ['inconsistent container and video lengths', s => { s.playinfo.data.dash.duration = 590; }],
  ['a longer stale recording without a playback CID', s => { delete s.playinfo.data.cid; s.playinfo.data.timelength = 1_200_000; s.playinfo.data.dash.duration = 1200; }],
]) {
  test(`complete-media checks reject ${label}`, () => {
    const snapshot = pageSnapshot(); change(snapshot);
    throwsCode(() => parsePageAudio(snapshot, PAGE), 'INCOMPLETE_MEDIA');
  });
}

for (const [label, change] of [
  ['paid rights', s => { s.initialState.videoData.rights.pay = 1; }],
  ['arc paid rights', s => { s.initialState.videoData.rights.arc_pay = 1; }],
  ['UGC paid rights', s => { s.initialState.videoData.rights.ugc_pay = 1; }],
  ['a preview permission', s => { s.playinfo.data.is_preview = true; }],
  ['a login requirement', s => { s.playinfo.data.need_login = true; }],
  ['a DRM requirement', s => { s.playinfo.data.drm_tech_type = 2; }],
  ['a nested VIP restriction', s => { s.initialState.videoData.permission = {vip_only: true}; }],
]) {
  test(`browser extraction refuses ${label}`, () => {
    const snapshot = pageSnapshot(); change(snapshot);
    throwsCode(() => parsePageAudio(snapshot, PAGE), 'RESTRICTED_MEDIA');
  });
}

for (const [label, change] of [
  ['an unsupported codec', s => { s.playinfo.data.dash.audio[0].codecs = 'fLaC'; }],
  ['a video track pretending to be audio', s => { s.playinfo.data.dash.audio[0].mimeType = 'video/mp4'; }],
  ['a DRM-marked audio track', s => { s.playinfo.data.dash.audio[0].drm = true; }],
  ['no separate DASH audio', s => { s.playinfo.data.dash.audio = []; }],
]) {
  test(`AAC-only extraction refuses ${label}`, () => {
    const snapshot = pageSnapshot(); change(snapshot);
    throwsCode(() => parsePageAudio(snapshot, PAGE), 'UNSUPPORTED_MEDIA');
  });
}

for (const address of [
  'https://bilivideo.com.evil.net/audio.m4s',
  'https://evilbilivideo.com/audio.m4s',
  'https://upos-sz-mirrorali.bilivideo.com@evil.net/audio.m4s',
  'https://user:password@upos-sz-mirrorali.bilivideo.com/audio.m4s',
  'http://upos-sz-mirrorali.bilivideo.com/audio.m4s',
  'https://upos-sz-mirrorali.bilivideo.com:8443/audio.m4s',
  'https://127.0.0.1/audio.m4s',
  'https://upos-sz-mirrorali.bilivideo.com/audio.m4s#external',
  'javascript:alert(1)',
]) {
  test(`CDN validation refuses ${address}`, () => throwsCode(() => validateMediaUrl(address), 'UNSUPPORTED_MEDIA'));
}

test('an injected backup address rejects the complete scan, even alongside a valid primary CDN', () => {
  const snapshot = pageSnapshot();
  snapshot.playinfo.data.dash.audio[0].backupUrl.push('https://bilivideo.com.evil.net/audio.m4s');
  throwsCode(() => parsePageAudio(snapshot, PAGE), 'UNSUPPORTED_MEDIA');
});

test('signed locations expire at the earliest official deadline and retain a finite default TTL', () => {
  const now = 1_900_000_000_000;
  assert.equal(mediaExpiry(CDN, now), now + 30 * 60 * 1000);
  assert.equal(mediaExpiry(CDN + '?deadline=1900000600&expires=1900000300000', now), now + 300_000);
  assert.ok(mediaExpiry(CDN + '?deadline=1899999999', now) < now);
});

test('source parsing preserves selected P while stripping tracking parameters and refusing lookalike origins', () => {
  assert.deepEqual(parseBilibiliUrl(PAGE + '?p=2&vd_source=fixture'), {bvid: VIDEO, part: 2, canonical: PAGE + '?p=2'});
  for (const raw of [PAGE.replace('https:', 'http:'), PAGE.replace('www.bilibili.com', 'www.bilibili.com.evil.net'), PAGE + '?p=0', PAGE + '?p=-1', PAGE + '?p=1.5']) {
    assert.throws(() => parseBilibiliUrl(raw), HelperError);
  }
});

test('registered media and jobs are accessible only to their exact website origin and originating tab', () => {
  const registered = {origin: OWNER.origin, tabId: OWNER.tabId, helperId: 'registered-media', mediaUrls: [CDN]};
  const job = {origin: OWNER.origin, tabId: OWNER.tabId, id: 'native-job', files: []};
  for (const record of [registered, job]) {
    assert.equal(assertOwner(record, OWNER), record);
    for (const owner of [
      {...OWNER, tabId: OWNER.tabId + 1},
      {...OWNER, origin: OWNER.origin.replace('http:', 'https:')},
      {...OWNER, origin: OWNER.origin.replace(':8080', ':8081')},
      {...OWNER, origin: OWNER.origin + '.evil.net'},
    ]) throwsCode(() => assertOwner(record, owner), 'FORBIDDEN');
  }
  throwsCode(() => assertOwner(undefined, OWNER), 'FORBIDDEN');
});

test('binding accepts HTTP websites and normalizes their exact origin without embedded credentials', () => {
  assert.equal(validateSiteOrigin(OWNER.origin + '/audio?view=1'), OWNER.origin);
  assert.equal(validateSiteOrigin('http://203.0.113.1:8080/'), 'http://203.0.113.1:8080');
  for (const raw of ['file:///tmp/audio.html', 'javascript:alert(1)', 'https://user:password@audio.fixtures.net/', 'not a URL']) {
    throwsCode(() => validateSiteOrigin(raw), 'INVALID_ORIGIN');
  }
});

test('message envelopes reject unknown operations, malformed payloads and unsafe correlation IDs', () => {
  const valid = {channel: CHANNEL, direction: 'to-helper', id: 'request:1', action: 'download', payload: {helperId: 'registered-media'}};
  assert.deepEqual(validateEnvelope(valid), {id: valid.id, action: valid.action, payload: valid.payload});
  for (const message of [null, [], {...valid, channel: 'OTHER'}, {...valid, direction: 'to-page'}, {...valid, id: ''}, {...valid, id: 'bad\nrequest'}, {...valid, action: 'fetchMediaUrl'}, {...valid, payload: []}, {...valid, payload: 'https://evil.net/audio.m4s'}]) {
    throwsCode(() => validateEnvelope(message), 'INVALID_MESSAGE');
  }
});

test('native downloads reaching totalBytes are still transferring until Chrome reports complete', () => {
  const job = {id: 'native-job', kind: 'file', title: '公开音频', files: [{title: '公开音频', filename: '音频.m4a', nativeId: 8, state: 'transferring'}]};
  const ongoing = snapshotDownloads(job, [{id: 8, state: 'in_progress', bytesReceived: 500, totalBytes: 500}]);
  assert.equal(ongoing.state, 'transferring');
  assert.equal(ongoing.completedFiles, 0);
  assert.equal(ongoing.bytes, 500);
  assert.equal(ongoing.totalBytes, 500);
  const completed = snapshotDownloads(job, [{id: 8, state: 'complete', bytesReceived: 500, totalBytes: 500}]);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completedFiles, 1);
});

test('persisted jobs recover completion and interruption from Chrome rather than a stale worker state', () => {
  const job = {id: 'restored-job', kind: 'bundle', title: '两段音频', files: [
    {title: '成功音频', filename: '成功.m4a', nativeId: 8, state: 'preparing'},
    {title: '中断音频', filename: '中断.m4a', nativeId: 9, state: 'waiting'},
  ]};
  const snapshot = snapshotDownloads(job, [
    {id: 8, state: 'complete', bytesReceived: 500, totalBytes: 500},
    {id: 9, state: 'interrupted', bytesReceived: 120, totalBytes: 400, error: 'NETWORK_FAILED'},
  ]);
  assert.equal(snapshot.state, 'partial');
  assert.equal(snapshot.completedFiles, 1);
  assert.equal(snapshot.totalFiles, 2);
  assert.equal(snapshot.bytes, 620);
  assert.equal(snapshot.totalBytes, 900);
  assert.ok(snapshot.failures.some(message => /中断音频.*NETWORK_FAILED/.test(message)));
});

test('unknown native sizes stay indeterminate and a canceled download never becomes completed', () => {
  const job = {id: 'canceled-job', kind: 'file', title: '音频', files: [{title: '音频', filename: '音频.m4a', nativeId: 8, state: 'transferring'}]};
  const ongoing = snapshotDownloads(job, [{id: 8, state: 'in_progress', bytesReceived: 30, totalBytes: -1}]);
  assert.equal(ongoing.state, 'transferring');
  assert.equal(ongoing.totalBytes, undefined);
  const canceled = snapshotDownloads(job, [{id: 8, state: 'interrupted', bytesReceived: 30, totalBytes: -1, error: 'USER_CANCELED'}]);
  assert.equal(canceled.state, 'failed');
  assert.equal(canceled.completedFiles, 0);
  assert.match(canceled.error, /USER_CANCELED/);
});

test('download filenames remain safe and within the native UTF-8 filename boundary', () => {
  const name = audioFilename('  ../坏\u0000标题: /\\ ? <audio> ' + '声音'.repeat(100));
  assert.ok(name.endsWith('.m4a'));
  assert.ok(new TextEncoder().encode(name).length <= 255);
  assert.doesNotMatch(name, /[\x00-\x1f<>:"/\\|?*]/);
});

const STATE_KEY = 'shiyin.helper.state.v1';
let workerSerial = 0;
function sdkEvent() {
  const listeners = [];
  return {addListener(listener) { listeners.push(listener); }, emit(...args) { for (const listener of listeners) listener(...args); }, listeners};
}
function registeredMedia(id = 'registered-media', owner = OWNER) {
  return {id, ...owner, expiresAt: Date.now() + 20 * 60 * 1000, source: PAGE, title: '完整音频', filename: '完整音频.m4a', mediaUrls: [CDN, BACKUP], duration: 600.25};
}
function savedStageFile(change = {}) {
  const token = '11111111-1111-4111-8111-111111111111';
  return {...registeredMedia(), state: 'transferring', bytes: 500, totalBytes: 500,
    expectedBytes: 500, candidateIndex: 0, startedAt: Date.now(),
    stageTabId: 202, stageToken: token, stageStarted: true, stagePhase: 'handing_off',
    blobUrl: 'blob:https://www.bilibili.com/' + token, handoffAt: Date.now(), ...change};
}
function savedStage(file) {
  return {tabId: file.stageTabId, token: file.stageToken, source: file.source,
    filename: file.filename, state: file.stagePhase, bytes: file.bytes,
    expectedBytes: file.expectedBytes, blobUrl: file.blobUrl, createdAt: file.startedAt, updatedAt: Date.now()};
}
function savedJob(file, id = 'recover-job') {
  return {id, ...OWNER, kind: 'file', title: file.title, createdAt: Date.now(), files: [file]};
}
function savedNative(file, change = {}) {
  return {id: 81, url: file.blobUrl, filename: '/Downloads/' + file.filename,
    state: 'complete', startTime: new Date().toISOString(), bytesReceived: 500,
    totalBytes: 500, fileSize: 500, ...change};
}
async function workerBoundary(t, saved = {}, native = [], recoveredStages = []) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const data = {[STATE_KEY]: {siteOrigin: OWNER.origin, sitePattern: OWNER.origin + '/*', registry: {}, jobs: {}, paused: {}, ...structuredClone(saved)}};
  const tabs = new Map([[OWNER.tabId, {id: OWNER.tabId, url: OWNER.origin + '/'}], [OWNER.tabId + 1, {id: OWNER.tabId + 1, url: OWNER.origin + '/'}]]);
  const nativeItems = new Map(native.map(item => [item.id, structuredClone(item)]));
  const downloadCalls = [], nativeCancels = [], navigation = [], pageReads = [], bridgeRegistrations = [], bridgeInjections = [], stageCommands = [], stageCleanups = [];
  const stageRecords = new Map(recoveredStages.map(stage => [stage.tabId, structuredClone(stage)]));
  for (const stage of recoveredStages) tabs.set(stage.tabId, {id: stage.tabId, url: stage.source || PAGE, status: 'complete'});
  const messageEvent = sdkEvent();
  let nextTab = 200, nextDownload = 500;
  let snapshot = pageSnapshot(), pageReader, permissionGranted = true, windowExtras = {}, automaticReady = true, automaticAnchor = true;
  let pageGate, releasePage;
  function stageCommand(tabId, args) {
    stageCommands.push({tabId, ...structuredClone(args)});
    let stage = stageRecords.get(tabId);
    if (args.action === 'cleanup') {
      stageCleanups.push({tabId, token: args.token});
      if (stage?.token === args.token) stageRecords.delete(tabId);
      return {token: args.token, state: 'disposed', bytes: 0, createdAt: Date.now(), updatedAt: Date.now()};
    }
    if (args.action === 'start' && !stage) {
      stage = {tabId, token: args.token, source: args.source, filename: args.filename, state: automaticReady ? 'ready' : 'loading', bytes: automaticReady ? 500 : 0, expectedBytes: 500,
        blobUrl: 'blob:https://www.bilibili.com/' + args.token, createdAt: Date.now(), updatedAt: Date.now()};
      stageRecords.set(tabId, stage);
    }
    if (!stage || stage.token !== args.token) return {token: args.token, state: 'missing', bytes: 0};
    if (args.action === 'handoff' && stage.state === 'ready') {
      stage.state = 'handing_off'; stage.updatedAt = Date.now();
      if (automaticAnchor) {
        const id = nextDownload++;
        downloadCalls.push({url: stage.blobUrl, filename: stage.filename, tabId});
        nativeItems.set(id, {id, url: stage.blobUrl, filename: '/Downloads/' + stage.filename, state: 'in_progress', startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: 500, fileSize: -1});
      }
    }
    return structuredClone(stage);
  }
  const chromeSdk = {
    runtime: {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', getURL: path => 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' + path, onMessage: messageEvent},
    storage: {local: {async setAccessLevel() {}, async get(key) { return {[key]: structuredClone(data[key])}; }, async set(value) { Object.assign(data, structuredClone(value)); }}},
    alarms: {async create() {}, onAlarm: sdkEvent()},
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('fixture tab removed'); return structuredClone(tabs.get(id)); },
      async create(change) { const tab = {id: nextTab++, status: 'complete', ...change}; tabs.set(tab.id, tab); navigation.push(change.url); return structuredClone(tab); },
      async update(id, change) { const tab = tabs.get(id); if (!tab) throw new Error('fixture tab removed'); Object.assign(tab, change); if (change.url) navigation.push(change.url); return structuredClone(tab); },
      async remove(id) { tabs.delete(id); chromeSdk.tabs.onRemoved.emit(id); },
      async sendMessage() {}, onRemoved: sdkEvent(), onUpdated: sdkEvent(),
    },
    scripting: {
      async registerContentScripts(scripts) { bridgeRegistrations.push(...structuredClone(scripts)); }, async unregisterContentScripts() {},
      async executeScript(options) {
        if (!options.func) { bridgeInjections.push(structuredClone(options)); return []; }
        if (pageGate) await pageGate;
        const url = tabs.get(options.target.tabId)?.url;
        pageReads.push(url);
        const current = pageReader ? pageReader(url) : snapshot;
        const window = {...structuredClone(windowExtras), __INITIAL_STATE__: structuredClone(current.initialState), __playinfo__: structuredClone(current.playinfo),
          __SHIYIN_AUDIO_SAVE_V1__: {command: args => stageCommand(options.target.tabId, args)}};
        if (window.__INITIAL_STATE__) window.__INITIAL_STATE__.userInfo = {session: 'fixture-private-context'};
        Object.defineProperty(window, 'document', {value: {get cookie() { throw new Error('page cookie must never be read'); }}});
        const result = await runInNewContext('(' + options.func.toString() + ')(...__args)', {window, location: {href: current.location.href}, URL, Date, __args: options.args || []});
        return [{result: structuredClone(result)}];
      },
    },
    permissions: {async contains() { return permissionGranted; }, async remove() { return true; }, onAdded: sdkEvent(), onRemoved: sdkEvent()},
    downloads: {
      onChanged: sdkEvent(), onCreated: sdkEvent(),
      async search(query) { return [...nativeItems.values()].filter(item => (query.id === undefined || item.id === query.id)
        && (query.startedAfter === undefined || Date.parse(item.startTime) >= Date.parse(query.startedAfter))).map(item => structuredClone(item)); },
      async download() { throw new Error('registered CDN URLs must not be passed to chrome.downloads.download'); },
      async cancel(id) { nativeCancels.push(id); const item = nativeItems.get(id); if (item) {item.state = 'interrupted'; item.error = 'USER_CANCELED';} },
    },
  };
  Object.defineProperty(globalThis, 'chrome', {configurable: true, value: chromeSdk});
  t.after(async () => {
    await settle();
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor); else Reflect.deleteProperty(globalThis, 'chrome');
  });
  await import(new URL('../browser-helper/background.mjs', import.meta.url).href + '?fixtureWorker=' + (++workerSerial));
  async function settle() { for (let i = 0; i < 3; i++) await setImmediate(); }
  async function request(action, payload = {}, owner = OWNER, extra = {}) {
    const sender = {tab: {id: owner.tabId}, frameId: 0, url: owner.origin + '/', ...extra};
    const envelope = {channel: CHANNEL, direction: 'to-helper', id: 'sdk-request-' + (++workerSerial), action, payload, bridgeOrigin: owner.origin};
    const response = await new Promise(resolve => messageEvent.listeners[0](envelope, sender, resolve));
    await settle();
    if (['download', 'downloadBatch'].includes(action) && response.ok) {
      // Model the webpage's existing status polling, without starting another
      // network request or fabricating native completion.
      for (let poll = 0; poll < 3; poll++) await request('getDownloadStatus', {id: response.result.id}, owner, extra);
    }
    return response;
  }
  async function popup(popupAction, fields = {}, dropReply = false) {
    const message = {popupAction, ...fields}, sender = {url: chromeSdk.runtime.getURL('popup.html')};
    if (dropReply) { messageEvent.listeners[0](message, sender, () => {}); await settle(); return; }
    const response = await new Promise(resolve => messageEvent.listeners[0](message, sender, resolve));
    await settle(); return response;
  }
  await request('ping');
  return {
    request, popup, settle, data, chrome: chromeSdk, downloadCalls, nativeCancels, nativeItems, navigation, pageReads, tabs, bridgeRegistrations, bridgeInjections, stageCommands, stageRecords, stageCleanups,
    setSnapshot(value) { snapshot = value; },
    setPageReader(value) { pageReader = value; },
    setWindowExtras(value) { windowExtras = value; },
    setPermission(value) { permissionGranted = value; },
    setStageBehavior({ready = true, anchor = true} = {}) { automaticReady = ready; automaticAnchor = anchor; },
    pausePageRead() { pageGate = new Promise(resolve => { releasePage = resolve; }); },
    releasePageRead() { releasePage?.(); pageGate = undefined; },
  };
}

test('the real worker dispatcher registers only public page data and never returns private context or CDN locations', async t => {
  const sdk = await workerBoundary(t);
  const response = await sdk.request('scan', {url: PAGE});
  assert.equal(response.ok, true);
  assert.equal(response.result.files.length, 1);
  const file = response.result.files[0];
  assert.equal(file.delivery, 'browser');
  assert.equal(file.url, 'browser-helper:' + file.helperId);
  const publicResponse = JSON.stringify(response);
  assert.ok(!publicResponse.includes('bilivideo.com'));
  assert.ok(!publicResponse.includes('fixture-private-context'));
  assert.ok(!publicResponse.includes('mediaUrls'));
  const registered = sdk.data[STATE_KEY].registry[file.helperId];
  assert.equal(registered.origin, OWNER.origin); assert.equal(registered.tabId, OWNER.tabId);
  assert.deepEqual(registered.mediaUrls, [CDN, BACKUP]);
});

test('the real page reader accepts a fresh official-player capture when __playinfo__ is absent', async t => {
  const snapshot = pageSnapshot();
  const captured = {requestCid: 101, requestBvid: VIDEO, capturedAt: Date.now(), playinfo: structuredClone(snapshot.playinfo)};
  delete captured.playinfo.data.cid; delete snapshot.playinfo;
  const sdk = await workerBoundary(t); sdk.setSnapshot(snapshot);
  sdk.setWindowExtras({__SHIYIN_BILI_PLAYINFO_V1__: captured});
  const response = await sdk.request('scan', {url: PAGE});
  assert.equal(response.ok, true, response.error?.message);
  assert.equal(response.result.files[0].duration, 600.25);
  assert.equal(response.result.files[0].source, PAGE);
  assert.equal(response.result.files[0].url, 'browser-helper:' + response.result.files[0].helperId);
  assert.ok(!JSON.stringify(response).includes('bilivideo.com'));
});

for (const [label, change] of [
  ['a request CID from another part', c => { c.requestCid = 202; }],
  ['a contradictory response CID', c => { c.playinfo.data.cid = 202; }],
  ['a request BV from another video', c => { c.requestBvid = 'BV1LhqcYwEQD'; }],
  ['a contradictory request aid', c => { c.requestAid = 202; }],
  ['an expired capture', c => { c.capturedAt -= 31 * 60 * 1000; }],
  ['a future-dated capture', c => { c.capturedAt += 60 * 60 * 1000; }],
]) {
  test(`the real page reader refuses ${label} without registering media`, async t => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    const snapshot = pageSnapshot(); snapshot.initialState.videoData.aid = 101;
    const captured = {requestCid: 101, requestBvid: VIDEO, capturedAt: now, playinfo: structuredClone(snapshot.playinfo)};
    delete captured.playinfo.data.cid; delete snapshot.playinfo; change(captured);
    const sdk = await workerBoundary(t);
    sdk.setWindowExtras({__SHIYIN_BILI_PLAYINFO_V1__: captured});
    sdk.setPageReader(() => { now += 20_000; return snapshot; });
    const response = await sdk.request('scan', {url: PAGE});
    assert.equal(response.ok, false); assert.equal(response.error.code, 'NEEDS_USER');
    assert.deepEqual(sdk.data[STATE_KEY].registry, {}); assert.equal(sdk.downloadCalls.length, 0);
  });
}

for (const [label, field] of [['paid', 'is_pay'], ['preview', 'is_preview'], ['DRM', 'drm_tech_type']]) {
  test(`official-player capture fallback preserves ${label} rejection in the real page reader`, async t => {
    const snapshot = pageSnapshot();
    const captured = {requestCid: 101, capturedAt: Date.now(), playinfo: structuredClone(snapshot.playinfo)};
    captured.playinfo.data[field] = 1; delete snapshot.playinfo;
    const sdk = await workerBoundary(t); sdk.setSnapshot(snapshot);
    sdk.setWindowExtras({__SHIYIN_BILI_PLAYINFO_V1__: captured});
    const response = await sdk.request('scan', {url: PAGE});
    assert.equal(response.ok, false); assert.equal(response.error.code, 'RESTRICTED_MEDIA');
    assert.deepEqual(sdk.data[STATE_KEY].registry, {}); assert.equal(sdk.downloadCalls.length, 0);
  });
}

test('the permission event finishes a durable website bind after the initiating popup has closed', async t => {
  const sdk = await workerBoundary(t, {siteOrigin: undefined, sitePattern: undefined});
  sdk.setPermission(false);
  await sdk.popup('prepareBind', {origin: OWNER.origin, tabId: OWNER.tabId, pattern: OWNER.origin + '/*'}, true);
  assert.equal(sdk.data[STATE_KEY].siteOrigin, undefined);
  assert.equal(sdk.data[STATE_KEY].pendingBind.origin, OWNER.origin);
  assert.equal(sdk.bridgeRegistrations.length, 0);
  // The native prompt closes the popup, so no follow-up popupAction:'bind' is
  // sent. Only Chrome's permission event and the saved intent remain.
  sdk.setPermission(true);
  sdk.chrome.permissions.onAdded.emit({origins: [OWNER.origin + '/*']});
  await sdk.settle();
  assert.equal(sdk.data[STATE_KEY].siteOrigin, OWNER.origin);
  assert.equal(sdk.data[STATE_KEY].pendingBind, undefined);
  assert.equal(sdk.bridgeRegistrations.length, 1);
  assert.deepEqual(sdk.bridgeRegistrations[0].matches, [OWNER.origin + '/*']);
  assert.deepEqual(sdk.bridgeInjections, [{target: {tabId: OWNER.tabId}, files: ['bridge.js']}]);
  assert.equal((await sdk.request('ping')).ok, true);
});

test('an expired popup bind intent cannot bind on a later permission event', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const sdk = await workerBoundary(t, {siteOrigin: undefined, sitePattern: undefined});
  sdk.setPermission(false);
  await sdk.popup('prepareBind', {origin: OWNER.origin, tabId: OWNER.tabId, pattern: OWNER.origin + '/*'}, true);
  now += 2 * 60 * 1000 + 1;
  sdk.setPermission(true); sdk.chrome.permissions.onAdded.emit({origins: [OWNER.origin + '/*']});
  await sdk.settle();
  assert.equal(sdk.data[STATE_KEY].siteOrigin, undefined);
  assert.equal(sdk.data[STATE_KEY].pendingBind, undefined);
  assert.equal(sdk.bridgeRegistrations.length, 0); assert.equal(sdk.bridgeInjections.length, 0);
});

test('a popup permission grant cannot bind a tab that has since navigated to another origin', async t => {
  const sdk = await workerBoundary(t, {siteOrigin: undefined, sitePattern: undefined});
  sdk.setPermission(false);
  await sdk.popup('prepareBind', {origin: OWNER.origin, tabId: OWNER.tabId, pattern: OWNER.origin + '/*'}, true);
  sdk.tabs.get(OWNER.tabId).url = 'https://foreign.fixtures.net/';
  sdk.setPermission(true); sdk.chrome.permissions.onAdded.emit({origins: [OWNER.origin + '/*']});
  await sdk.settle();
  assert.equal(sdk.data[STATE_KEY].siteOrigin, undefined);
  assert.equal(sdk.data[STATE_KEY].pendingBind, undefined);
  assert.equal(sdk.bridgeRegistrations.length, 0); assert.equal(sdk.bridgeInjections.length, 0);
});

test('a restarted worker can finish its unexpired popup bind intent without another popup callback', async t => {
  const now = Date.now();
  const pendingBind = {origin: OWNER.origin, tabId: OWNER.tabId, pattern: OWNER.origin + '/*', createdAt: now, expiresAt: now + 120_000};
  const sdk = await workerBoundary(t, {siteOrigin: undefined, sitePattern: undefined, pendingBind});
  assert.equal(sdk.data[STATE_KEY].siteOrigin, OWNER.origin);
  assert.equal(sdk.data[STATE_KEY].pendingBind, undefined);
  assert.equal(sdk.bridgeRegistrations.length, 1); assert.equal(sdk.bridgeInjections.length, 1);
  assert.equal((await sdk.request('ping')).ok, true);
});

test('the worker cannot import a webpage-supplied URL and starts downloads only from its registered media', async t => {
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia()}});
  const injected = await sdk.request('download', {url: 'https://evil.fixtures.net/audio.m4s', source: PAGE});
  assert.equal(injected.ok, false); assert.equal(sdk.downloadCalls.length, 0);
  const accepted = await sdk.request('download', {helperId: 'registered-media', url: 'https://evil.fixtures.net/audio.m4s'});
  assert.equal(accepted.ok, true); assert.equal(sdk.downloadCalls.length, 1);
  assert.ok(sdk.downloadCalls[0].url.startsWith('blob:https://www.bilibili.com/'));
  const start = sdk.stageCommands.find(command => command.action === 'start');
  assert.equal(start.url, CDN); assert.equal(start.source, PAGE);
  assert.equal(start.tabId, sdk.downloadCalls[0].tabId);
  assert.notEqual(start.tabId, OWNER.tabId);
  assert.equal(sdk.chrome.declarativeNetRequest, undefined);
  assert.ok(!JSON.stringify(accepted).includes('bilivideo.com'));
});

test('worker media and job requests reject another tab, origin, frame and forged bridge context', async t => {
  const job = {id: 'owned-job', ...OWNER, kind: 'file', title: '完整音频', createdAt: Date.now(), files: [{...registeredMedia(), state: 'completed', bytes: 500, totalBytes: 500}]};
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia()}, jobs: {'owned-job': job}});
  for (const owner of [{...OWNER, tabId: OWNER.tabId + 1}, {...OWNER, origin: 'https://foreign.fixtures.net'}]) {
    for (const [action, payload] of [['download', {helperId: 'registered-media'}], ['getDownloadStatus', {id: 'owned-job'}]]) {
      const response = await sdk.request(action, payload, owner);
      assert.equal(response.ok, false); assert.equal(response.error.code, 'FORBIDDEN');
    }
  }
  const childFrame = await sdk.request('download', {helperId: 'registered-media'}, OWNER, {frameId: 1});
  assert.equal(childFrame.ok, false); assert.equal(childFrame.error.code, 'FORBIDDEN');
  const forgedBridge = await new Promise(resolve => sdk.chrome.runtime.onMessage.listeners[0]({channel: CHANNEL, direction: 'to-helper', id: 'forged-bridge', action: 'ping', payload: {}, bridgeOrigin: 'https://foreign.fixtures.net'}, {tab: {id: OWNER.tabId}, frameId: 0, url: OWNER.origin + '/'}, resolve));
  assert.equal(forgedBridge.ok, false); assert.equal(forgedBridge.error.code, 'FORBIDDEN');
  const popupForgery = await new Promise(resolve => sdk.chrome.runtime.onMessage.listeners[0]({popupAction: 'disconnect'}, {tab: {id: OWNER.tabId}, frameId: 0, url: OWNER.origin + '/'}, resolve));
  assert.equal(popupForgery.ok, false); assert.equal(popupForgery.error.code, 'FORBIDDEN');
  assert.equal(sdk.data[STATE_KEY].siteOrigin, OWNER.origin); assert.equal(sdk.downloadCalls.length, 0);
});

test('native status uses actual Chrome completion, cleans the private stage and survives website closing', async t => {
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia()}});
  const started = await sdk.request('download', {helperId: 'registered-media'});
  assert.equal(started.ok, true);
  const [item] = sdk.nativeItems.values(); item.bytesReceived = item.totalBytes;
  const ongoing = await sdk.request('getDownloadStatus', {id: started.result.id});
  assert.equal(ongoing.result.state, 'transferring'); assert.equal(ongoing.result.completedFiles, 0);
  sdk.tabs.delete(OWNER.tabId); sdk.chrome.tabs.onRemoved.emit(OWNER.tabId); await sdk.settle();
  assert.equal(sdk.data[STATE_KEY].registry['registered-media'], undefined);
  assert.ok(sdk.data[STATE_KEY].jobs[started.result.id], 'closing the website must retain the native task');
  item.state = 'complete'; item.fileSize = 500; sdk.chrome.downloads.onChanged.emit({id: item.id, state: {current: 'complete'}}); await sdk.settle();
  assert.equal(sdk.data[STATE_KEY].jobs[started.result.id].files[0].state, 'completed');
  assert.equal(sdk.stageRecords.size, 0); assert.equal(sdk.stageCleanups.length, 1); assert.equal(sdk.downloadCalls.length, 1);
});

test('a restarted worker adopts an already-started native download without starting a duplicate', async t => {
  const file = savedStageFile(), job = savedJob(file);
  const sdk = await workerBoundary(t, {jobs: {'recover-job': job}}, [savedNative(file)], [savedStage(file)]);
  const response = await sdk.request('getDownloadStatus', {id: 'recover-job'});
  assert.equal(response.ok, true); assert.equal(response.result.state, 'completed');
  assert.equal(response.result.bytes, 500); assert.equal(response.result.completedFiles, 1);
  assert.equal(sdk.data[STATE_KEY].jobs['recover-job'].files[0].nativeId, 81);
  assert.equal(sdk.downloadCalls.length, 0);
  assert.equal(sdk.stageCommands.filter(command => ['start', 'handoff'].includes(command.action)).length, 0);
  assert.equal(sdk.stageRecords.size, 0); assert.equal(sdk.stageCleanups.length, 1);
});

test('worker recovery cannot adopt another Blob or replay an unconfirmed handoff', async t => {
  const file = savedStageFile({handoffAt: Date.now() - 20_000}), job = savedJob(file, 'uncertain-job');
  const foreign = savedNative(file, {id: 82, url: file.blobUrl + '-other'});
  const tooOld = savedNative(file, {id: 83, startTime: new Date(file.handoffAt - 10_000).toISOString()});
  const sdk = await workerBoundary(t, {jobs: {'uncertain-job': job}}, [foreign, tooOld], [savedStage(file)]);
  const response = await sdk.request('getDownloadStatus', {id: 'uncertain-job'});
  assert.equal(response.ok, true); assert.equal(response.result.state, 'failed');
  assert.equal(response.result.completedFiles, 0);
  assert.match(response.result.error, /未确认保存记录/);
  assert.equal(sdk.downloadCalls.length, 0);
  assert.equal(sdk.stageCommands.filter(command => ['start', 'handoff'].includes(command.action)).length, 0);
  assert.equal(sdk.stageRecords.size, 0);
});

test('a surviving native save retains its private stage until actual completion without another anchor', async t => {
  const file = savedStageFile({nativeId: 83}), job = savedJob(file, 'surviving-job');
  const sdk = await workerBoundary(t, {jobs: {'surviving-job': job}}, [savedNative(file, {id: 83, state: 'in_progress', bytesReceived: 20, fileSize: -1})], [savedStage(file)]);
  const response = await sdk.request('getDownloadStatus', {id: 'surviving-job'});
  assert.equal(response.result.state, 'transferring'); assert.equal(response.result.completedFiles, 0);
  assert.equal(sdk.downloadCalls.length, 0); assert.equal(sdk.stageRecords.size, 1);
  assert.equal(sdk.stageCommands.filter(command => ['start', 'handoff'].includes(command.action)).length, 0);
  const item = sdk.nativeItems.get(83); item.state = 'complete'; item.bytesReceived = item.totalBytes; item.fileSize = item.totalBytes;
  sdk.chrome.downloads.onChanged.emit({id: 83, state: {current: 'complete'}}); await sdk.settle();
  const complete = await sdk.request('getDownloadStatus', {id: 'surviving-job'});
  assert.equal(complete.result.state, 'completed'); assert.equal(sdk.stageRecords.size, 0);
  assert.equal(sdk.stageCleanups.length, 1); assert.equal(sdk.downloadCalls.length, 0);
});

test('user cancellation is terminal and cannot retry a CDN or leave a private save stage', async t => {
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia()}});
  const started = await sdk.request('download', {helperId: 'registered-media'});
  const [item] = sdk.nativeItems.values(); item.state = 'interrupted'; item.error = 'USER_CANCELED'; item.bytesReceived = 10;
  sdk.chrome.downloads.onChanged.emit({id: item.id, state: {current: 'interrupted'}}); await sdk.settle();
  const response = await sdk.request('getDownloadStatus', {id: started.result.id});
  assert.equal(response.result.state, 'failed'); assert.equal(response.result.completedFiles, 0);
  assert.match(response.result.error, /取消/);
  assert.equal(sdk.downloadCalls.length, 1); assert.equal(sdk.stageRecords.size, 0);
  assert.equal(sdk.stageCommands.filter(command => command.action === 'start').length, 1);
  assert.equal(sdk.stageCleanups.length, 1);
});

test('complete native status requires the exact Blob and all three actual byte counts', () => {
  const file = savedStageFile(), item = savedNative(file);
  assert.equal(isCompleteNativeFile(file, item), true);
  for (const change of [
    {state: 'in_progress'}, {url: file.blobUrl + '-foreign'},
    {bytesReceived: 499}, {totalBytes: 499}, {fileSize: 499}, {fileSize: -1},
  ]) assert.equal(isCompleteNativeFile(file, {...item, ...change}), false, JSON.stringify(change));
  for (const expectedBytes of [undefined, 0, -1, NaN, 500.5]) {
    assert.equal(isCompleteNativeFile({...file, expectedBytes}, item), false);
  }
});

test('a Chrome complete event with a mismatched file size fails and cleans the prepared Blob', async t => {
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia()}});
  const started = await sdk.request('download', {helperId: 'registered-media'});
  const [item] = sdk.nativeItems.values(); item.state = 'complete'; item.bytesReceived = item.totalBytes; item.fileSize = item.totalBytes - 1;
  sdk.chrome.downloads.onChanged.emit({id: item.id, state: {current: 'complete'}}); await sdk.settle();
  const result = await sdk.request('getDownloadStatus', {id: started.result.id});
  assert.equal(result.result.state, 'failed'); assert.equal(result.result.completedFiles, 0);
  assert.match(result.result.error, /实际保存大小/); assert.equal(sdk.stageRecords.size, 0);
  assert.equal(sdk.stageCleanups.length, 1); assert.equal(sdk.downloadCalls.length, 1);
});

test('network preparation reports cumulative bytes but cannot complete before a native save exists', async t => {
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia()}});
  sdk.setStageBehavior({ready: false});
  const started = await sdk.request('download', {helperId: 'registered-media'});
  const [stage] = sdk.stageRecords.values(); assert.ok(stage);
  stage.bytes = 150;
  const preparing = await sdk.request('getDownloadStatus', {id: started.result.id});
  assert.equal(preparing.result.state, 'transferring'); assert.equal(preparing.result.bytes, 150);
  assert.equal(preparing.result.totalBytes, 500); assert.equal(preparing.result.completedFiles, 0);
  assert.equal(sdk.downloadCalls.length, 0);
  stage.bytes = 500; stage.state = 'ready';
  const handed = await sdk.request('getDownloadStatus', {id: started.result.id});
  assert.equal(handed.result.state, 'transferring'); assert.equal(handed.result.bytes, 500); assert.equal(handed.result.completedFiles, 0);
  const [native] = sdk.nativeItems.values(); native.bytesReceived = 12;
  const saving = await sdk.request('getDownloadStatus', {id: started.result.id});
  assert.equal(saving.result.bytes, 500, 'network preparation progress must not restart at zero during local saving');
  assert.equal(sdk.stageCommands.filter(command => command.action === 'start').length, 1);
  assert.equal(sdk.stageCommands.filter(command => command.action === 'handoff').length, 1);
});

test('a missing acknowledgment after handoff never triggers another anchor on repeated status polling', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia()}});
  sdk.setStageBehavior({anchor: false});
  const started = await sdk.request('download', {helperId: 'registered-media'});
  for (let poll = 0; poll < 5; poll++) {
    const response = await sdk.request('getDownloadStatus', {id: started.result.id});
    assert.equal(response.result.state, 'transferring'); assert.equal(response.result.completedFiles, 0);
  }
  assert.equal(sdk.stageCommands.filter(command => command.action === 'start').length, 1);
  assert.equal(sdk.stageCommands.filter(command => command.action === 'handoff').length, 1);
  now += 16_000;
  const response = await sdk.request('getDownloadStatus', {id: started.result.id});
  assert.equal(response.result.state, 'failed'); assert.match(response.result.error, /未重复触发/);
  assert.equal(sdk.downloadCalls.length, 0); assert.equal(sdk.stageRecords.size, 0);
});

test('a restarted worker with a durable start flag and missing stage fails without replaying the network', async t => {
  const file = savedStageFile({stagePhase: 'loading', bytes: 0}); delete file.blobUrl; delete file.handoffAt;
  const job = savedJob(file);
  const sdk = await workerBoundary(t, {jobs: {[job.id]: job}});
  sdk.tabs.set(file.stageTabId, {id: file.stageTabId, url: PAGE, status: 'complete'});
  const result = await sdk.request('getDownloadStatus', {id: job.id});
  assert.equal(result.result.state, 'failed'); assert.equal(result.result.completedFiles, 0);
  assert.equal(sdk.stageCommands.filter(command => ['start', 'handoff'].includes(command.action)).length, 0);
  assert.equal(sdk.downloadCalls.length, 0);
});

test('an HTTP stage failure retries only the registered next CDN after cleaning its original private tab', async t => {
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia()}});
  sdk.setStageBehavior({ready: false});
  const started = await sdk.request('download', {helperId: 'registered-media'});
  const [first] = sdk.stageRecords.values(); first.state = 'failed'; first.errorCode = 'HTTP_ERROR';
  await sdk.request('getDownloadStatus', {id: started.result.id}); await sdk.settle();
  const starts = sdk.stageCommands.filter(command => command.action === 'start');
  assert.deepEqual(starts.map(command => command.url), [CDN, BACKUP]);
  assert.notEqual(starts[0].tabId, starts[1].tabId); assert.equal(sdk.tabs.has(starts[0].tabId), false);
  assert.deepEqual(sdk.stageCleanups.map(command => command.token), [starts[0].token]);
  const [second] = sdk.stageRecords.values(); assert.equal(second.tabId, starts[1].tabId);
  second.bytes = 500; second.state = 'ready';
  const response = await sdk.request('getDownloadStatus', {id: started.result.id});
  assert.equal(response.result.state, 'transferring'); assert.equal(sdk.downloadCalls.length, 1);
  assert.equal(sdk.downloadCalls[0].tabId, second.tabId);
});

test('closing one owned save tab cancels only its native file and leaves another website owner save running', async t => {
  const other = {...OWNER, tabId: OWNER.tabId + 1};
  const sdk = await workerBoundary(t, {registry: {
    'registered-media': registeredMedia(), 'other-media': registeredMedia('other-media', other),
  }});
  const first = await sdk.request('download', {helperId: 'registered-media'});
  const second = await sdk.request('download', {helperId: 'other-media'}, other);
  const firstFile = sdk.data[STATE_KEY].jobs[first.result.id].files[0], secondFile = sdk.data[STATE_KEY].jobs[second.result.id].files[0];
  assert.notEqual(firstFile.stageTabId, secondFile.stageTabId); assert.notEqual(firstFile.nativeId, secondFile.nativeId);
  sdk.tabs.delete(firstFile.stageTabId); sdk.chrome.tabs.onRemoved.emit(firstFile.stageTabId); await sdk.settle();
  const canceled = await sdk.request('getDownloadStatus', {id: first.result.id});
  const running = await sdk.request('getDownloadStatus', {id: second.result.id}, other);
  assert.equal(canceled.result.state, 'failed'); assert.match(canceled.result.error, /保存页面已关闭/);
  assert.equal(running.result.state, 'transferring'); assert.equal(running.result.completedFiles, 0);
  assert.deepEqual(sdk.nativeCancels, [firstFile.nativeId]); assert.equal(sdk.tabs.has(secondFile.stageTabId), true);
  assert.equal(sdk.nativeItems.get(secondFile.nativeId).state, 'in_progress');
  assert.ok(sdk.data[STATE_KEY].cleanup[firstFile.stageToken], 'closed-page OPFS cleanup must remain queued by its exact private token');
  assert.equal(sdk.downloadCalls.length, 2);
});

test('active duplicate tasks and expired registered URLs fail before another native download starts', async t => {
  const expired = {...registeredMedia('expired-media'), expiresAt: Date.now() - 1};
  const sdk = await workerBoundary(t, {registry: {'registered-media': registeredMedia(), 'expired-media': expired}});
  const first = await sdk.request('download', {helperId: 'registered-media'});
  assert.equal(first.ok, true);
  const duplicate = await sdk.request('download', {helperId: 'registered-media'});
  assert.equal(duplicate.ok, false); assert.equal(duplicate.error.code, 'BUSY');
  const expiredResponse = await sdk.request('download', {helperId: 'expired-media'});
  assert.equal(expiredResponse.ok, false); assert.equal(expiredResponse.error.code, 'EXPIRED');
  assert.equal(sdk.downloadCalls.length, 1);
});

test('concurrent worker requests enforce the three-active-job boundary before starting native downloads', async t => {
  const registry = Object.fromEntries([1, 2, 3, 4].map(part => {
    const id = 'registered-part-' + part;
    return [id, {...registeredMedia(id), source: PAGE + '?p=' + part, title: 'P' + part, filename: 'P' + part + '.m4a'}];
  }));
  const sdk = await workerBoundary(t, {registry});
  const responses = await Promise.all(Object.keys(registry).map(helperId => sdk.request('download', {helperId})));
  assert.equal(responses.filter(response => response.ok).length, 3);
  assert.equal(responses.filter(response => !response.ok && response.error.code === 'BUSY').length, 1);
  assert.equal(sdk.downloadCalls.length, 3);
});

test('worker recovery preserves an interrupted verification page instead of navigating or replaying its scan', async t => {
  const activeScan = {owner: OWNER, requestId: 'old-scan', url: PAGE, requestedUrl: PAGE, at: Date.now()};
  const sdk = await workerBoundary(t, {activeScan});
  assert.equal(sdk.data[STATE_KEY].activeScan, undefined);
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId].requestId, 'old-scan');
  assert.deepEqual(sdk.navigation, []);
  const canceled = await sdk.request('cancelScan', {requestId: 'old-scan'});
  assert.equal(canceled.result.canceled, true);
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId], undefined);
});

test('a different website tab cannot navigate away from another owner paused verification page', async t => {
  const other = {...OWNER, tabId: OWNER.tabId + 1};
  const paused = {owner: other, requestId: 'other-paused-scan', url: PAGE, requestedUrl: PAGE, at: Date.now()};
  const sdk = await workerBoundary(t, {paused: {[other.origin + '|' + other.tabId]: paused}});
  const response = await sdk.request('scan', {url: PAGE});
  assert.equal(response.ok, false); assert.equal(response.error.code, 'BUSY');
  assert.deepEqual(sdk.navigation, []);
  const cancellation = await sdk.request('cancelScan', {requestId: paused.requestId});
  assert.equal(cancellation.result.canceled, false);
  assert.ok(sdk.data[STATE_KEY].paused[other.origin + '|' + other.tabId]);
});

test('website reload clears its stale scan pause while preserving the player tab and native download', async t => {
  const paused = {owner: OWNER, requestId: 'scan-before-reload', url: PAGE, requestedUrl: PAGE, at: Date.now()};
  const sdk = await workerBoundary(t, {biliTabId: 202, registry: {'registered-media': registeredMedia()}, paused: {[OWNER.origin + '|' + OWNER.tabId]: paused}});
  sdk.tabs.set(202, {id: 202, url: PAGE, active: true});
  const download = await sdk.request('download', {helperId: 'registered-media'});
  const [native] = sdk.nativeItems.values(); native.bytesReceived = 12;
  sdk.chrome.tabs.onUpdated.emit(OWNER.tabId, {status: 'loading'}, sdk.tabs.get(OWNER.tabId));
  await sdk.settle();
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId], undefined);
  assert.equal(sdk.tabs.get(202).url, PAGE); assert.equal(sdk.data[STATE_KEY].biliTabId, 202);
  const status = await sdk.request('getDownloadStatus', {id: download.result.id});
  assert.equal(status.result.state, 'transferring'); assert.equal(status.result.completedFiles, 0);
  assert.equal(sdk.downloadCalls.length, 1); assert.equal(sdk.nativeItems.get(native.id).state, 'in_progress');
});

test('a new top-level document retires its old pause without stopping an existing native download', async t => {
  const oldOwner = {...OWNER, documentId: 'document-before-reload'};
  const paused = {owner: oldOwner, requestId: 'scan-before-reload', url: PAGE, requestedUrl: PAGE, at: Date.now()};
  const sdk = await workerBoundary(t, {biliTabId: 202, registry: {'registered-media': registeredMedia()}, paused: {[OWNER.origin + '|' + OWNER.tabId]: paused}});
  sdk.tabs.set(202, {id: 202, url: PAGE, active: true});
  const download = await sdk.request('download', {helperId: 'registered-media'}, OWNER, {documentId: oldOwner.documentId});
  const [native] = sdk.nativeItems.values(); native.bytesReceived = 20;
  const newDocument = {documentId: 'document-after-reload'};
  assert.equal((await sdk.request('ping', {}, OWNER, newDocument)).ok, true);
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId], undefined);
  const status = await sdk.request('getDownloadStatus', {id: download.result.id}, OWNER, newDocument);
  assert.equal(status.result.state, 'transferring'); assert.equal(status.result.completedFiles, 0);
  assert.equal(sdk.tabs.get(202).url, PAGE); assert.equal(sdk.downloadCalls.length, 1);
});

test('iframe loading in the same top-level document preserves its manual-verification pause', async t => {
  const owner = {...OWNER, documentId: 'unchanged-top-level-document'};
  const paused = {owner, requestId: 'scan-awaiting-user', url: PAGE, requestedUrl: PAGE, at: Date.now()};
  const sdk = await workerBoundary(t, {biliTabId: 202, paused: {[OWNER.origin + '|' + OWNER.tabId]: paused}});
  sdk.tabs.set(202, {id: 202, url: PAGE, active: true});
  sdk.chrome.tabs.onUpdated.emit(OWNER.tabId, {status: 'loading'}, sdk.tabs.get(OWNER.tabId));
  await sdk.settle();
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId].requestId, paused.requestId);
  const ping = await sdk.request('ping', {}, OWNER, {documentId: owner.documentId});
  assert.equal(ping.ok, true);
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId].requestId, paused.requestId);
  assert.equal(sdk.tabs.get(202).url, PAGE); assert.deepEqual(sdk.navigation, []);
});

test('retrying the paused video reads the preserved verification tab without navigating it', async t => {
  const paused = {owner: OWNER, requestId: 'original-paused-scan', url: PAGE, requestedUrl: PAGE, at: Date.now()};
  const sdk = await workerBoundary(t, {biliTabId: 202, paused: {[OWNER.origin + '|' + OWNER.tabId]: paused}});
  sdk.tabs.set(202, {id: 202, url: PAGE, active: true});
  const response = await sdk.request('scan', {url: PAGE});
  assert.equal(response.ok, true); assert.equal(response.result.files.length, 1);
  assert.deepEqual(sdk.navigation, []);
  assert.equal(sdk.data[STATE_KEY].biliTabId, 202);
  assert.equal(sdk.tabs.get(202).active, true);
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId], undefined);
});

test('reset cancels only its exact paused request and leaves the official verification tab open', async t => {
  const paused = {owner: OWNER, requestId: 'original-paused-scan', url: PAGE, requestedUrl: PAGE, at: Date.now()};
  const sdk = await workerBoundary(t, {biliTabId: 202, paused: {[OWNER.origin + '|' + OWNER.tabId]: paused}});
  sdk.tabs.set(202, {id: 202, url: PAGE, active: true});
  const unrelated = await sdk.request('cancelScan', {requestId: 'newly-rejected-scan'});
  assert.equal(unrelated.result.canceled, false);
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId].requestId, paused.requestId);
  const canceled = await sdk.request('cancelScan', {requestId: paused.requestId});
  assert.equal(canceled.result.canceled, true);
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId], undefined);
  assert.equal(sdk.tabs.get(202).url, PAGE); assert.equal(sdk.tabs.get(202).active, true);
  assert.deepEqual(sdk.navigation, []); assert.equal(sdk.downloadCalls.length, 0);
});

test('multipart resume keeps the verified P1 ID and reads only the manually played remaining P2', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const sdk = await workerBoundary(t);
  // A navigation invalidates the previous playback session. No simulated click
  // occurs: this fixture grants globals only after the user-play step below.
  const playedAt = new Map([[1, 1]]);
  sdk.setPageReader(url => {
    const part = parseBilibiliUrl(url).part || 1;
    if (playedAt.get(part) !== sdk.navigation.length) {
      now += 20_000; // Advance the real dispatcher's availability deadline.
      return {location: {href: url}};
    }
    return multipartSnapshot(part, url);
  });
  const first = await sdk.request('scan', {url: PAGE});
  assert.equal(first.ok, false); assert.equal(first.error.code, 'NEEDS_USER');
  const verifiedP1 = Object.values(sdk.data[STATE_KEY].registry).find(record => record.source === PAGE + '?p=1');
  assert.ok(verifiedP1, 'the completed P1 must remain registered while P2 waits for the user');
  assert.deepEqual(sdk.navigation, [PAGE, PAGE + '?p=2']);
  playedAt.set(2, sdk.navigation.length);
  const resumed = await sdk.request('scan', {url: PAGE});
  assert.equal(resumed.ok, true, resumed.error?.message);
  assert.equal(resumed.result.files.length, 2);
  assert.equal(resumed.result.files.find(file => file.source === PAGE + '?p=1').helperId, verifiedP1.id);
  assert.deepEqual(resumed.result.files.map(file => file.source), [PAGE + '?p=1', PAGE + '?p=2']);
  assert.deepEqual(sdk.navigation, [PAGE, PAGE + '?p=2']);
  assert.equal(sdk.pageReads.filter(url => url === PAGE).length, 1);
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId], undefined);
});

test('multipart resume rechecks expired P1 once and keeps fresh P2 through the next manual-play pause', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const sdk = await workerBoundary(t), playedAt = new Map([[1, 1]]);
  sdk.setPageReader(url => {
    const part = parseBilibiliUrl(url).part || 1;
    if (playedAt.get(part) !== sdk.navigation.length) {
      now += 20_000;
      return {location: {href: url}};
    }
    return multipartSnapshot(part, url);
  });
  const first = await sdk.request('scan', {url: PAGE});
  assert.equal(first.ok, false); assert.equal(first.error.code, 'NEEDS_USER');
  const oldP1 = Object.values(sdk.data[STATE_KEY].registry).find(record => record.source === PAGE + '?p=1');
  assert.ok(oldP1);
  now += 31 * 60 * 1000;
  playedAt.set(2, sdk.navigation.length);
  const expiredResume = await sdk.request('scan', {url: PAGE});
  assert.equal(expiredResume.ok, false); assert.equal(expiredResume.error.code, 'NEEDS_USER');
  assert.equal(sdk.navigation.at(-1), PAGE + '?p=1', 'expired P1 must be read again rather than returned from the old registry');
  const freshP2 = Object.values(sdk.data[STATE_KEY].registry).find(record => record.source === PAGE + '?p=2');
  assert.ok(freshP2); assert.ok(freshP2.expiresAt > now);
  const navigationsBeforeUser = sdk.navigation.length;
  playedAt.set(1, navigationsBeforeUser);
  const complete = await sdk.request('scan', {url: PAGE});
  assert.equal(complete.ok, true, complete.error?.message);
  assert.equal(complete.result.files.length, 2);
  assert.notEqual(complete.result.files.find(file => file.source === PAGE + '?p=1').helperId, oldP1.id);
  assert.equal(complete.result.files.find(file => file.source === PAGE + '?p=2').helperId, freshP2.id);
  assert.equal(sdk.navigation.length, navigationsBeforeUser, 'fresh P2 must not be navigated away and replayed');
  assert.equal(sdk.data[STATE_KEY].paused[OWNER.origin + '|' + OWNER.tabId], undefined);
});

test('an active scan can be canceled only by its own originating website tab', async t => {
  const sdk = await workerBoundary(t); sdk.pausePageRead();
  const scanning = sdk.request('scan', {url: PAGE});
  try {
    await sdk.settle();
    const id = sdk.data[STATE_KEY].activeScan.requestId;
    const foreign = await sdk.request('cancelScan', {requestId: id}, {...OWNER, tabId: OWNER.tabId + 1});
    assert.equal(foreign.ok, false); assert.equal(foreign.error.code, 'FORBIDDEN');
    const canceled = await sdk.request('cancelScan', {requestId: id});
    assert.equal(canceled.ok, true); assert.equal(canceled.result.canceled, true);
  } finally { sdk.releasePageRead(); }
  const response = await scanning;
  assert.equal(response.ok, false); assert.equal(response.error.code, 'CANCELED');
  assert.equal(sdk.data[STATE_KEY].activeScan, undefined);
  assert.deepEqual(sdk.data[STATE_KEY].registry, {});
  assert.equal(sdk.downloadCalls.length, 0);
});
