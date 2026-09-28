export type AudioFile = { url: string; source: string; title: string; filename: string; format: string; size: number; duration?: number; podcast?: string; mode?: 'direct'|'extract'; sourceSize?: number; sourceFormat?: string; codec?: string };
const extensions = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|aiff?|wma)(?:$|[?#])/i;
const videoExtensions = /\.(mp4|m4v|mov|webm|mkv|m3u8|ts)(?:$|[?#])/i;
export function publicUrl(raw: string, base?: string) {
  const u = new URL(raw, base);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw new Error('请使用公开的 HTTP 或 HTTPS 链接');
  // Reject literal IPs and internal hostnames; DNS answers are checked before fetch.
  if (!host.includes('.') || host.includes(':') || /^\[|^[\d.]+$/.test(host) || /(?:^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) || host === 'metadata.google.internal') throw new Error('不支持本机或内网地址');
  u.hash = ''; return u;
}
function privateIp(ip: string) {
  if (ip.includes(':')) return !/^[23][0-9a-f]{3}:/i.test(ip) || /^2001:db8:/i.test(ip);
  const n = ip.split('.').map(Number);
  return n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224 || (n[0] === 169 && n[1] === 254) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && (n[1] === 168 || n[1] === 0)) || (n[0] === 100 && n[1] >= 64 && n[1] <= 127) || (n[0] === 198 && [18,19].includes(n[1]));
}
async function verifyDns(host: string) {
  type DnsAnswer={Status:number;Answer?:{type:number;data:string}[]};
  let records:DnsAnswer[]|undefined;
  for(const provider of ['https://cloudflare-dns.com/dns-query','https://dns.google/resolve']){
    try{records=await Promise.all(['A','AAAA'].map(async type=>{
      const r=await fetch(provider+'?name='+encodeURIComponent(host)+'&type='+type,{headers:{Accept:'application/dns-json'},signal:AbortSignal.timeout(8000)});
      if(!r.ok)throw new Error('DNS 查询失败');
      const data=await r.json() as DnsAnswer;
      if(!Number.isInteger(data.Status)||(data.Answer!==undefined&&!Array.isArray(data.Answer)))throw new Error('DNS 返回无效数据');
      return data;
    }));break;}catch{/* Retry transport failures with the second public resolver. */}
  }
  if(!records)throw new Error('暂时无法确认网站地址，请稍后重试');
  const ips = records.flatMap(d => (d.Answer || []).filter(x => x.type === 1 || x.type === 28));
  if (records.some(d=>d.Status!==0) || !ips.length || ips.some(x => privateIp(x.data))) throw new Error('网站地址无法访问或不是公开地址');
}
export async function safeFetch(raw: string, options: { referer?: string; range?: string; long?: boolean; signal?:AbortSignal; dnsCache?:Set<string> } = {}) {
  let u = publicUrl(raw);
  for (let i = 0; i < 6; i++) {
    if(!options.dnsCache?.has(u.hostname)){await verifyDns(u.hostname);options.dnsCache?.add(u.hostname);}
    const headers: Record<string,string> = { 'User-Agent': 'Mozilla/5.0 (compatible; AudioCollector/1.0)', Accept: '*/*' };
    if (options.referer) headers.Referer = publicUrl(options.referer).href;
    if (options.range) headers.Range = options.range;
    const timeout=AbortSignal.timeout(options.long ? 600000 : 18000);
    const r = await fetch(u.href, { headers, redirect: 'manual', signal: options.signal?AbortSignal.any([timeout,options.signal]):timeout });
    if ([301,302,303,307,308].includes(r.status)) {
      await r.body?.cancel(); const location = r.headers.get('location');
      if (!location) throw new Error('网站跳转缺少目标地址');
      u = publicUrl(location,u.href); continue;
    }
    if (!r.ok) { await r.body?.cancel(); throw new Error(r.status === 401 || r.status === 403 || r.status === 412 ? `媒体网站未接受服务器请求（HTTP ${r.status}）；浏览器可访问不代表服务器请求能通过` : `媒体网站向服务器返回 HTTP ${r.status}，请稍后重试`); }
    return { response: r, url: u.href };
  }
  throw new Error('网站跳转次数过多');
}
async function textLimited(r: Response, max = 3 * 1024 * 1024) {
  const reader = r.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('页面太大，无法完整扫描'); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{}); }
  const data = new Uint8Array(size); let offset = 0; for (const c of chunks) {data.set(c,offset);offset+=c.length;}
  return new TextDecoder().decode(data);
}
function decode(s: string) { return s.replace(/\\u([0-9a-f]{4})/gi,(_,n)=>String.fromCharCode(parseInt(n,16))).replace(/\\\//g,'/').replace(/&amp;|&#38;|&#x26;/gi,'&').replace(/&quot;|&#34;/gi,'"').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/&lt;/g,'<').replace(/&gt;/g,'>'); }
export function filename(title: string, ext: string) { let clean=title.replace(/[\x00-\x1f<>:"/\\|?*]/g,' ').replace(/\s+/g,' ').trim().slice(0,115).replace(/[. ]+$/,'');while(new TextEncoder().encode(clean).length>220)clean=clean.slice(0,-1);return (clean||'音频') + '.' + ext.toLowerCase(); }
function inferFormat(url: string, type: string) {
  const ext = url.match(extensions)?.[1].toLowerCase(); if (ext) return ext;
  if (/audio\/(mp4|x-m4a)/i.test(type)) return 'm4a';
  const map:Record<string,string> = {'audio/mpeg':'mp3','audio/aac':'aac','audio/ogg':'ogg','audio/opus':'opus','audio/wav':'wav','audio/x-wav':'wav','audio/flac':'flac','audio/x-flac':'flac','audio/webm':'webm','audio/aiff':'aiff','audio/x-ms-wma':'wma'};
  return map[type.split(';')[0].toLowerCase()] || 'audio';
}
export function audioResponse(r: Response, url: string) {
  const type = r.headers.get('content-type') || '';
  if(/mpegurl/i.test(type)||/\.m3u8(?:$|[?#])/i.test(url))return false;
  return /^audio\//i.test(type) || (extensions.test(url) && /^(application\/(octet-stream|ogg)|binary\/octet-stream)/i.test(type));
}
export function videoResponse(r:Response,url:string){const t=r.headers.get('content-type')||'';return /^video\//i.test(t)||/(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(t)||(videoExtensions.test(url)&&/(?:octet-stream|text\/plain|mpegurl)/i.test(t));}
async function videoFile(url:string,source:string,title:string,sourceSize=0){const {inspectRemoteMedia}=await import('./media');const info=await inspectRemoteMedia(url,source);return {url,source,title,filename:filename(title,info.format),format:info.format,size:0,sourceSize,sourceFormat:url.match(videoExtensions)?.[1]?.toUpperCase()||'VIDEO',duration:info.duration,mode:'extract' as const,codec:info.codec};}
export async function scanPage(raw: string) {
  const original = publicUrl(raw).href;
  if(/(?:^|\.)bilibili\.com$/i.test(new URL(original).hostname)&&/\/video\//.test(new URL(original).pathname)){const {scanBilibili}=await import('./bilibili');return scanBilibili(original);}
  const {response:r,url} = await safeFetch(original);
  if (audioResponse(r,url)) {
    const format = inferFormat(url,r.headers.get('content-type')||''); const title = decodeURIComponent(new URL(url).pathname.split('/').pop() || '音频').replace(extensions,'');
    const size = Number(r.headers.get('content-length')||0); await r.body?.cancel();
    return { title, files:[{url,source:original,title,filename:filename(title,format),format,size} as AudioFile],warnings:[] as string[] };
  }
  if(videoResponse(r,url)){const size=Number(r.headers.get('content-length')||0);await r.body?.cancel();const title=decodeURIComponent(new URL(url).pathname.split('/').pop()||'视频音轨').replace(videoExtensions,'');return {title,files:[await videoFile(url,original,title,size)],warnings:[] as string[]};}
  if (!/(text|json|xml|javascript)/i.test(r.headers.get('content-type')||'text/html')) { await r.body?.cancel();throw new Error('该链接不是可扫描的网页或音频'); }
  const html = await textLimited(r);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || new URL(url).hostname).replace(/\s*\|\s*小宇宙[\s\S]*$/,'').trim();
  type Candidate = {url:string;title?:string;duration?:number;podcast?:string;video?:boolean};
  const candidates = new Map<string,Candidate>(); const warnings: string[] = [];
  let truncated = false;
  const add = (raw: string, base: string, meta: Partial<Candidate>={}) => {try {const u=publicUrl(decode(raw),base).href; if(candidates.size>=150&&!candidates.has(u)){truncated=true;return;} candidates.set(u,{...candidates.get(u),...meta,url:u});}catch{}};
  // Xiaoyuzhou's own page data points to the original audio, even for video episodes.
  const nextData=html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if(nextData) try { const data=JSON.parse(nextData); const e=data?.props?.pageProps?.episode;
    if(e?.media?.source?.url && (!e.media.mimeType || e.media.mimeType.startsWith('audio/'))) add(e.media.source.url,url,{title:e.title,duration:e.duration,podcast:e.podcast?.title});
    else if(e?.media?.source?.url) add(e.media.source.url,url,{title:e.title,duration:e.duration,podcast:e.podcast?.title,video:true});
  }catch{}
  function extract(body:string, base:string) {
    const decoded=decode(body);
    const baseTag=decoded.match(/<base\b[^>]*href=["']([^"']+)["']/i)?.[1];
    try { if(baseTag) base=publicUrl(baseTag,base).href; }catch{}
    for(const m of decoded.matchAll(/(?:https?:\/\/|\/\/|(?:\.\.?\/|\/))[^\s"'<>`\\]*?\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac|aiff?|wma)(?:\?[^\s"'<>`\\]*)?/gi)) add(m[0],base);
    for(const m of decoded.matchAll(/["']([^"'\s<>]+\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac|aiff?|wma)(?:\?[^"'\s<>]*)?)["']/gi)) add(m[1],base);
    for(const m of decoded.matchAll(/<(?:audio|source)\b[^>]*>/gi)) {const tag=m[0];const src=tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]; if(src && (tag.startsWith('<audio') || /type=["']audio\//i.test(tag) || extensions.test(src))) add(src,base);}
    for(const m of decoded.matchAll(/<enclosure\b[^>]*>/gi)) {const tag=m[0];const src=tag.match(/\burl=["']([^"']+)["']/i)?.[1];if(src&&(/type=["']audio\//i.test(tag)||extensions.test(src)))add(src,base);}
    for(const m of decoded.matchAll(/<(?:video|source)\b[^>]*>/gi)){const tag=m[0],src=tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];if(src&&(!/^<source/i.test(tag)||/type=["'](?:video\/|application\/(?:x-mpegurl|vnd\.apple\.mpegurl))/i.test(tag)||videoExtensions.test(src)))add(src,base,{video:true});}
    for(const m of decoded.matchAll(/(?:https?:\/\/|\/\/|(?:\.\.?\/|\/))[^\s"'<>`\\]*?\.(?:mp4|m4v|mov|webm|mkv|m3u8|ts)(?:\?[^\s"'<>`\\]*)?/gi))add(m[0],base,{video:true});
    for(const m of decoded.matchAll(/["']([^"'\s<>]+\.(?:mp4|m4v|mov|webm|mkv|m3u8|ts)(?:\?[^"'\s<>]*)?)["']/gi))add(m[1],base,{video:true});
  }
  if (!(new URL(url).hostname.endsWith('xiaoyuzhoufm.com') && candidates.size)) extract(html,url);
  // Only inspect embedded frames and linked scripts when no direct audio is present.
  if (!candidates.size) {
    const related = [...html.matchAll(/<(iframe|script)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].slice(0,6);
    for (const match of related) {try {const target=publicUrl(decode(match[2]),url);if(match[1].toLowerCase()==='script'&&target.origin!==new URL(url).origin)continue;const {response}=await safeFetch(target.href,{referer:url});const body=await textLimited(response,1024*1024);extract(body,target.href);}catch{warnings.push('部分嵌入内容未能扫描');}}
  }
  const files: AudioFile[]=[]; const list=[...candidates.values()]; let cursor=0; let failed=0;const errors=new Set<string>();
  await Promise.all(Array.from({length:Math.min(3,list.length)},async()=>{while(cursor<list.length){const c=list[cursor++];try {const {response,url:final}=await safeFetch(c.url,{referer:url,range:'bytes=0-0'});const accepted=audioResponse(response,final),video=videoResponse(response,final);const size=Number(response.headers.get('content-range')?.split('/')[1]||response.headers.get('content-length')||0);const format=inferFormat(final,response.headers.get('content-type')||'');await response.body?.cancel();const name=c.title || (list.length===1?title:decodeURIComponent(new URL(final).pathname.split('/').pop()||'音频').replace(extensions,'').replace(videoExtensions,''));if(accepted){files.push({url:final,source:url,title:name,filename:filename(name,format),format,size,duration:c.duration,podcast:c.podcast,mode:'direct'});}else if(video){files.push({...await videoFile(final,url,name,size),podcast:c.podcast});}else failed++;}catch(e){failed++;if(c.video&&e instanceof Error)errors.add(e.message);}}}));
  warnings.push(...errors);
  if(failed)warnings.push(`${failed} 个候选音频暂时无法读取`);
  if(truncated)warnings.push('本页音频超过 150 个，只扫描了前 150 个');
  if(!files.length) warnings.push('未发现可下载的音频或可提取的音轨。页面可能需要登录，或媒体在播放后才加载。');
  return {title,files:files.sort((a,b)=>a.title.localeCompare(b.title)),warnings:[...new Set(warnings)]};
}
export function downloadHeaders(name:string,type='application/octet-stream') {return {'Content-Type':type,'Content-Disposition':`attachment; filename="audio-download.${name.endsWith('.zip')?'zip':name.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};}
