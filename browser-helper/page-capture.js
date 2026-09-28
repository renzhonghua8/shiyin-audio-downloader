/* Observe the ordinary page player. This script never makes a network request. */
(() => {
  'use strict';
  const page = window;
  const installedKey = '__SHIYIN_BILI_CAPTURE_INSTALLED_V1__';
  const cacheKey = '__SHIYIN_BILI_PLAYINFO_V1__';
  if (page[installedKey]) return;
  Object.defineProperty(page, installedKey, {value: true});

  const maxJsonBytes = 1024 * 1024;
  const maxTracks = 16;
  const maxBackups = 8;
  const maxUrlLength = 8192;
  const paths = new Set(['/x/player/playurl', '/x/player/wbi/playurl']);
  const permissionContainers = new Set([
    'rights', 'permission', 'permissions', 'permissionflags', 'payinfo', 'pay_info',
    'previewinfo', 'preview_info', 'trialinfo', 'trial_info', 'drminfo', 'drm_info',
    'drmdata', 'drm_data', 'access', 'accessinfo', 'access_info',
  ]);
  const permissionKeys = new Map([
    ['isdrm', 'is_drm'], ['drm', 'drm'], ['drmtechtype', 'drm_tech_type'],
    ['drmtype', 'drm_type'], ['drmkey', 'drm_key'], ['widevine', 'widevine'],
    ['ispreview', 'is_preview'], ['istrial', 'is_trial'], ['ispay', 'is_pay'],
    ['ispaid', 'is_paid'], ['needpay', 'need_pay'], ['needlogin', 'need_login'],
    ['isvip', 'is_vip'], ['viponly', 'vip_only'], ['issample', 'is_sample'],
    ['preview', 'preview'], ['trial', 'trial'], ['pay', 'pay'],
    ['ugcpay', 'ugc_pay'], ['ugcpaypreview', 'ugc_pay_preview'], ['arcpay', 'arc_pay'],
  ]);
  let newestRequest = 0;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const positiveInteger = value => {
    if (!(typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const positiveNumber = value => {
    if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)))) return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  };

  function requestContext(raw, method) {
    if (typeof raw !== 'string' || typeof method !== 'string' || method.toUpperCase() !== 'GET') return null;
    let url;
    try { url = new URL(raw, page.location.href); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'api.bilibili.com' || url.username || url.password || url.port || !paths.has(url.pathname)) return null;
    if (url.searchParams.getAll('cid').length !== 1) return null;
    const cid = positiveInteger(url.searchParams.get('cid'));
    if (!cid) return null;
    const bvids = url.searchParams.getAll('bvid');
    const aids = [...url.searchParams.getAll('aid'), ...url.searchParams.getAll('avid')];
    if (bvids.length > 1 || aids.length > 1) return null;
    if (bvids.length && !/^BV[A-Za-z0-9]{10}$/.test(bvids[0])) return null;
    const aid = aids.length ? positiveInteger(aids[0]) : null;
    if (aids.length && !aid) return null;
    // Do not retain the URL, the other query parameters, or any request options.
    return {
      requestCid: String(cid),
      ...(bvids.length ? {requestBvid: bvids[0]} : {}),
      ...(aid ? {requestAid: String(aid)} : {}),
    };
  }

  function begin(context) {
    if (!context) return null;
    // A new ordinary request supersedes an older response, including when it fails.
    delete page[cacheKey];
    return {...context, sequence: ++newestRequest};
  }

  function permissions(value, depth = 0, result = {}) {
    if (!record(value)) return result;
    if (depth > 4) throw new Error('Playback permissions are too deeply nested');
    let count = 0;
    for (const key in value) {
      if (!own(value, key)) continue;
      if (++count > 128) throw new Error('Playback metadata is too large');
      const normal = key.toLowerCase();
      const marker = permissionKeys.get(normal.replace(/_/g, ''));
      if (marker) {
        const flag = value[key];
        // A DRM key or permission object is evidence only; never retain its contents.
        if (flag !== 0 && flag !== false && flag !== null && flag !== undefined && flag !== '') result[marker] = true;
      } else if (permissionContainers.has(normal)) {
        permissions(value[key], depth + 1, result);
      }
    }
    return result;
  }

  function audioTrack(track) {
    if (!record(track) || typeof track.codecs !== 'string' || !/^mp4a\.40\.2$/i.test(track.codecs)) return null;
    const mime = track.mimeType ?? track.mime_type;
    if (typeof mime !== 'string' || !/^audio\/mp4$/i.test(mime)) return null;
    const base = track.baseUrl ?? track.base_url;
    const backups = track.backupUrl ?? track.backup_url;
    if (base !== undefined && (typeof base !== 'string' || base.length > maxUrlLength)) throw new Error('Audio address is too large');
    if (backups !== undefined && (!Array.isArray(backups) || backups.length > maxBackups || backups.some(url => typeof url !== 'string' || url.length > maxUrlLength))) throw new Error('Audio addresses are too large');
    const result = {codecs: track.codecs, mimeType: mime, ...permissions(track)};
    if (typeof base === 'string') result.baseUrl = base;
    if (Array.isArray(backups)) result.backupUrl = [...backups];
    if (Number.isFinite(track.bandwidth) && track.bandwidth >= 0) result.bandwidth = track.bandwidth;
    if (Number.isSafeInteger(track.id) && track.id >= 0) result.id = track.id;
    return result;
  }

  function publish(body, context) {
    try {
      if (!context || context.sequence !== newestRequest || !record(body) || !Number.isInteger(body.code)) return;
      const cid = Number(context.requestCid);
      if (own(body, 'cid') && positiveInteger(body.cid) !== cid) return;
      if (record(body.data) && own(body.data, 'cid') && positiveInteger(body.data.cid) !== cid) return;
      if (body.code === 0 && !record(body.data)) return;
      const data = {cid, ...permissions(body)};
      if (body.code === 0 && record(body.data)) {
        Object.assign(data, permissions(body.data));
        const length = positiveNumber(body.data.timelength);
        if (length !== undefined) data.timelength = length;
        const dash = body.data.dash;
        if (record(dash)) {
          if (dash.audio !== undefined && (!Array.isArray(dash.audio) || dash.audio.length > maxTracks)) return;
          data.dash = {...permissions(dash), audio: (dash.audio || []).map(audioTrack).filter(Boolean)};
          const duration = positiveNumber(dash.duration);
          if (duration !== undefined) data.dash.duration = duration;
        }
      }
      page[cacheKey] = {
        requestCid: context.requestCid,
        capturedAt: Date.now(),
        playinfo: {code: body.code, data},
        ...(context.requestBvid ? {requestBvid: context.requestBvid} : {}),
        ...(context.requestAid ? {requestAid: context.requestAid} : {}),
      };
    } catch { /* Observing malformed player data must not affect the page. */ }
  }

  async function observeFetch(response, context) {
    let reader;
    try {
      if (!response || response.status < 200 || response.status >= 300 || typeof response.clone !== 'function') return;
      const clone = response.clone();
      if (!clone.body || typeof clone.body.getReader !== 'function') return;
      reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let json = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxJsonBytes) {
          // A tee branch cancellation may wait for the original consumer. Do not await it.
          Promise.resolve(reader.cancel()).catch(() => {});
          return;
        }
        json += decoder.decode(chunk.value, {stream: true});
      }
      json += decoder.decode();
      publish(JSON.parse(json), context);
    } catch { /* The page receives its original response or error unchanged. */ }
    finally { try { reader?.releaseLock(); } catch { /* Already closed. */ } }
  }

  const nativeFetch = page.fetch;
  if (typeof nativeFetch === 'function') {
    page.fetch = function fetch(input) {
      const pending = Reflect.apply(nativeFetch, this, arguments);
      try {
        let raw;
        let method = 'GET';
        if (typeof input === 'string') raw = input;
        else if (typeof URL !== 'undefined' && input instanceof URL) raw = input.href;
        else if (typeof Request !== 'undefined' && input instanceof Request) { raw = input.url; method = input.method; }
        const options = arguments[1];
        if (options?.method !== undefined) method = options.method;
        const context = begin(requestContext(raw, method));
        if (context && pending && typeof pending.then === 'function') {
          pending.then(response => observeFetch(response, context), () => {}).catch(() => {});
        }
      } catch { /* No observer error can change fetch's return value. */ }
      return pending;
    };
  }

  const xhrPrototype = page.XMLHttpRequest?.prototype;
  if (xhrPrototype && typeof xhrPrototype.open === 'function' && typeof xhrPrototype.send === 'function') {
    const nativeOpen = xhrPrototype.open;
    const nativeSend = xhrPrototype.send;
    const requests = new WeakMap();
    xhrPrototype.open = function open(method, url) {
      const result = Reflect.apply(nativeOpen, this, arguments);
      try {
        const previous = requests.get(this);
        if (previous?.listener) this.removeEventListener('load', previous.listener);
        const raw = typeof url === 'string' ? url : typeof URL !== 'undefined' && url instanceof URL ? url.href : undefined;
        requests.set(this, {context: requestContext(raw, method)});
      } catch { /* Leave native XHR behavior intact. */ }
      return result;
    };
    xhrPrototype.send = function send() {
      let entry;
      try {
        entry = requests.get(this);
        if (entry?.context && !entry.listener) {
          const context = begin(entry.context);
          entry.listener = () => {
            try {
              if (this.status < 200 || this.status >= 300) return;
              if (this.responseType === 'json') publish(this.response, context);
              else if (this.responseType === '' || this.responseType === 'text') {
                const text = this.responseText;
                if (typeof text === 'string' && text.length <= maxJsonBytes && new TextEncoder().encode(text).byteLength <= maxJsonBytes) publish(JSON.parse(text), context);
              }
            } catch { /* Ignore unsupported response types and malformed JSON. */ }
            finally { try { this.removeEventListener('load', entry.listener); } catch { /* XHR was disposed. */ } }
          };
          this.addEventListener('load', entry.listener);
        }
      } catch { /* Observation cannot prevent the page's request. */ }
      try { return Reflect.apply(nativeSend, this, arguments); }
      catch (error) {
        try { if (entry?.listener) this.removeEventListener('load', entry.listener); } catch { /* Native error wins. */ }
        throw error;
      }
    };
  }
})();
