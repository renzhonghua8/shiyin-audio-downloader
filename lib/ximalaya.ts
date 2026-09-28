import {createDecipheriv} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {audioResponse, filename, publicUrl, safeFetch, videoResponse, type AudioFile} from './audio';

type PlayLocation = {url?: string; type?: string; fileSize?: number; qualityLevel?: number};
type TrackInfo = {
  trackId?: number; title?: string; duration?: number; sampleDuration?: number;
  isPublic?: boolean; isPaid?: boolean; paidType?: number; isAuthorized?: boolean;
  playUrlList?: PlayLocation[];
};
type PlayResponse = {ret?: number; msg?: string; trackInfo?: TrackInfo; albumInfo?: {title?: string}};

export function ximalayaTrackId(raw: string) {
  const url = publicUrl(raw);
  if (!/(?:^|\.)ximalaya\.com$/i.test(url.hostname)) return undefined;
  return url.pathname.match(/\/(?:gatekeeper\/podcast-share\/)?sound\/(\d+)\/?$/)?.[1];
}

async function readPlayResponse(response: Response): Promise<PlayResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('喜马拉雅播放接口未返回数据');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1024 * 1024) throw new Error('喜马拉雅播放信息过大');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let data: PlayResponse;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('喜马拉雅播放接口未返回有效数据'); }
  if (!data || typeof data !== 'object' || typeof data.ret !== 'number') throw new Error('喜马拉雅播放接口未返回有效数据');
  return data;
}

async function getPlayback(trackId: string, referer: string) {
  const failures = new Set<string>();
  const dnsCache = new Set<string>();
  let stopFallback = false;
  // The public desktop player itself uses these origins as playback fallbacks.
  // The share page's HTML is a shell and its m.ximalaya.com playback endpoint
  // can fail even when the desktop player's anonymous endpoint succeeds.
  const profiles = [
    {host: 'mobile.ximalaya.com', device: 'web', quality: 1, referer},
    {host: 'www.ximalaya.com', device: 'web', quality: 1, referer},
    // The official podcast-share page uses this request profile. It can differ
    // from the desktop player's response; keep the same authorization checks.
    {host: 'mobile.ximalaya.com', device: 'podcast', quality: 0, referer: `https://m.ximalaya.com/gatekeeper/podcast-share/sound/${trackId}`},
  ];
  for (const profile of profiles) {
    if (stopFallback) break;
    try {
      const endpoint = `https://${profile.host}/mobile-playpage/track/v3/baseInfo/${Date.now()}?device=${profile.device}&trackId=${trackId}&trackQualityLevel=${profile.quality}`;
      const {response} = await safeFetch(endpoint, {referer: profile.referer, dnsCache});
      const data = await readPlayResponse(response);
      if (data.ret !== 0) {
        const detail = typeof data.msg === 'string' ? data.msg.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0,160) : '';
        const regionRestricted = data.ret === 927 && /版权|地区|国家|地域/.test(detail);
        if (regionRestricted) failures.clear();
        failures.add(regionRestricted ? `喜马拉雅版权地区限制（返回 927）：${detail}` : `喜马拉雅播放接口未提供音频（返回 ${data.ret}）${detail ? '：'+detail : '，接口没有提供详细原因'}`);
        // A region restriction must not trigger attempts through other players.
        stopFallback = data.ret === 927 || /验证码|滑块|滑动验证|人机验证|安全验证|captcha|需要登录|登录后/i.test(detail);
        continue;
      }
      if (!data.trackInfo || String(data.trackInfo.trackId) !== trackId) throw new Error('喜马拉雅返回的节目与分享链接不一致');
      return data;
    } catch (error) { failures.add(error instanceof Error ? error.message : '喜马拉雅暂未向服务器提供播放地址'); }
  }
  throw new Error([...failures].join('；') || '喜马拉雅暂未向服务器提供播放地址');
}

function playbackUrl(value: string) {
  if (!value || value.length > 8192) throw new Error('喜马拉雅播放地址无效');
  if (/^https?:\/\//i.test(value)) return publicUrl(value).href;
  // This decodes the URL field exactly as the public website does. Audio bytes
  // are not decrypted. The website publishes this metadata wrapping key in its
  // player JavaScript; authorization and preview checks happen before this step.
  const encrypted = Buffer.from(value, 'base64url');
  if (!encrypted.length || encrypted.length % 16) throw new Error('喜马拉雅播放地址格式已变化');
  // ECB has no IV. A zero-length buffer works in both Node and Workers,
  // whereas the Workers compatibility implementation rejects a null IV.
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from('aaad3e4fd540b0f79dca95606e72bf93', 'hex'), Buffer.alloc(0));
  try { return publicUrl(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')).href; }
  catch { throw new Error('喜马拉雅播放地址格式已变化'); }
}

function locationOrder(item: PlayLocation) {
  const type = (item.type || '').toUpperCase();
  const format = type.startsWith('M4A') ? 3 : type.startsWith('MP3') ? 2 : type.startsWith('AAC') ? 1 : 0;
  return (Number(item.qualityLevel) || 0) * 10 + format;
}

function directFormat(url: string, contentType: string, type: string) {
  const extension = new URL(url).pathname.match(/\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i)?.[1];
  if (extension) return extension.toLowerCase();
  if (/audio\/(?:mp4|x-m4a)/i.test(contentType) || /^M4A/i.test(type)) return 'm4a';
  if (/audio\/mpeg/i.test(contentType) || /^MP3/i.test(type)) return 'mp3';
  if (/audio\/aac/i.test(contentType) || /^AAC/i.test(type)) return 'aac';
  return 'audio';
}

export async function scanXimalaya(raw: string): Promise<{title: string; files: AudioFile[]; warnings: string[]}> {
  const trackId = ximalayaTrackId(raw);
  if (!trackId) throw new Error('请使用喜马拉雅单个声音的分享链接');
  const source = `https://www.ximalaya.com/sound/${trackId}`;
  const data = await getPlayback(trackId, source);
  const info = data.trackInfo!;
  const title = info.title?.trim() || `喜马拉雅音频 ${trackId}`;
  const result = (warning: string) => ({title, files: [] as AudioFile[], warnings: [warning]});
  if (info.isPublic !== true || info.isPaid !== false || Number(info.paidType) > 0 || info.isAuthorized !== true) {
    return result('该节目需要登录、付费或播放授权，未获取完整公开音频');
  }
  const duration = Number(info.duration);
  if (!Number.isFinite(duration) || duration <= 0) return result('无法确认该节目的完整时长，请稍后重试');
  if (Number(info.sampleDuration) > 0 && Number(info.sampleDuration) + 2 < duration) {
    return result('喜马拉雅仅提供试听片段，无法下载完整音频');
  }
  const locations = Array.isArray(info.playUrlList)
    ? info.playUrlList.filter(item => item && typeof item.url === 'string').sort((a, b) => locationOrder(b) - locationOrder(a))
    : [];
  if (!locations.length) return result('找到节目，但喜马拉雅未向服务器提供可读取的完整播放地址');
  const errors = new Set<string>();
  // Multiple encodings of one recording are alternatives, not separate files.
  for (const item of locations.slice(0, 3)) {
    try {
      const media = playbackUrl(item.url!);
      const {response, url} = await safeFetch(media, {referer: source, range: 'bytes=0-0'});
      const size = Number(response.headers.get('content-range')?.split('/')[1] || response.headers.get('content-length') || 0);
      const contentType = response.headers.get('content-type') || '';
      const audio = audioResponse(response, url), video = videoResponse(response, url);
      await response.body?.cancel();
      if (!audio && !video) throw new Error('喜马拉雅播放地址未返回音频或视频');
      const expectedSize = Number(item.fileSize) || 0;
      if (expectedSize > 0 && size > 0 && size < expectedSize * 0.95) throw new Error('喜马拉雅返回的媒体文件小于完整节目，可能只有试听内容');
      const podcast = data.albumInfo?.title;
      if (audio) {
        const format = directFormat(url, contentType, item.type || '');
        return {title, files: [{url, source, title, filename: filename(title, format), format, size: size || expectedSize, duration, podcast, mode: 'direct'}], warnings: []};
      }
      const {inspectRemoteMedia} = await import('./media');
      const track = await inspectRemoteMedia(url, source);
      if (track.duration + 2 < duration) throw new Error('喜马拉雅返回的音轨不是完整节目');
      return {title, files: [{url, source, title, filename: filename(title, track.format), format: track.format, size: 0, sourceSize: size || expectedSize, sourceFormat: (item.type || 'VIDEO').toUpperCase(), duration: track.duration, podcast, mode: 'extract', codec: track.codec}], warnings: []};
    } catch (error) { errors.add(error instanceof Error ? error.message : '喜马拉雅播放地址暂时无法读取'); }
  }
  return result(`找到节目，但完整音频读取失败：${[...errors].join('；')}`);
}
