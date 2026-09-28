import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {createCipheriv} from 'node:crypto';
import {
  ALL_FORMATS, BufferSource, BufferTarget, EncodedAudioPacketSource,
  EncodedPacket, Input, Mp4OutputFormat, Output,
} from 'mediabunny';
import {extractRemoteAudio, inspectRemoteMedia} from '../lib/media';
import {scanBilibili} from '../lib/bilibili';
import {scanXimalaya, ximalayaTrackId} from '../lib/ximalaya';

const MEDIA = 'https://media.shiyin-fixtures.net/audio.m4a';
const REFERER = 'https://www.bilibili.com/video/BV1T8D7BWE6S/';
const TRACK_ID = '1002620649';
const XIMA_SHARE = `https://m.ximalaya.com/gatekeeper/podcast-share/sound/${TRACK_ID}?share_source=test`;
const packetDuration = 1024 / 48000;

// Six-byte AAC silence access units are muxed as encoded packets; no browser
// decoder, ffmpeg binary, stored media or external network is needed.
async function fragmentedAudio(seconds: number) {
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({fastStart: 'fragmented', minimumFragmentDuration: 1}),
    target,
  });
  const source = new EncodedAudioPacketSource('aac');
  output.addAudioTrack(source);
  await output.start();
  const count = Math.ceil(seconds / packetDuration);
  for (let i = 0; i < count; i++) {
    const packet = new EncodedPacket(new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]), 'key', i * packetDuration, packetDuration);
    await source.add(packet, i === 0 ? {
      decoderConfig: {codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90])},
    } : undefined);
  }
  source.close();
  await output.finalize();
  assert.ok(target.buffer);
  const data = new Uint8Array(target.buffer);
  // Real streaming MP4 commonly lacks both a duration and a tail seek index.
  // Remove the optional top-level mfra index without modifying any audio bytes.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset + 8 <= data.length;) {
    const size = view.getUint32(offset);
    assert.ok(size >= 8 && offset + size <= data.length);
    const type = new TextDecoder().decode(data.subarray(offset + 4, offset + 8));
    if (type === 'mfra') return {data: data.slice(0, offset), duration: count * packetDuration};
    offset += size;
  }
  return {data, duration: count * packetDuration};
}

type RequestRecord = {url: URL; range: string | null};
type Handler = (request: RequestRecord) => Response | Promise<Response>;

function mockNetwork(t: TestContext, handler: Handler) {
  const requests: RequestRecord[] = [];
  t.mock.method(globalThis, 'fetch', async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url);
    const headers = new Headers(init?.headers ?? (resource instanceof Request ? resource.headers : undefined));
    if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') {
      return Response.json({Status: 0, Answer: [{type: 1, data: '1.1.1.1'}]});
    }
    const record = {url, range: headers.get('range')};
    requests.push(record);
    return handler(record);
  });
  return requests;
}

function rangeMedia(data: Uint8Array) {
  const metrics = {bytesRead: 0, reads: 0};
  const respond = ({range}: RequestRecord) => {
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
    if (start >= data.length) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${data.length}`}});
    let cursor = start, canceled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Match a network body that can be canceled before it downloads the
        // entire open-ended Range request during metadata-only discovery.
        await setImmediate();
        if (canceled) return;
        if (cursor > end) { controller.close(); return; }
        const chunk = data.slice(cursor, Math.min(cursor + 4096, end + 1));
        cursor += chunk.length;
        metrics.bytesRead += chunk.length;
        metrics.reads++;
        controller.enqueue(chunk);
      },
      cancel() { canceled = true; },
    });
    return new Response(body, {status: range ? 206 : 200, headers: {
      'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      ...(range ? {'Content-Range': `bytes ${start}-${end}/${data.length}`} : {}),
    }});
  };
  return {metrics, respond};
}

test('fragmented MP4 discovery uses the validated platform duration without reading the complete recording', async t => {
  // Above UrlSource's 512 KiB minimum prefetch, while staying below 2 MiB.
  const fixture = await fragmentedAudio(3600);
  const input = new Input({formats: ALL_FORMATS, source: new BufferSource(fixture.data)});
  try {
    const track = await input.getPrimaryAudioTrack();
    assert.ok(track);
    assert.equal(await track.getDurationFromMetadata(), null, 'fixture must lack duration metadata');
  } finally { input.dispose(); }
  const media = rangeMedia(fixture.data);
  mockNetwork(t, request => {
    assert.equal(request.url.href, MEDIA);
    return media.respond(request);
  });
  const info = await inspectRemoteMedia(MEDIA, REFERER, fixture.duration);
  assert.equal(info.codec, 'aac');
  assert.equal(info.format, 'm4a');
  assert.equal(info.duration, fixture.duration);
  assert.equal(info.hasVideo, false);
  assert.ok(media.metrics.bytesRead < fixture.data.length / 2, `read ${media.metrics.bytesRead} of ${fixture.data.length} bytes`);
});

test('audio extraction streams a complete recording into a readable MP4', async t => {
  const fixture = await fragmentedAudio(8);
  const media = rangeMedia(fixture.data);
  mockNetwork(t, request => media.respond(request));
  const result = await extractRemoteAudio(MEDIA, REFERER, fixture.duration);
  const bytes = new Uint8Array(await new Response(result.body).arrayBuffer());
  assert.ok(bytes.length > 0);
  const input = new Input({formats: ALL_FORMATS, source: new BufferSource(bytes)});
  try {
    const track = await input.getPrimaryAudioTrack();
    assert.ok(track);
    assert.equal(await track.getCodec(), 'aac');
    assert.ok(Math.abs(await track.computeDuration() - fixture.duration) < packetDuration);
  } finally { input.dispose(); }
});

test('a platform duration hint cannot turn a truncated recording into a successful download', async t => {
  const fixture = await fragmentedAudio(8);
  const media = rangeMedia(fixture.data);
  mockNetwork(t, request => media.respond(request));
  const result = await extractRemoteAudio(MEDIA, REFERER, 40);
  await assert.rejects(new Response(result.body).arrayBuffer(), /音轨传输不完整/);
});

function biliApi(request: RequestRecord, play: object, duration: number) {
  if (request.url.hostname !== 'api.bilibili.com') return undefined;
  if (request.url.pathname === '/x/web-interface/view') {
    return Response.json({code: 0, data: {title: '测试完整视频', duration, pages: [{cid: 123456, page: 1, part: '完整音轨', duration}]}});
  }
  assert.equal(request.url.pathname, '/x/player/playurl');
  return Response.json({code: 0, data: play});
}

test('Bilibili discovers an alternate audio CDN when the primary CDN fails', async t => {
  const fixture = await fragmentedAudio(8);
  const backup = 'https://backup.shiyin-fixtures.net/audio.m4a';
  const media = rangeMedia(fixture.data);
  const play = {timelength: fixture.duration * 1000, dash: {audio: [{baseUrl: MEDIA, backupUrl: [backup], bandwidth: 128000, codecs: 'mp4a.40.2'}]}};
  const requests = mockNetwork(t, request => {
    const api = biliApi(request, play, fixture.duration);
    if (api) return api;
    if (request.url.href === MEDIA) return new Response(null, {status: 403});
    assert.equal(request.url.href, backup);
    return media.respond(request);
  });
  const result = await scanBilibili(REFERER);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].url, backup);
  assert.equal(result.files[0].mode, 'extract');
  assert.equal(result.files[0].duration, fixture.duration);
  assert.deepEqual(result.warnings, []);
  assert.ok(requests.some(request => request.url.href === MEDIA));
});

test('Bilibili refuses a short preview before requesting its media', async t => {
  const requests = mockNetwork(t, request => {
    const api = biliApi(request, {timelength: 30000, dash: {audio: [{baseUrl: MEDIA, bandwidth: 128000, codecs: 'mp4a.40.2'}]}}, 600);
    assert.ok(api, 'a preview must not trigger a media request');
    return api;
  });
  const result = await scanBilibili(REFERER);
  assert.deepEqual(result.files, []);
  assert.match(result.warnings.join(' '), /试看片段/);
  assert.equal(requests.length, 2);
});

test('Ximalaya recognizes share and standard sound links without matching lookalike domains', () => {
  assert.equal(ximalayaTrackId(XIMA_SHARE), TRACK_ID);
  assert.equal(ximalayaTrackId(`https://www.ximalaya.com/sound/${TRACK_ID}`), TRACK_ID);
  assert.equal(ximalayaTrackId(`https://m.ximalaya.com/sound/${TRACK_ID}/?from=test`), TRACK_ID);
  assert.equal(ximalayaTrackId(`https://ximalaya.com.shiyin-fixtures.net/sound/${TRACK_ID}`), undefined);
  assert.equal(ximalayaTrackId('https://www.ximalaya.com/album/123'), undefined);
});

type XimaInfo = Record<string, unknown>;
function ximaPlayback(overrides: XimaInfo = {}) {
  return {ret: 0, albumInfo: {title: '测试播客'}, trackInfo: {
    trackId: Number(TRACK_ID), title: '完整公开节目', duration: 600,
    sampleDuration: 0, isPublic: true, isPaid: false, paidType: 0, isAuthorized: true,
    playUrlList: [{url: MEDIA, type: 'M4A_64', fileSize: 10000, qualityLevel: 1}],
    ...overrides,
  }};
}

function ximaApi(request: RequestRecord, response: object) {
  if (!['mobile.ximalaya.com', 'www.ximalaya.com'].includes(request.url.hostname)) return undefined;
  assert.match(request.url.pathname, /^\/mobile-playpage\/track\/v3\/baseInfo\/\d+$/);
  assert.equal(request.url.searchParams.get('trackId'), TRACK_ID);
  return Response.json(response);
}

test('Ximalaya reads a public share using the desktop fallback and returns one recording', async t => {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('aaad3e4fd540b0f79dca95606e72bf93', 'hex'), null);
  const wrapped = Buffer.concat([cipher.update(MEDIA, 'utf8'), cipher.final()]).toString('base64url');
  const playback = ximaPlayback({playUrlList: [{url: wrapped, type: 'M4A_64', fileSize: 10000, qualityLevel: 1}]});
  const requests = mockNetwork(t, request => {
    if (request.url.hostname === 'mobile.ximalaya.com') return new Response(null, {status: 503});
    const api = ximaApi(request, playback);
    if (api) return api;
    assert.equal(request.url.href, MEDIA);
    assert.equal(request.range, 'bytes=0-0');
    return new Response(new Uint8Array([0]), {status: 206, headers: {'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-0/10000'}});
  });
  const result = await scanXimalaya(XIMA_SHARE);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].url, MEDIA);
  assert.equal(result.files[0].mode, 'direct');
  assert.equal(result.files[0].duration, 600);
  assert.equal(result.files[0].podcast, '测试播客');
  assert.equal(result.files[0].size, 10000);
  assert.deepEqual(result.warnings, []);
  assert.ok(requests.some(request => request.url.hostname === 'www.ximalaya.com'));
});

test('Ximalaya refuses paid, private, unauthorized and preview-only recordings before downloading', async t => {
  const cases = [
    {name: 'paid', info: {isPaid: true}, warning: /登录、付费或播放授权/},
    {name: 'private', info: {isPublic: false}, warning: /登录、付费或播放授权/},
    {name: 'unauthorized', info: {isAuthorized: false}, warning: /登录、付费或播放授权/},
    {name: 'preview', info: {sampleDuration: 30}, warning: /试听片段/},
  ];
  for (const item of cases) {
    await t.test(item.name, async subtest => {
      const requests = mockNetwork(subtest, request => {
        const api = ximaApi(request, ximaPlayback(item.info));
        assert.ok(api, 'protected audio must not trigger a media request');
        return api;
      });
      const result = await scanXimalaya(XIMA_SHARE);
      assert.deepEqual(result.files, []);
      assert.match(result.warnings.join(' '), item.warning);
      assert.equal(requests.length, 1);
    });
  }
});

test('Ximalaya rejects a media file smaller than the advertised complete recording', async t => {
  mockNetwork(t, request => {
    const api = ximaApi(request, ximaPlayback());
    if (api) return api;
    return new Response(new Uint8Array([0]), {status: 206, headers: {'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-0/100'}});
  });
  const result = await scanXimalaya(XIMA_SHARE);
  assert.deepEqual(result.files, []);
  assert.match(result.warnings.join(' '), /小于完整节目/);
});
