// MAIN-world, ordinary public Bilibili page only. Media is streamed to OPFS;
// neither the website bridge nor the extension worker receives media bytes.
(() => {
  'use strict';
  if (window.__SHIYIN_AUDIO_SAVE_V1__) return;
  const MAX_BYTES = 3 * 1024 * 1024 * 1024;
  const MAX_BOX = 1024 * 1024;
  const stages = new Map();
  const controlledErrors = new WeakSet();
  const validToken = token => typeof token === 'string' && /^[\w-]{16,80}$/.test(token);
  const tempName = token => 'shiyin-audio-' + token + '.tmp';
  const coded = (code, message) => {const error = Object.assign(new Error(message), {code}); controlledErrors.add(error); return error;};
  const invalid = () => {throw coded('INVALID_MEDIA', '平台未返回有效的独立 AAC 音轨，未保存');};
  const u32 = (bytes, at) => {if (at < 0 || at + 4 > bytes.length) invalid(); return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);};
  const u64 = (bytes, at) => {const value = u32(bytes, at) * 4294967296 + u32(bytes, at + 4); if (!Number.isSafeInteger(value)) invalid(); return value;};
  const text4 = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const boxes = (bytes, start = 0) => {
    const found = []; let at = start;
    while (at < bytes.length) {
      if (at + 8 > bytes.length) invalid();
      let length = u32(bytes, at), header = 8;
      if (length === 1) {length = u64(bytes, at + 8); header = 16;}
      if (length < header || at + length > bytes.length) invalid();
      found.push({type: text4(bytes, at + 4), data: bytes.subarray(at + header, at + length)});
      at += length;
    }
    return found;
  };
  const only = (list, type) => {const found = list.filter(box => box.type === type); if (found.length !== 1) invalid(); return found[0].data;};
  function aacConfig(esds) {
    if (esds.length < 8) invalid();
    const descriptor = (at, limit) => {
      if (at >= limit) invalid(); const tag = esds[at++]; let length = 0, count = 0, byte;
      do {if (at >= limit || count++ >= 4) invalid(); byte = esds[at++]; length = length * 128 + (byte & 127);} while (byte & 128);
      if (at + length > limit) invalid(); return {tag, start: at, end: at + length};
    };
    const es = descriptor(4, esds.length); if (es.tag !== 3 || es.start + 3 > es.end) invalid();
    let at = es.start + 3; const flags = esds[es.start + 2];
    if (flags & 128) at += 2;
    if (flags & 64) {if (at >= es.end) invalid(); at += 1 + esds[at];}
    if (flags & 32) at += 2;
    const decoder = descriptor(at, es.end);
    if (decoder.tag !== 4 || decoder.start + 13 > decoder.end || esds[decoder.start] !== 0x40) invalid();
    const specific = descriptor(decoder.start + 13, decoder.end);
    if (specific.tag !== 5 || specific.start + 2 > specific.end || (esds[specific.start] >> 3) !== 2) invalid();
  }
  // Bounded, incremental ISO-BMFF inspection. mdat is skipped, not accumulated;
  // moov/moof metadata is bounded to 1 MiB and validates the actual audio end.
  function audioInspector(expectedBytes, expectedDuration) {
    let header = new Uint8Array(16), headerBytes = 0, headerNeed = 8, offset = 0, current;
    let ftyp = false, moov = false, mdat = false, fragments = 0, trackId, timescale, defaultDuration = 0, defaultSize = 0, pendingMediaBytes = 0;
    let firstTime = Infinity, endTime = 0, sampleCount = 0;
    function inspectMoov(bytes) {
      if (moov || !ftyp) invalid();
      const children = boxes(bytes), tracks = children.filter(box => box.type === 'trak');
      if (children.some(box => box.type === 'pssh')) invalid();
      if (tracks.length !== 1) invalid();
      const trak = boxes(tracks[0].data), tkhd = only(trak, 'tkhd');
      trackId = u32(tkhd, tkhd[0] === 1 ? 20 : 12); if (!(trackId > 0)) invalid();
      const mdia = boxes(only(trak, 'mdia')), hdlr = only(mdia, 'hdlr');
      if (hdlr.length < 12 || text4(hdlr, 8) !== 'soun') invalid();
      const mdhd = only(mdia, 'mdhd'); timescale = u32(mdhd, mdhd[0] === 1 ? 20 : 12);
      if (!(timescale > 0 && timescale <= 10000000)) invalid();
      const stsd = only(boxes(only(boxes(only(mdia, 'minf')), 'stbl')), 'stsd');
      if (u32(stsd, 4) !== 1) invalid();
      const entry = boxes(stsd, 8); if (entry.length !== 1 || entry[0].type !== 'mp4a' || entry[0].data.length < 28) invalid();
      if (entry[0].data[8] !== 0 || entry[0].data[9] !== 0) invalid();
      const config = boxes(entry[0].data, 28);
      if (config.some(box => ['sinf', 'schm', 'tenc'].includes(box.type))) invalid();
      aacConfig(only(config, 'esds'));
      const mvex = boxes(only(children, 'mvex'));
      const trex = mvex.filter(box => box.type === 'trex' && u32(box.data, 4) === trackId);
      if (trex.length !== 1) invalid(); defaultDuration = u32(trex[0].data, 12); defaultSize = u32(trex[0].data, 16);
      moov = true;
    }
    function inspectMoof(bytes) {
      if (!moov) invalid();
      const trafs = boxes(bytes).filter(box => box.type === 'traf'); if (trafs.length !== 1) invalid();
      const traf = boxes(trafs[0].data), tfhd = only(traf, 'tfhd');
      if (u32(tfhd, 4) !== trackId) invalid();
      const flags = u32(tfhd, 0) & 0xffffff; let at = 8, duration = defaultDuration, size = defaultSize;
      if (flags & 1) at += 8; if (flags & 2) at += 4;
      if (flags & 8) {duration = u32(tfhd, at); at += 4;}
      if (flags & 16) {size = u32(tfhd, at); at += 4;}
      const tfdt = only(traf, 'tfdt'); const start = tfdt[0] === 1 ? u64(tfdt, 4) : u32(tfdt, 4);
      let summed = 0, samples = 0;
      const runs = traf.filter(box => box.type === 'trun'); if (!runs.length) invalid();
      for (const run of runs) {
        const data = run.data, flags = u32(data, 0) & 0xffffff, count = u32(data, 4); let position = 8;
        if (!count || count > 1000000) invalid();
        if (flags & 1) position += 4; if (flags & 4) position += 4;
        for (let sample = 0; sample < count; sample++) {
          const tick = flags & 0x100 ? u32(data, position) : duration;
          if (!(tick > 0)) invalid(); summed += tick;
          if (flags & 0x100) position += 4;
          const sampleSize = flags & 0x200 ? u32(data, position) : size;
          if (!(sampleSize > 0)) invalid(); pendingMediaBytes += sampleSize;
          if (flags & 0x200) position += 4; if (flags & 0x400) position += 4; if (flags & 0x800) position += 4;
          if (position > data.length) invalid();
        }
        samples += count;
      }
      if (!Number.isSafeInteger(summed) || !(summed > 0)) invalid();
      firstTime = Math.min(firstTime, start); endTime = Math.max(endTime, start + summed); sampleCount += samples; fragments++;
    }
    function completeBox() {
      if (current.type === 'ftyp') {
        if (ftyp || current.data.length < 8) invalid();
        const brands = [text4(current.data, 0)];
        for (let at = 8; at + 4 <= current.data.length; at += 4) brands.push(text4(current.data, at));
        if (!brands.some(brand => /^(iso[m2-9]|mp4[12]|dash|cmfa|cmaf)$/.test(brand))) invalid(); ftyp = true;
      } else if (current.type === 'moov') inspectMoov(current.data);
      else if (current.type === 'moof') inspectMoof(current.data);
      else if (current.type === 'mdat') {
        if (!moov || !fragments || !(pendingMediaBytes > 0) || current.size - current.header !== pendingMediaBytes) invalid();
        pendingMediaBytes = 0; mdat = true;
      }
      current = undefined; headerBytes = 0; headerNeed = 8;
    }
    return {
      append(bytes) {
        let at = 0;
        while (at < bytes.length) {
          if (!current) {
            const count = Math.min(headerNeed - headerBytes, bytes.length - at);
            header.set(bytes.subarray(at, at + count), headerBytes); headerBytes += count; at += count; offset += count;
            if (headerBytes < headerNeed) continue;
            let size = u32(header, 0);
            if (size === 1 && headerNeed === 8) {headerNeed = 16; continue;}
            if (size === 1) size = u64(header, 8);
            const type = text4(header, 4), start = offset - headerBytes;
            if (type === 'pssh') invalid();
            if (size === 0 && type === 'mdat') size = expectedBytes - start;
            if (size < headerBytes || start + size > expectedBytes) invalid();
            const capture = ['ftyp', 'moov', 'moof'].includes(type);
            if (capture && size > MAX_BOX) invalid();
            current = {type, size, header: headerBytes, remaining: size - headerBytes, data: capture ? new Uint8Array(size - headerBytes) : undefined, written: 0};
            if (!current.remaining) completeBox();
          } else {
            const count = Math.min(current.remaining, bytes.length - at);
            current.data?.set(bytes.subarray(at, at + count), current.written);
            current.remaining -= count; current.written += count; at += count; offset += count;
            if (!current.remaining) completeBox();
          }
        }
      },
      finish() {
        if (current || headerBytes || offset !== expectedBytes || !ftyp || !moov || !mdat || !fragments || !sampleCount || pendingMediaBytes) invalid();
        const duration = (endTime - firstTime) / timescale;
        if (!(duration > 0) || Math.abs(duration - expectedDuration) > 2) throw coded('INCOMPLETE_MEDIA', '实际 AAC 音轨时长与完整视频不一致，未保存');
        return duration;
      }
    };
  }
  function snapshot(stage) {
    return {token: stage.token, state: stage.state, bytes: stage.bytes, createdAt: stage.createdAt, updatedAt: stage.updatedAt, ...(stage.expectedBytes ? {expectedBytes: stage.expectedBytes} : {}), ...(stage.blobUrl ? {blobUrl: stage.blobUrl} : {}), ...(stage.errorCode ? {errorCode: stage.errorCode, error: stage.error} : {})};
  }
  function currentSource(source) {
    try {const actual = new URL(location.href), expected = new URL(source); return actual.origin === 'https://www.bilibili.com' && actual.pathname === expected.pathname && (actual.searchParams.get('p') || '1') === (expected.searchParams.get('p') || '1');} catch {return false;}
  }
  async function discard(stage) {
    if (stage.blobUrl) {URL.revokeObjectURL(stage.blobUrl); delete stage.blobUrl;}
    if (stage.root) await stage.root.removeEntry(tempName(stage.token)).catch(() => {});
  }
  async function load(stage) {
    let writer, reader;
    try {
      if (!currentSource(stage.source)) throw coded('PAGE_CHANGED', '保存页面已离开原视频，下载已停止');
      if (!navigator.storage?.getDirectory) throw coded('STORAGE_FULL', '浏览器不支持临时文件，请更新 Chrome 或 Edge 后重试');
      const response = await fetch(stage.url, {credentials: 'omit', signal: stage.abort.signal});
      if (![200, 206].includes(response.status) || !response.body) throw coded('HTTP_ERROR', '平台未接受普通播放页面的音轨读取，请正常播放后重新扫描');
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!['video/mp4', 'audio/mp4', 'application/octet-stream'].includes(contentType)) invalid();
      const length = response.headers.get('content-length');
      if (!length || !/^[1-9]\d*$/.test(length)) throw coded('INCOMPLETE_MEDIA', '平台未提供完整音轨大小，未保存');
      const expected = Number(length);
      if (!Number.isSafeInteger(expected) || expected > stage.maxBytes) throw coded('SIZE_LIMIT', '单个音轨超过 3 GB，未保存');
      if (response.status === 206) {
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        if (!range || Number(range[1]) + 1 !== expected || Number(range[2]) !== expected) throw coded('INCOMPLETE_MEDIA', '平台只返回部分音轨，未保存');
      }
      stage.expectedBytes = expected; stage.updatedAt = Date.now();
      const space = await navigator.storage.estimate?.();
      if (space && space.quota > 0 && space.quota - (space.usage || 0) < expected + MAX_BOX) throw coded('STORAGE_FULL', '浏览器临时存储空间不足，请清理浏览器存储后重试');
      stage.root = await navigator.storage.getDirectory();
      const handle = await stage.root.getFileHandle(tempName(stage.token), {create: true});
      writer = await handle.createWritable(); reader = response.body.getReader();
      const inspect = audioInspector(expected, stage.duration);
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        if (!currentSource(stage.source)) throw coded('PAGE_CHANGED', '保存页面已离开原视频，下载已停止');
        if (!(chunk.value instanceof Uint8Array) || stage.bytes + chunk.value.byteLength > expected || stage.bytes + chunk.value.byteLength > stage.maxBytes) throw coded('INCOMPLETE_MEDIA', '平台返回的音轨大小不一致，未保存');
        inspect.append(chunk.value); await writer.write(chunk.value);
        stage.bytes += chunk.value.byteLength; stage.updatedAt = Date.now();
      }
      if (stage.bytes !== expected) throw coded('INCOMPLETE_MEDIA', '音轨连接提前结束，未保存不完整文件');
      inspect.finish(); await writer.close(); writer = undefined;
      const file = await handle.getFile(); if (file.size !== expected) throw coded('INCOMPLETE_MEDIA', '临时音轨文件大小不一致，未保存');
      stage.blobUrl = URL.createObjectURL(file); stage.state = 'ready'; stage.updatedAt = Date.now();
    } catch (error) {
      stage.abort.abort(); await reader?.cancel().catch(() => {}); await writer?.abort().catch(() => {});
      const controlled = !!error && controlledErrors.has(error);
      stage.state = 'failed'; stage.errorCode = controlled ? error.code : error?.name === 'QuotaExceededError' ? 'STORAGE_FULL' : error?.name === 'AbortError' ? 'CANCELED' : 'HTTP_ERROR';
      stage.error = controlled ? error.message : stage.errorCode === 'STORAGE_FULL' ? '浏览器临时存储空间不足，请清理后重试' : stage.errorCode === 'CANCELED' ? '音轨准备已停止，请重新扫描后重试' : '普通播放页面未能读取完整音轨，请正常播放后重新扫描';
      stage.updatedAt = Date.now(); await discard(stage);
    }
  }
  async function cleanup(token) {
    const stage = stages.get(token);
    if (stage) {stage.abort.abort(); await stage.task; await discard(stage); stage.state = 'disposed'; return snapshot(stage);}
    // A closed or reloaded page loses its in-memory controller, but the exact
    // helper-owned OPFS name can still be removed without replaying a download.
    if (location.origin === 'https://www.bilibili.com' && navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory(); await root.removeEntry(tempName(token)).catch(() => {});
    }
    return {token, state: 'disposed', bytes: 0, createdAt: Date.now(), updatedAt: Date.now()};
  }
  function command(args) {
    if (!args || !validToken(args.token)) return {state: 'failed', errorCode: 'STAGE_MISSING', error: '保存任务编号无效', bytes: 0};
    const token = args.token, previous = stages.get(token);
    if (args.action === 'cleanup') return cleanup(token);
    if (args.action === 'start') {
      if (previous) return snapshot(previous);
      if ([...stages.values()].some(stage => !['disposed', 'failed'].includes(stage.state))) return {token, state: 'failed', bytes: 0, errorCode: 'STAGE_MISSING', error: '保存页面已有其他音轨任务'};
      let url; try {url = new URL(args.url);} catch {return {token, state: 'failed', bytes: 0, errorCode: 'INVALID_MEDIA', error: '音轨地址无效'};}
      const allowed = url.hostname.endsWith('.bilivideo.com') || url.hostname === 'bilivideo.com' || url.hostname.endsWith('.bilivideo.cn') || url.hostname === 'bilivideo.cn' || url.hostname === 'upos-hz-mirrorakam.akamaized.net';
      if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !currentSource(args.source) || !Number.isFinite(args.duration) || args.duration <= 0 || typeof args.filename !== 'string' || !/\.m4a$/.test(args.filename) || /[\\/\u0000-\u001f]/.test(args.filename)) return {token, state: 'failed', bytes: 0, errorCode: 'INVALID_MEDIA', error: '音轨保存参数无效'};
      const stage = {token, url: url.href, source: args.source, filename: args.filename, duration: args.duration, maxBytes: MAX_BYTES, state: 'loading', bytes: 0, abort: new AbortController(), createdAt: Date.now(), updatedAt: Date.now()};
      stages.set(token, stage); stage.task = load(stage); return snapshot(stage);
    }
    if (!previous) return {token, state: 'missing', bytes: 0, errorCode: 'STAGE_MISSING', error: '保存页面连接已中断，请查看浏览器下载列表后重试'};
    if (args.action === 'handoff' && previous.state === 'ready') {
      if (!currentSource(previous.source) || !previous.blobUrl || !document.body) {previous.state = 'failed'; previous.errorCode = 'PAGE_CHANGED'; previous.error = '保存页面已改变，未再次触发下载'; return snapshot(previous);}
      // Set the state before the native click. A lost acknowledgment is recovered
      // only through this same blob URL's Chrome download, never another click.
      previous.state = 'handing_off'; previous.updatedAt = Date.now();
      const anchor = document.createElement('a'); anchor.href = previous.blobUrl; anchor.download = previous.filename;
      document.body.append(anchor); anchor.click(); anchor.remove();
    }
    return snapshot(previous);
  }
  Object.defineProperty(window, '__SHIYIN_AUDIO_SAVE_V1__', {value: Object.freeze({command}), configurable: false, writable: false});
})();
