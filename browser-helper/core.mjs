// Pure validation and status helpers. This module never fetches media or reads a session.
export const CHANNEL = 'SHIYIN_BROWSER_HELPER_V1';
export const VERSION = '1.0.0';
export const TERMINAL_STATES = new Set(['completed', 'partial', 'failed']);
export class HelperError extends Error {
  constructor(code, message) { super(message); this.name = 'HelperError'; this.code = code; }
}
const fail = (code, message) => { throw new HelperError(code, message); };
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
export function cleanText(value, max = 200) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
export function validateSiteOrigin(raw) {
  let u; try { u = new URL(raw); } catch { fail('INVALID_ORIGIN', '请在拾音网页点击插件进行连接'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.origin === 'null') fail('INVALID_ORIGIN', '只能连接 HTTP 或 HTTPS 拾音网页');
  return u.origin;
}
export function parseBilibiliUrl(raw) {
  let u; try { u = new URL(raw); } catch { fail('INVALID_URL', '请使用含 BV 号的哔哩哔哩视频链接'); }
  if (u.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(u.hostname) || u.username || u.password || u.port) fail('INVALID_URL', '请使用公开的 HTTPS 哔哩哔哩视频链接');
  const bvid = /^\/video\/(BV[a-zA-Z0-9]{10})\/?$/.exec(u.pathname)?.[1];
  if (!bvid) fail('INVALID_URL', '浏览器助手目前支持含 BV 号的普通视频链接');
  const selected = u.searchParams.get('p');
  if (selected !== null && !/^[1-9]\d{0,5}$/.test(selected)) fail('INVALID_PART', '分 P 编号无效');
  const part = selected === null ? undefined : Number(selected);
  return {bvid, part, canonical: `https://www.bilibili.com/video/${bvid}/${part ? '?p=' + part : ''}`};
}
export function validateEnvelope(message) {
  if (!record(message) || message.channel !== CHANNEL || message.direction !== 'to-helper' || typeof message.id !== 'string' || !/^[\w:.-]{1,160}$/.test(message.id)) fail('INVALID_MESSAGE', '浏览器助手收到无效请求');
  const actions = ['ping', 'scan', 'cancelScan', 'download', 'downloadBatch', 'getDownloadStatus'];
  if (!actions.includes(message.action) || (message.payload !== undefined && !record(message.payload))) fail('INVALID_MESSAGE', '浏览器助手请求格式或操作无效');
  return {id: message.id, action: message.action, payload: message.payload || {}};
}
export function assertOwner(value, owner) {
  if (!value || value.origin !== owner.origin || value.tabId !== owner.tabId) fail('FORBIDDEN', '该任务不属于当前拾音网页，请重新扫描');
  return value;
}
export function validateMediaUrl(raw) {
  let u; try { u = new URL(raw); } catch { fail('UNSUPPORTED_MEDIA', '音轨地址无效'); }
  const allowed = u.hostname.endsWith('.bilivideo.com') || u.hostname === 'bilivideo.com' || u.hostname.endsWith('.bilivideo.cn') || u.hostname === 'bilivideo.cn' || u.hostname === 'upos-hz-mirrorakam.akamaized.net';
  if (u.protocol !== 'https:' || !allowed || u.username || u.password || (u.port && u.port !== '443') || u.hash || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > 8192) fail('UNSUPPORTED_MEDIA', '平台音轨地址不在已支持的官方 HTTPS CDN 范围内');
  return u.href;
}
export function mediaExpiry(url, now = Date.now()) {
  const u = new URL(url);
  let expiry = now + 30 * 60 * 1000;
  for (const key of ['deadline', 'expires', 'exp']) {
    const raw = u.searchParams.get(key);
    if (raw && /^\d{10,13}$/.test(raw)) { const n = Number(raw); expiry = Math.min(expiry, n < 1e12 ? n * 1000 : n); }
  }
  return expiry;
}
function denied(value) {
  if (!record(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (/^(is_?drm|drm|drm_?tech_?type|drm_?type|drm_?key|widevine|is_?preview|is_?trial|is_?pay|is_?paid|need_?pay|need_?login|is_?vip|vip_?only|is_?sample|preview|trial|pay|arc_pay|ugc_pay|ugc_pay_preview)$/i.test(key) && item !== 0 && item !== false && item !== null && item !== undefined && item !== '') return true;
    if (record(item) && denied(item)) return true;
  }
  return false;
}
export function audioFilename(title) {
  let text = cleanText(title, 115).replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
  while (new TextEncoder().encode(text).length > 220) text = text.slice(0, -1);
  return (text || '音频') + '.m4a';
}
export function parsePageAudio(snapshot, requestedUrl) {
  const requested = typeof requestedUrl === 'string' ? parseBilibiliUrl(requestedUrl) : requestedUrl;
  if (!record(snapshot)) fail('NEEDS_USER', '请在打开的哔哩哔哩页面正常播放视频，再回到拾音重试');
  let actual; try { actual = parseBilibiliUrl(typeof snapshot.location === 'string' ? snapshot.location : snapshot.location?.href); } catch { fail('NEEDS_USER', '哔哩哔哩页面正在登录、验证或跳转，请正常完成后重试'); }
  if (actual.bvid !== requested.bvid || (actual.part || 1) !== (requested.part || 1)) fail('PAGE_MISMATCH', '播放页面与当前视频或分 P 不一致，请正常播放指定页面后重试');
  const initial = snapshot.initialState;
  const info = initial?.videoData;
  if (!record(initial) || !record(info) || !record(snapshot.playinfo)) fail('NEEDS_USER', '没有读到当前页面的播放资料。请完成页面登录或验证，点击播放后回到拾音重试');
  if (info.bvid !== requested.bvid || (initial.bvid && initial.bvid !== requested.bvid)) fail('PAGE_MISMATCH', '页面视频资料与 BV 号不一致');
  if (!record(info.rights) || !Object.hasOwn(info.rights, 'pay') || !Object.hasOwn(info.rights, 'ugc_pay')) fail('UNSUPPORTED_PERMISSION', '页面缺少公开访问标记，暂不能确认完整音轨权限');
  if (denied({rights: info.rights, permission: info.permission, payInfo: info.payInfo, is_pay: info.is_pay, is_paid: info.is_paid}) || (typeof info.state === 'number' && info.state < 0)) fail('RESTRICTED_MEDIA', '该视频包含付费、试看或受限标记，浏览器助手只保存公开完整音轨');
  const parts = Array.isArray(info.pages) ? info.pages.map(p => ({cid: Number(p.cid), page: Number(p.page), part: cleanText(p.part), duration: Number(p.duration)})) : [];
  if (!parts.length || parts.length > 10000 || parts.some(p => !Number.isSafeInteger(p.cid) || p.cid <= 0 || !Number.isInteger(p.page) || p.page <= 0 || !Number.isFinite(p.duration) || p.duration <= 0) || new Set(parts.map(p => p.page)).size !== parts.length) fail('NEEDS_USER', '页面未提供有效分 P 和完整时长，请正常播放后重试');
  const part = parts.find(p => p.page === (requested.part || 1));
  if (!part) fail('INVALID_PART', '没有找到指定分 P');
  const currentCid = initial.cid ?? (part.page === 1 ? info.cid : undefined);
  if (Number(currentCid) !== part.cid) fail('PAGE_MISMATCH', '当前播放 CID 与指定分 P 不一致，请在打开页面播放对应分 P 后重试');
  const play = snapshot.playinfo;
  if (play.code !== 0) fail('NEEDS_USER', `当前页面未提供成功的播放资料${Number.isInteger(play.code) ? '（返回 ' + play.code + '）' : ''}，请正常播放后重试`);
  const data = play.data;
  // Alternative video quality requirements are not restrictions on this selected
  // audio. Track-specific DRM is checked below before considering any address.
  if (!record(data) || denied({...data, support_formats: undefined, dash: record(data.dash) ? {...data.dash, audio: undefined} : undefined})) fail('RESTRICTED_MEDIA', '播放资料含试看、登录或 DRM 标记，未下载');
  if (data.cid !== undefined && Number(data.cid) !== part.cid) fail('PAGE_MISMATCH', '音轨播放 CID 与当前分 P 不一致');
  const duration = Number(data.timelength) / 1000;
  if (!Number.isFinite(duration) || duration <= 0 || Math.abs(duration - part.duration) > 2) fail('INCOMPLETE_MEDIA', '平台音轨时长与当前完整分 P 不一致，未下载；请确认可正常播放完整视频');
  const dashDuration = Number(data.dash?.duration);
  if (!Number.isFinite(dashDuration) || dashDuration <= 0 || Math.abs(dashDuration - part.duration) > 2 || Math.abs(dashDuration - duration) > 2) fail('INCOMPLETE_MEDIA', 'DASH 音轨完整时长与视频不一致，未下载');
  const tracks = Array.isArray(data.dash?.audio) ? [...data.dash.audio].sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0)) : [];
  const addresses = [];
  for (const track of tracks) {
    if (!record(track) || denied(track) || !/^mp4a\.40\.2$/i.test(track.codecs || '') || !/^audio\/mp4$/i.test(track.mimeType || track.mime_type || '')) continue;
    const urls = [track.baseUrl || track.base_url, ...(Array.isArray(track.backupUrl || track.backup_url) ? track.backupUrl || track.backup_url : [])];
    for (const url of urls) {
      // Reject suspicious returned addresses rather than silently importing them.
      if (typeof url === 'string' && url) addresses.push(validateMediaUrl(url));
    }
  }
  if (!addresses.length) fail('UNSUPPORTED_MEDIA', '当前页面未提供公开的独立 AAC 音轨；仅支持完整 AAC DASH 音频');
  const title = cleanText(info.title) || requested.bvid;
  const fileTitle = parts.length > 1 ? `${title} · P${part.page} ${part.part}` : title;
  const source = `https://www.bilibili.com/video/${requested.bvid}/${parts.length > 1 ? '?p=' + part.page : ''}`;
  return {title, parts, files: [{mediaUrls: [...new Set(addresses)], source, title: fileTitle, filename: audioFilename(fileTitle), format: 'm4a', codec: 'aac', duration, page: part.page, cid: part.cid}], warnings: []};
}
export function isCompleteNativeFile(file, item) {
  const expected = file.expectedBytes;
  return item?.state === 'complete' && typeof file.blobUrl === 'string' && item.url === file.blobUrl && Number.isSafeInteger(expected) && expected > 0 && item.bytesReceived === expected && item.totalBytes === expected && item.fileSize === expected;
}
export function snapshotDownloads(job, items = []) {
  const byId = new Map(items.map(item => [item.id, item]));
  const files = job.files || [];
  let bytes = 0, totalBytes = 0, knownTotal = true, completedFiles = 0, failedFiles = 0, transferring = false, preparing = false;
  const failures = [];
  for (const file of files) {
    const native = byId.get(file.nativeId);
    const state = file.state === 'completed' || file.state === 'failed' ? file.state : native?.state === 'complete' ? file.expectedBytes !== undefined && !isCompleteNativeFile(file, native) ? 'failed' : 'completed' : native?.state === 'interrupted' ? 'failed' : native?.state === 'in_progress' ? 'transferring' : file.state || 'waiting';
    bytes += Math.max(0, Number(native?.bytesReceived ?? file.bytes) || 0);
    const total = native?.totalBytes ?? file.totalBytes;
    if (!(typeof total === 'number' && total > 0)) knownTotal = false; else totalBytes += total;
    if (state === 'completed') completedFiles++;
    if (state === 'failed') { failedFiles++; failures.push(cleanText(file.title || file.filename) + '：' + cleanText(file.error || native?.error || '浏览器下载失败')); }
    if (state === 'transferring') transferring = true;
    if (state === 'preparing') preparing = true;
  }
  const ended = files.length > 0 && completedFiles + failedFiles === files.length;
  const state = ended ? failedFiles ? completedFiles ? 'partial' : 'failed' : 'completed' : transferring ? 'transferring' : preparing ? 'preparing' : 'waiting';
  return {id: job.id, kind: job.kind, title: job.title, state, bytes, ...(knownTotal && totalBytes > 0 ? {totalBytes} : {}), completedFiles, totalFiles: files.length, ...(failures.length ? {failures, ...(state === 'failed' ? {error: failures[0]} : {})} : {})};
}
