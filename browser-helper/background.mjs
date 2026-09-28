import {CHANNEL, VERSION, HelperError, TERMINAL_STATES, cleanText, validateSiteOrigin, parseBilibiliUrl, validateEnvelope, assertOwner, parsePageAudio, validateMediaUrl, mediaExpiry, snapshotDownloads, isCompleteNativeFile} from './core.mjs';

const KEY = 'shiyin.helper.state.v1';
const BRIDGE_ID = 'shiyin-bound-site';
const REGISTRY_LIMIT = 1000;
const JOB_LIMIT = 200;
const MAX_FILE_BYTES = 3 * 1024 * 1024 * 1024;
const STAGE_TIMEOUT = 2 * 60 * 60 * 1000;
const jobsDriving = new Set();
const jobsNeedingDrive = new Set();
let state;
let scanRuntime;
let serial = Promise.resolve();
let storageSerial = Promise.resolve();
function locked(fn) {
  const next = serial.then(fn, fn);
  serial = next.catch(() => {});
  return next;
}
function persist() {
  const write = storageSerial.then(() => chrome.storage.local.set({[KEY]: state}));
  storageSerial = write.catch(() => {});
  return write;
}
const ownerKey = owner => `${owner.origin}|${owner.tabId}`;
function failure(error) {
  // Chrome errors can contain a signed URL; never relay URLs to the webpage.
  const code = error instanceof HelperError ? error.code : 'HELPER_ERROR';
  const message = error instanceof HelperError ? cleanText(error.message, 240) : '浏览器助手处理失败，请查看浏览器下载列表或重新扫描';
  return {code, message};
}
const ready = (async () => {
  await chrome.storage.local.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
  const saved = (await chrome.storage.local.get(KEY))[KEY];
  state = saved && typeof saved === 'object' ? saved : {};
  state.registry ||= {}; state.jobs ||= {}; state.paused ||= {};
  state.cleanup ||= {};
  delete state.ruleCounter;
  // A long scan is not replayed after a worker restart: retain its page and require
  // user retry, rather than silently navigating away from a verification screen.
  if (state.activeScan) {
    const old = state.activeScan;
    state.paused[ownerKey(old.owner)] = {...old, reason: '扫描连接中断，请在保留的 B 站页面正常播放，然后重试'};
    delete state.activeScan;
  }
  await persist();
  await chrome.alarms.create('shiyin-maintenance', {periodInMinutes: 1});
  return state;
})();

function readPageGlobals() {
  // Runs only in an official Bilibili MAIN world. Return a whitelist, never the
  // full page state, user profile, Cookie, request headers or authentication data.
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) || value === null;
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value && scalar(value[key])).map(key => [key, value[key]]));
  let budget = 1500;
  const flags = (value, depth = 0) => {
    if (!object(value) && !Array.isArray(value) || depth > 6 || budget-- <= 0) return {};
    const found = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (/^(is_?drm|drm|drm_?tech_?type|drm_?type|drm_?key|widevine|is_?preview|is_?trial|is_?pay|is_?paid|need_?pay|need_?login|is_?vip|vip_?only|is_?sample|preview|trial|pay|arc_pay|ugc_pay|ugc_pay_preview)$/i.test(key) && scalar(item)) found[key] = item;
      else if (typeof item === 'object' && item) { const nested = flags(item, depth + 1); if (Object.keys(nested).length) found[key] = nested; }
    }
    return found;
  };
  try {
    const initial = window.__INITIAL_STATE__;
    const video = initial?.videoData;
    let play = window.__playinfo__;
    if (!object(play) && object(initial) && object(video)) {
      const captured = window.__SHIYIN_BILI_PLAYINFO_V1__;
      const currentPart = Number(new URL(location.href).searchParams.get('p') || 1);
      const currentCid = Number(initial.cid ?? (currentPart === 1 ? video.cid : undefined));
      const requestCid = Number(captured?.requestCid);
      const age = Date.now() - Number(captured?.capturedAt);
      // This is a passive copy of the normal player's own successful response,
      // captured at document_start. The extension never repeats that request.
      if (object(captured) && object(captured.playinfo) && object(captured.playinfo.data)
          && Number.isSafeInteger(requestCid) && requestCid > 0 && requestCid === currentCid
          && Number.isFinite(age) && age >= -5000 && age <= 30 * 60 * 1000
          && (!captured.requestBvid || captured.requestBvid === video.bvid)
          && (!captured.requestAid || Number(captured.requestAid) === Number(video.aid))
          && (captured.playinfo.data.cid === undefined || Number(captured.playinfo.data.cid) === requestCid)) {
        play = {...captured.playinfo, data: {...captured.playinfo.data, cid: requestCid}};
      }
    }
    if (!object(initial) || !object(video) || !object(play)) return {location: {href: location.href}};
    const data = play.data;
    const audio = Array.isArray(data?.dash?.audio) ? data.dash.audio.slice(0, 30).map(track => ({...pick(track, ['id', 'codecs', 'mimeType', 'mime_type', 'bandwidth', 'baseUrl', 'base_url']), ...flags(track), backupUrl: (Array.isArray(track.backupUrl || track.backup_url) ? track.backupUrl || track.backup_url : []).filter(value => typeof value === 'string').slice(0, 10)})) : [];
    return {
      location: {href: location.href},
      initialState: {...pick(initial, ['bvid', 'cid', 'p']), videoData: {...pick(video, ['bvid', 'cid', 'title', 'state', 'is_pay', 'is_paid']), ...flags(video), rights: pick(video.rights, Object.keys(video.rights || {}).slice(0, 100)), pages: (Array.isArray(video.pages) ? video.pages : []).slice(0, 10000).map(part => pick(part, ['cid', 'page', 'part', 'duration']))}},
      playinfo: {...pick(play, ['code', 'message']), data: object(data) ? {...pick(data, ['cid', 'timelength']), permissionFlags: flags({...data, support_formats: undefined, dash: object(data.dash) ? {...data.dash, audio: undefined} : undefined}), dash: {...pick(data.dash, ['duration']), audio}} : undefined}
    };
  } catch { return {location: {href: location.href}}; }
}

async function progress(owner, requestId, message) {
  await chrome.tabs.sendMessage(owner.tabId, {channel: CHANNEL, direction: 'to-page', event: 'scan-progress', requestId, message: cleanText(message, 240)}).catch(() => {});
}
async function getBiliTab(url, preserve = false) {
  let tab;
  if (state.biliTabId) { try {tab = await chrome.tabs.get(state.biliTabId);} catch {} }
  if (!tab) {tab = await chrome.tabs.create({url, active: true}); state.biliTabId = tab.id; await persist();}
  else if (!preserve) await chrome.tabs.update(tab.id, {url, active: false});
  return tab.id;
}
function checkScan(runtime) {
  if (runtime.canceled || scanRuntime !== runtime) throw new HelperError('CANCELED', '扫描已取消，保留的 B 站页面可继续正常使用');
  if (state.siteOrigin !== runtime.owner.origin) throw new HelperError('CANCELED', '网页连接已改变，扫描已停止');
}
function scanRecord(runtime) {
  return {owner: runtime.owner, requestId: runtime.requestId, url: runtime.currentUrl, requestedUrl: runtime.requestedUrl, at: Date.now(), confirmedIds: [...runtime.confirmedIds], parts: runtime.parts.map(part => ({...part})), title: runtime.title, warnings: [...runtime.warnings]};
}
async function saveScanProgress(runtime) {
  checkScan(runtime);
  state.activeScan = scanRecord(runtime);
  await persist();
}
function addScanWarning(runtime, message) {
  const text = cleanText(message, 1000);
  if (text && runtime.warnings.length < 100 && !runtime.warnings.includes(text)) runtime.warnings.push(text);
}
async function collectPage(runtime, url, preserve) {
  checkScan(runtime);
  const tabId = await getBiliTab(url, preserve);
  runtime.currentUrl = url;
  await saveScanProgress(runtime);
  const deadline = Date.now() + 18000;
  let last = new HelperError('NEEDS_USER', '页面未提供播放资料，请正常完成登录或验证并点击播放，然后回拾音重试');
  while (Date.now() < deadline) {
    checkScan(runtime);
    try {
      const results = await chrome.scripting.executeScript({target: {tabId}, world: 'MAIN', func: readPageGlobals});
      checkScan(runtime);
      return parsePageAudio(results[0]?.result, url);
    } catch (error) {
      if (error instanceof HelperError && !['NEEDS_USER', 'PAGE_MISMATCH'].includes(error.code)) throw error;
      if (error instanceof HelperError) last = error;
      // No API request, signature generation, challenge interaction or click.
      await new Promise(resolve => setTimeout(resolve, 650));
    }
  }
  await chrome.tabs.update(tabId, {active: true}).catch(() => {});
  throw new HelperError('NEEDS_USER', last.code === 'PAGE_MISMATCH' ? '播放资料尚未对应指定分 P，请在保留页面播放对应分 P，然后回拾音重试' : last.message);
}
function cleanRegistry() {
  const now = Date.now();
  for (const [id, entry] of Object.entries(state.registry)) if (entry.expiresAt <= now) delete state.registry[id];
}
function browserAudioFile(audio) {
  return {url: 'browser-helper:' + audio.id, delivery: 'browser', helperId: audio.id, source: audio.source, title: audio.title, filename: audio.filename, format: 'm4a', codec: 'aac', duration: audio.duration, size: 0, mode: 'direct', sourceFormat: '独立音轨'};
}
function restoreConfirmed(runtime, parts, bvid) {
  const restored = [];
  const now = Date.now();
  for (const id of runtime.confirmedIds.slice(0, 100)) {
    const entry = state.registry[id];
    if (!entry || entry.origin !== runtime.owner.origin || entry.tabId !== runtime.owner.tabId || entry.expiresAt <= now + 10000 || entry.format !== 'm4a' || entry.codec !== 'aac') continue;
    try {
      const source = parseBilibiliUrl(entry.source);
      const part = parts.find(item => item.page === entry.page);
      if (source.bvid !== bvid || (source.part || 1) !== entry.page || !part || entry.cid !== part.cid || Math.abs(entry.duration - part.duration) > 2 || !Array.isArray(entry.mediaUrls) || !entry.mediaUrls.length || entry.mediaUrls.some(url => mediaExpiry(validateMediaUrl(url), now) <= now + 10000)) continue;
      restored.push(browserAudioFile(entry));
    } catch { /* A changed/expired record is scanned again through the official page. */ }
  }
  return restored;
}
async function registerAudio(owner, audio) {
  cleanRegistry();
  const now = Date.now();
  const urls = audio.mediaUrls.filter(url => mediaExpiry(url, now) > now + 10000);
  if (!urls.length) throw new HelperError('EXPIRED', '页面音轨地址已过期，请刷新 B 站页面并正常播放后重试');
  const prior = Object.values(state.registry).find(item => item.origin === owner.origin && item.tabId === owner.tabId && item.source === audio.source);
  if (!prior && Object.keys(state.registry).length >= REGISTRY_LIMIT) throw new HelperError('BUSY', '浏览器音频记录已满，请稍后重新扫描');
  const id = prior?.id || crypto.randomUUID();
  const expiresAt = Math.min(now + 30 * 60 * 1000, ...urls.map(url => mediaExpiry(url, now)));
  state.registry[id] = {...audio, mediaUrls: urls, id, ...owner, createdAt: now, expiresAt};
  await persist();
  return browserAudioFile(state.registry[id]);
}
async function scan(owner, requestId, payload) {
  const requested = parseBilibiliUrl(payload.url);
  if (scanRuntime) throw new HelperError('BUSY', '浏览器正在顺序扫描其他视频，请等待或取消当前扫描');
  if (Object.entries(state.paused).some(([key]) => key !== ownerKey(owner))) throw new HelperError('BUSY', '另一个拾音窗口的 B 站页面正在等待正常播放或验证，请在原窗口完成或取消扫描后重试');
  const paused = state.paused[ownerKey(owner)];
  if (paused) {
    const blocked = parseBilibiliUrl(paused.url);
    if (blocked.bvid !== requested.bvid || requested.part && requested.part !== (blocked.part || 1)) throw new HelperError('NEEDS_USER', '上一条视频需要正常播放或验证。请回到保留的 B 站页面完成后重试该视频，或取消原扫描再扫描其他链接');
  }
  const runtime = {owner, requestId, requestedUrl: requested.canonical, currentUrl: paused?.url || requested.canonical, canceled: false, confirmedIds: Array.isArray(paused?.confirmedIds) ? paused.confirmedIds.filter(id => typeof id === 'string').slice(0, 100) : [], parts: Array.isArray(paused?.parts) ? paused.parts.slice(0, 100) : [], title: cleanText(paused?.title), warnings: Array.isArray(paused?.warnings) ? paused.warnings.filter(item => typeof item === 'string').slice(0, 100) : []};
  scanRuntime = runtime;
  const files = [], warnings = runtime.warnings;
  let retainPause = false;
  try {
    await progress(owner, requestId, '正在自己的浏览器打开 B 站页面并读取完整音轨');
    const firstUrl = paused?.url || requested.canonical;
    const first = await collectPage(runtime, firstUrl, !!paused);
    delete state.paused[ownerKey(owner)];
    const selectedParts = requested.part ? first.parts.filter(part => part.page === requested.part) : first.parts.slice(0, 100);
    runtime.parts = selectedParts;
    runtime.title = first.title;
    files.push(...restoreConfirmed(runtime, selectedParts, requested.bvid));
    const fresh = await registerAudio(owner, first.files[0]);
    const oldIndex = files.findIndex(file => file.helperId === fresh.helperId);
    if (oldIndex === -1) files.push(fresh); else files[oldIndex] = fresh;
    runtime.confirmedIds = files.map(file => file.helperId);
    await saveScanProgress(runtime);
    const firstPage = first.files[0].page;
    const confirmedPages = new Set(files.map(file => parseBilibiliUrl(file.source).part || 1));
    const parts = selectedParts.filter(part => part.page !== firstPage && !confirmedPages.has(part.page));
    const scanUntil = Date.now() + 210000;
    for (const part of parts) {
      checkScan(runtime);
      if (Date.now() > scanUntil) {addScanWarning(runtime, '本次浏览器扫描已达到时间上限；其余分 P 请使用 ?p=编号 链接继续扫描'); break;}
      await progress(owner, requestId, `正在扫描 P${part.page} · ${files.length + 1}/${Math.min(first.parts.length, 100)}`);
      const pageUrl = `https://www.bilibili.com/video/${requested.bvid}/?p=${part.page}`;
      try {
        const found = await collectPage(runtime, pageUrl, false);
        files.push(await registerAudio(owner, found.files[0]));
        runtime.confirmedIds = files.map(file => file.helperId);
        await saveScanProgress(runtime);
      }
      catch (error) {
        if (error instanceof HelperError && ['NEEDS_USER', 'CANCELED', 'PAGE_MISMATCH'].includes(error.code)) throw error;
        addScanWarning(runtime, `P${part.page}：${failure(error).message}`);
      }
    }
    if (first.parts.length > 100 && !requested.part) addScanWarning(runtime, '该视频超过 100 个分 P，本次只扫描前 100 个');
    files.sort((a, b) => (parseBilibiliUrl(a.source).part || 1) - (parseBilibiliUrl(b.source).part || 1));
    return {title: first.title, files, warnings};
  } catch (error) {
    if (error instanceof HelperError && error.code === 'NEEDS_USER') {
      retainPause = true;
      state.paused[ownerKey(owner)] = {...scanRecord(runtime), reason: error.message};
      await progress(owner, requestId, error.message);
    }
    throw error;
  } finally {
    if (scanRuntime === runtime) scanRuntime = undefined;
    if (!retainPause) delete state.paused[ownerKey(owner)];
    delete state.activeScan;
    await persist();
  }
}

function sourceStageCommand(args) {
  return window.__SHIYIN_AUDIO_SAVE_V1__?.command(args) || {token: args.token, state: 'missing', bytes: 0};
}
async function pageCommand(tabId, args, install = false) {
  if (install) await chrome.scripting.executeScript({target: {tabId}, world: 'MAIN', files: ['audio-save-page.js']});
  const result = await chrome.scripting.executeScript({target: {tabId}, world: 'MAIN', func: sourceStageCommand, args: [args]});
  return result[0]?.result;
}
function sameSavePage(url, source) {
  try {const actual = parseBilibiliUrl(url), expected = parseBilibiliUrl(source); return actual.bvid === expected.bvid && (actual.part || 1) === (expected.part || 1);} catch {return false;}
}
function validStageSnapshot(file, value) {
  if (!value || value.token !== file.stageToken || !['loading', 'ready', 'handing_off', 'failed', 'disposed', 'missing'].includes(value.state) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_FILE_BYTES) throw new HelperError('STAGE_MISSING', '保存页面状态无效，请查看浏览器下载列表后重试');
  if (value.expectedBytes !== undefined && (!Number.isSafeInteger(value.expectedBytes) || value.expectedBytes <= 0 || value.expectedBytes > MAX_FILE_BYTES || value.bytes > value.expectedBytes)) throw new HelperError('INCOMPLETE_MEDIA', '音轨完整大小无效，未保存');
  if (['ready', 'handing_off'].includes(value.state)) {
    let blob; try {blob = new URL(value.blobUrl);} catch {throw new HelperError('STAGE_MISSING', '临时音轨地址无效，未保存');}
    if (blob.protocol !== 'blob:' || blob.origin !== 'https://www.bilibili.com' || !(value.expectedBytes > 0) || value.bytes !== value.expectedBytes) throw new HelperError('INCOMPLETE_MEDIA', '临时音轨未完整准备，未保存');
    if (file.blobUrl && file.blobUrl !== value.blobUrl || file.expectedBytes && file.expectedBytes !== value.expectedBytes) throw new HelperError('STAGE_MISSING', '保存页面音轨已改变，未重复下载');
  }
  return value;
}
async function cleanupOnPage(file) {
  const token = file.stageToken;
  if (!token) return;
  let page;
  if (Number.isInteger(file.stageTabId)) {try {page = await chrome.tabs.get(file.stageTabId);} catch {}}
  if (page && sameSavePage(page.url, file.source)) {
    await pageCommand(page.id, {action: 'cleanup', token}, true);
    await chrome.tabs.remove(page.id).catch(() => {});
  } else {
    // The user may have closed the save tab. Delete only this helper's opaque
    // OPFS filename through an already open official page; never replay media.
    let cleaner;
    if (state.biliTabId) {try {const candidate = await chrome.tabs.get(state.biliTabId); if (new URL(candidate.url).origin === 'https://www.bilibili.com') cleaner = candidate;} catch {}}
    if (cleaner) await pageCommand(cleaner.id, {action: 'cleanup', token}, true);
    else {state.cleanup[token] = {source: file.source, createdAt: Date.now()};}
  }
  delete file.stageTabId; delete file.stageToken; delete file.blobUrl; delete file.stagePhase; delete file.handoffAt; delete file.stageStarted; delete file.saveClosing;
}
async function cleanupFile(file) {
  file.saveClosing = true;
  await persist();
  try {await cleanupOnPage(file);} catch {
    if (file.stageToken) state.cleanup[file.stageToken] = {source: file.source, createdAt: Date.now()};
    if (file.stageTabId) await chrome.tabs.remove(file.stageTabId).catch(() => {});
    delete file.stageTabId; delete file.stageToken; delete file.blobUrl; delete file.stagePhase; delete file.handoffAt; delete file.stageStarted; delete file.saveClosing;
  }
  await persist();
}
async function pendingCleanup(tabId) {
  const entries = Object.entries(state.cleanup).slice(0, 300);
  for (const [token] of entries) {try {await pageCommand(tabId, {action: 'cleanup', token}, true); delete state.cleanup[token];} catch {break;}}
  if (entries.length) await persist();
}
const interruptionMessage = error => {
  const known = {USER_CANCELED: '下载已由使用者取消', USER_SHUTDOWN: '浏览器已关闭下载', FILE_ACCESS_DENIED: '浏览器无法保存文件，请检查下载目录权限', FILE_NO_SPACE: '保存空间不足', FILE_BLOCKED: '浏览器阻止了此文件，请查看下载列表', FILE_SECURITY_CHECK_FAILED: '浏览器文件安全检查未通过', SERVER_BAD_CONTENT: '浏览器未保存完整音轨', NETWORK_FAILED: '音轨连接失败', NETWORK_TIMEOUT: '音轨连接超时', NETWORK_DISCONNECTED: '音轨连接已断开'};
  return known[error] || '浏览器下载中断，请查看浏览器下载列表并重新扫描';
};
function stageErrorMessage(code) {
  const known = {HTTP_ERROR: '普通播放页面未能读取音轨，请正常播放后重新扫描', INVALID_MEDIA: '平台未返回有效的独立 AAC 音轨，未保存', INCOMPLETE_MEDIA: '音轨大小或实际时长不完整，未保存', SIZE_LIMIT: '单个音轨超过 3 GB，未保存', STORAGE_FULL: '浏览器临时存储空间不足，请清理浏览器存储后重试', CANCELED: '音轨准备已停止，请重新扫描后重试', PAGE_CHANGED: '保存页面已离开原视频，下载已停止', STAGE_MISSING: '保存页面连接已中断，请先查看浏览器下载列表后重试'};
  return known[code] || '浏览器未能完整准备音轨，请查看下载列表后重新扫描';
}
function jobSnapshot(job) { return snapshotDownloads(job); }
async function nativeItem(id) { return (await chrome.downloads.search({id}))[0]; }
async function adoptNative(file) {
  if (!file.blobUrl || !file.handoffAt || Number.isInteger(file.nativeId)) return;
  const recent = await chrome.downloads.search({startedAfter: new Date(file.handoffAt - 2000).toISOString(), limit: 100, orderBy: ['-startTime']});
  const claimed = new Set(Object.values(state.jobs).flatMap(job => job.files).filter(other => other !== file).map(other => other.nativeId));
  // Anchor downloads belong to the ordinary source page, not the extension.
  // Match the exact locally generated blob URL, never a filename alone.
  const matching = recent.filter(item => item.url === file.blobUrl && !claimed.has(item.id));
  if (matching.length > 1) throw new HelperError('STAGE_MISSING', '出现多个临时音轨保存记录，请查看浏览器下载列表，未重复触发');
  if (matching.length === 1) file.nativeId = matching[0].id;
}
async function failFile(file, message) {
  file.state = 'failed'; file.error = cleanText(message, 240);
  await persist(); await cleanupFile(file);
}
async function refreshFile(file) {
  if (TERMINAL_STATES.has(file.state)) return;
  await adoptNative(file);
  if (Number.isInteger(file.nativeId)) {
    const id = file.nativeId, item = await nativeItem(id);
    if (file.nativeId !== id || TERMINAL_STATES.has(file.state)) return;
    if (!item || item.url !== file.blobUrl) {await failFile(file, '浏览器保存记录已丢失或改变，请确认下载结果后再试'); return;}
    if (item.state === 'complete') {
      if (!isCompleteNativeFile(file, item)) {await failFile(file, '浏览器实际保存大小与完整音轨不一致，未标记成功'); return;}
      file.state = 'completed'; file.bytes = file.expectedBytes; file.totalBytes = file.expectedBytes; delete file.error;
      await persist(); await cleanupFile(file); return;
    }
    if (item.state === 'interrupted') {await failFile(file, interruptionMessage(item.error)); return;}
    file.state = 'transferring'; return;
  }
  if (!file.stageTabId || !file.stageToken) {
    if (file.state !== 'waiting') await failFile(file, '下载连接已中断，未再次触发，请先查看浏览器下载列表');
    return;
  }
  let tab;
  try {tab = await chrome.tabs.get(file.stageTabId);} catch {await failFile(file, '音轨保存页面已关闭，下载已停止'); return;}
  if (Date.now() - file.startedAt > STAGE_TIMEOUT) {await failFile(file, '音轨保存超过时间上限，已停止并清理'); return;}
  if (tab.status === 'loading' && !file.stageStarted) {
    if (Date.now() - file.startedAt > 30000) {await failFile(file, '音轨保存页面未能打开，请正常播放后重试'); return;}
    // tabs.create can initially report about:blank with the requested video in
    // pendingUrl. Wait for that owned navigation, not a second media start.
    if (!tab.url || tab.url === 'about:blank' || sameSavePage(tab.url, file.source) || sameSavePage(tab.pendingUrl, file.source)) return;
  }
  if (!sameSavePage(tab.url, file.source)) {await failFile(file, '音轨保存页面已离开原视频，下载已停止'); return;}
  let value;
  if (!file.stageStarted) {
    // Persist before start. A lost acknowledgment or worker restart will poll
    // this token only; it never starts the same network request a second time.
    file.stageStarted = true; await persist();
    await pendingCleanup(tab.id);
    value = await pageCommand(tab.id, {action: 'start', token: file.stageToken, url: file.mediaUrls[file.candidateIndex], source: file.source, filename: file.filename, duration: file.duration, maxBytes: MAX_FILE_BYTES}, true);
  } else value = await pageCommand(tab.id, {action: 'poll', token: file.stageToken});
  value = validStageSnapshot(file, value);
  if (['missing', 'disposed'].includes(value.state)) {await failFile(file, '保存页面连接已中断，请先查看浏览器下载列表后重试'); return;}
  if (value.state === 'failed') {
    const retry = value.errorCode === 'HTTP_ERROR' && file.candidateIndex + 1 < file.mediaUrls.length && file.expiresAt > Date.now();
    if (retry) {await cleanupFile(file); file.candidateIndex++; file.state = 'waiting'; file.bytes = 0; delete file.expectedBytes; delete file.totalBytes; delete file.error;}
    else await failFile(file, stageErrorMessage(value.errorCode));
    return;
  }
  file.bytes = value.bytes; if (value.expectedBytes) {file.expectedBytes = value.expectedBytes; file.totalBytes = value.expectedBytes;}
  file.stagePhase = value.state; file.state = value.bytes > 0 ? 'transferring' : 'preparing';
  if (value.state === 'ready' || value.state === 'handing_off') {
    file.blobUrl = value.blobUrl;
    if (!file.handoffAt && value.state === 'ready') {
      file.handoffAt = Date.now(); await persist();
      // One handoff only. Its durable intent is committed before the native
      // anchor click, so an unknown result is recovered by exact-URL search.
      const handed = validStageSnapshot(file, await pageCommand(tab.id, {action: 'handoff', token: file.stageToken}));
      if (handed.state !== 'handing_off') {await failFile(file, stageErrorMessage(handed.errorCode)); return;}
      file.stagePhase = 'handing_off';
    } else if (!file.handoffAt) {await failFile(file, '音轨保存来源状态已改变，未再次触发下载'); return;}
    await adoptNative(file);
    if (Number.isInteger(file.nativeId)) {await refreshFile(file); return;}
    if (Date.now() - file.handoffAt > 15000) await failFile(file, '浏览器未确认保存记录，请允许该页面下载并查看下载列表，未重复触发');
  }
}
function finishJob(job, snapshot) {
  if (!TERMINAL_STATES.has(snapshot.state)) return;
  job.finishedAt ||= Date.now();
  for (const file of job.files) {delete file.mediaUrls; delete file.ruleId;}
}
async function driveJob(id) {
  if (jobsDriving.has(id)) {jobsNeedingDrive.add(id); return;}
  jobsDriving.add(id);
  try {
    const job = state.jobs[id]; if (!job) return;
    if (TERMINAL_STATES.has(jobSnapshot(job).state)) {for (const file of job.files) if (file.stageToken) await cleanupFile(file); return;}
    for (const file of job.files) {
      try {await refreshFile(file);} catch (error) {await failFile(file, failure(error).message);}
    }
    if (!job.files.some(file => ['preparing', 'transferring'].includes(file.state))) {
      const next = job.files.find(file => file.state === 'waiting');
      if (next) {
        try {
          const url = validateMediaUrl(next.mediaUrls[next.candidateIndex]);
          if (mediaExpiry(url) <= Date.now() + 5000 || next.expiresAt <= Date.now()) throw new HelperError('EXPIRED', '页面音轨地址已过期，请重新正常播放并扫描');
          next.state = 'preparing'; next.startedAt = Date.now(); next.stageToken = crypto.randomUUID(); next.stagePhase = 'loading'; await persist();
          const tab = await chrome.tabs.create({url: parseBilibiliUrl(next.source).canonical, active: false});
          next.stageTabId = tab.id; await persist();
          await refreshFile(next);
        } catch (error) {await failFile(next, failure(error).message);}
      }
    }
    const snapshot = jobSnapshot(job); finishJob(job, snapshot); await persist();
    if (!job.files.some(file => ['preparing', 'transferring'].includes(file.state)) && job.files.some(file => file.state === 'waiting')) queueMicrotask(() => {void driveJob(id).catch(() => {});});
  } finally {
    jobsDriving.delete(id);
    if (jobsNeedingDrive.delete(id)) queueMicrotask(() => {void driveJob(id).catch(() => {});});
  }
}
async function createDownload(owner, ids, kind) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || id.length > 100)) throw new HelperError('INVALID_MESSAGE', '请选择 1 到 100 个不同的浏览器音频');
  return locked(async () => {
    cleanRegistry();
    const files = ids.map(id => {
      const record = state.registry[id];
      if (!record) throw new HelperError('EXPIRED', '浏览器音频记录已过期，请重新扫描');
      assertOwner(record, owner);
      if (record.expiresAt <= Date.now()) throw new HelperError('EXPIRED', '页面音轨地址已过期，请重新正常播放并扫描');
      return {...record, helperId: id, state: 'waiting', bytes: 0, candidateIndex: 0};
    });
    const active = Object.values(state.jobs).filter(job => !TERMINAL_STATES.has(jobSnapshot(job).state));
    if (active.length >= 3) throw new HelperError('BUSY', '已有 3 个浏览器下载正在处理，请稍后重试');
    if (active.some(job => job.files.some(file => ids.includes(file.helperId)))) throw new HelperError('BUSY', '该音频已有下载任务，请查看浏览器下载列表');
    const finished = Object.values(state.jobs).filter(job => TERMINAL_STATES.has(jobSnapshot(job).state)).sort((a, b) => (a.finishedAt || a.createdAt) - (b.finishedAt || b.createdAt));
    while (Object.keys(state.jobs).length >= JOB_LIMIT && finished.length) delete state.jobs[finished.shift().id];
    const id = crypto.randomUUID();
    const job = {id, ...owner, kind, title: cleanText(kind === 'bundle' ? `浏览器批量下载 · ${files.length} 个音频` : files[0].title), files, createdAt: Date.now()};
    state.jobs[id] = job;
    await persist();
    // Start only after the durable task exists; the webpage receives a job ID promptly.
    queueMicrotask(() => {void driveJob(id).catch(() => {});});
    return jobSnapshot(job);
  });
}
async function getStatus(owner, id) {
  if (typeof id !== 'string' || id.length > 100) throw new HelperError('INVALID_MESSAGE', '下载任务编号无效');
  const job = state.jobs[id];
  if (!job) throw new HelperError('EXPIRED', '浏览器下载任务已过期，请查看浏览器下载列表');
  assertOwner(job, owner);
  await driveJob(id);
  const snapshot = jobSnapshot(job);
  finishJob(job, snapshot);
  await persist();
  return snapshot;
}
async function senderOwner(sender, message) {
  if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || typeof sender.url !== 'string') throw new HelperError('FORBIDDEN', '请求必须来自连接的拾音网页');
  const origin = validateSiteOrigin(sender.url);
  const current = await chrome.tabs.get(sender.tab.id);
  if (!state.siteOrigin || origin !== state.siteOrigin || message.bridgeOrigin !== origin || validateSiteOrigin(current.url) !== origin) throw new HelperError('FORBIDDEN', '此网页尚未连接浏览器助手，请点击插件连接');
  const owner = {origin, tabId: sender.tab.id, ...(typeof sender.documentId === 'string' && sender.documentId.length <= 120 ? {documentId: sender.documentId} : {})};
  const paused = state.paused[ownerKey(owner)];
  let changed = false;
  // Chrome supplies the actual document UUID. A freshly loaded webpage cannot
  // know an old request ID; ordinary iframe loading keeps the same owner UUID.
  if (owner.documentId && paused?.owner.documentId && owner.documentId !== paused.owner.documentId) {delete state.paused[ownerKey(owner)]; changed = true;}
  if (owner.documentId && scanRuntime?.owner.tabId === owner.tabId && scanRuntime.owner.documentId && owner.documentId !== scanRuntime.owner.documentId) {scanRuntime.canceled = true; changed = true;}
  if (changed) await persist();
  return owner;
}
async function bindSite(origin, tabId, pattern) {
  origin = validateSiteOrigin(origin);
  if (!Number.isInteger(tabId) || pattern !== origin + '/*') throw new HelperError('INVALID_ORIGIN', '连接网页参数无效');
  const tab = await chrome.tabs.get(tabId);
  if (validateSiteOrigin(tab.url) !== origin || !await chrome.permissions.contains({origins: [pattern]})) throw new HelperError('FORBIDDEN', '请在拾音网页授予该网站权限后重试');
  if (scanRuntime) scanRuntime.canceled = true;
  const previous = state.sitePattern;
  await chrome.scripting.unregisterContentScripts({ids: [BRIDGE_ID]}).catch(() => {});
  await chrome.scripting.registerContentScripts([{id: BRIDGE_ID, js: ['bridge.js'], matches: [pattern], allFrames: false, runAt: 'document_start', persistAcrossSessions: true}]);
  state.siteOrigin = origin; state.sitePattern = pattern;
  state.paused = {};
  await persist();
  await chrome.scripting.executeScript({target: {tabId}, files: ['bridge.js']});
  if (previous && previous !== pattern) await chrome.permissions.remove({origins: [previous]}).catch(() => {});
  return {siteOrigin: origin};
}
async function completePendingBind() {
  return locked(async () => {
    const pending = state.pendingBind;
    if (!pending) return {prepared: false};
    if (pending.expiresAt <= Date.now()) {delete state.pendingBind; await persist(); return {prepared: false};}
    if (!await chrome.permissions.contains({origins: [pending.pattern]})) return {prepared: true};
    try {
      const result = await bindSite(pending.origin, pending.tabId, pending.pattern);
      delete state.pendingBind; delete state.bindError;
      await persist();
      return {prepared: true, ...result};
    } catch (error) {
      delete state.pendingBind; state.bindError = failure(error).message;
      await persist();
      throw error;
    }
  });
}
async function prepareBind(origin, tabId, pattern) {
  origin = validateSiteOrigin(origin);
  if (!Number.isInteger(tabId) || pattern !== origin + '/*') throw new HelperError('INVALID_ORIGIN', '连接网页参数无效');
  const tab = await chrome.tabs.get(tabId);
  if (validateSiteOrigin(tab.url) !== origin) throw new HelperError('FORBIDDEN', '请回到要连接的拾音网页后重新打开插件');
  // The native permissions prompt can close the action popup. Persist the user's
  // exact intent before permission completion, so onAdded can finish the binding.
  await locked(async () => {
    state.pendingBind = {origin, tabId, pattern, createdAt: Date.now(), expiresAt: Date.now() + 2 * 60 * 1000};
    delete state.bindError;
    await persist();
  });
  // Also covers an already granted permission or onAdded arriving before storage.
  return completePendingBind();
}
async function disconnect() {
  if (scanRuntime) scanRuntime.canceled = true;
  const pattern = state.sitePattern;
  delete state.siteOrigin; delete state.sitePattern; delete state.pendingBind; state.paused = {};
  await chrome.scripting.unregisterContentScripts({ids: [BRIDGE_ID]}).catch(() => {});
  await persist();
  if (pattern) await chrome.permissions.remove({origins: [pattern]}).catch(() => {});
  // Browser-owned downloads deliberately continue; only the website bridge is removed.
  return {disconnected: true};
}
async function handle(message, sender) {
  await ready;
  if (message?.popupAction) {
    if (sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) throw new HelperError('FORBIDDEN', '只有插件面板可以更改连接网站');
    if (message.popupAction === 'status') return {siteOrigin: state.siteOrigin || '', scanPaused: Object.keys(state.paused).length > 0, ...(state.bindError ? {error: state.bindError} : {})};
    if (message.popupAction === 'prepareBind') return prepareBind(message.origin, message.tabId, message.pattern);
    if (message.popupAction === 'bind') return locked(() => bindSite(message.origin, message.tabId, message.pattern));
    if (message.popupAction === 'disconnect') return locked(disconnect);
    throw new HelperError('INVALID_MESSAGE', '插件操作无效');
  }
  const request = validateEnvelope(message);
  if (JSON.stringify(message).length > 20000) throw new HelperError('INVALID_MESSAGE', '浏览器助手请求过大');
  const owner = await senderOwner(sender, message);
  switch (request.action) {
    case 'ping': return {version: VERSION, capabilities: ['bilibili-scan', 'native-download', 'native-batch'], siteOrigin: state.siteOrigin};
    case 'scan': return scan(owner, request.id, request.payload);
    case 'cancelScan': {
      const id = request.payload.requestId;
      if (typeof id !== 'string' || id.length > 160) throw new HelperError('INVALID_MESSAGE', '扫描任务编号无效');
      let canceled = false;
      if (scanRuntime?.requestId === id) {assertOwner({...scanRuntime.owner}, owner); scanRuntime.canceled = true; canceled = true;}
      const paused = state.paused[ownerKey(owner)];
      if (paused?.requestId === id) {delete state.paused[ownerKey(owner)]; canceled = true;}
      await persist();
      return {canceled};
    }
    case 'download': return createDownload(owner, [request.payload.helperId], 'file');
    case 'downloadBatch': return createDownload(owner, request.payload.helperIds, 'bundle');
    case 'getDownloadStatus': return getStatus(owner, request.payload.id);
    default: throw new HelperError('INVALID_MESSAGE', '不支持的浏览器助手操作');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(result => respond({ok: true, result}), error => respond({ok: false, error: failure(error)}));
  return true;
});
chrome.downloads.onChanged.addListener(delta => {
  void ready.then(async () => {
    const jobs = Object.values(state.jobs).filter(job => job.files.some(file => file.nativeId === delta.id));
    for (const job of jobs) await driveJob(job.id);
  }).catch(() => {});
});
chrome.downloads.onCreated?.addListener(item => {
  void ready.then(async () => {
    const jobs = Object.values(state.jobs).filter(job => job.files.some(file => file.blobUrl === item.url && file.handoffAt && !TERMINAL_STATES.has(file.state)));
    for (const job of jobs) await driveJob(job.id);
  }).catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'shiyin-maintenance') return;
  void ready.then(async () => {
    cleanRegistry();
    const now = Date.now();
    if (state.pendingBind?.expiresAt <= now) delete state.pendingBind;
    for (const [id, job] of Object.entries(state.jobs)) {
      if (job.finishedAt && now - job.finishedAt > 24 * 60 * 60 * 1000) delete state.jobs[id];
      else await driveJob(id);
    }
    await persist();
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  void ready.then(async () => {
    for (const job of Object.values(state.jobs)) {
      for (const file of job.files) {
        if (file.stageTabId === tabId && !file.saveClosing && !TERMINAL_STATES.has(file.state)) {
          // A complete native save is still accepted if it won the close race.
          await adoptNative(file);
          if (Number.isInteger(file.nativeId)) await refreshFile(file);
          if (!TERMINAL_STATES.has(file.state)) {
            if (Number.isInteger(file.nativeId)) await chrome.downloads.cancel(file.nativeId).catch(() => {});
            await failFile(file, '音轨保存页面已关闭，下载已停止');
          }
          await driveJob(job.id);
        }
      }
    }
    if (state.biliTabId === tabId) {delete state.biliTabId; state.paused = {}; if (scanRuntime) scanRuntime.canceled = true;}
    if (scanRuntime?.owner.tabId === tabId) scanRuntime.canceled = true;
    for (const [id, entry] of Object.entries(state.registry)) if (entry.tabId === tabId) delete state.registry[id];
    for (const [key, paused] of Object.entries(state.paused)) if (paused.owner?.tabId === tabId) delete state.paused[key];
    await persist();
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!['loading', 'complete'].includes(change.status) && typeof change.url !== 'string') return;
  void ready.then(async () => {
    if (tabId === state.biliTabId) return; // Ordinary scanner navigation is expected.
    const savedJobs = Object.values(state.jobs).filter(job => job.files.some(file => file.stageTabId === tabId && !file.saveClosing && !TERMINAL_STATES.has(file.state)));
    for (const job of savedJobs) await driveJob(job.id);
    if (savedJobs.length || change.status === 'complete') return;
    let changed = false;
    if (scanRuntime?.owner.tabId === tabId && (typeof change.url === 'string' || !scanRuntime.owner.documentId)) {scanRuntime.canceled = true; changed = true;}
    for (const [key, paused] of Object.entries(state.paused)) {
      if (paused.owner?.tabId === tabId && (typeof change.url === 'string' || !paused.owner.documentId)) {delete state.paused[key]; changed = true;}
    }
    // A new webpage context cannot know the previous request ID. Native browser
    // downloads continue independently; only the departed scan context is reset.
    if (changed) await persist();
  }).catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => {
  void ready.then(async () => {
    if (state.sitePattern && !await chrome.permissions.contains({origins: [state.sitePattern]})) await disconnect();
  }).catch(() => {});
});
chrome.permissions.onAdded.addListener(() => {
  void ready.then(() => completePendingBind()).catch(() => {});
});
void ready.then(async () => {
  await completePendingBind().catch(() => {});
  for (const job of Object.values(state.jobs)) {
    await driveJob(job.id);
  }
}).catch(() => {});
