import {ALL_FORMATS,Input,UrlSource,EncodedPacketSink,EncodedAudioPacketSource,Output,AppendOnlyStreamTarget,Mp4OutputFormat,OggOutputFormat,Mp3OutputFormat,MkvOutputFormat,type AudioCodec} from 'mediabunny';
import {safeFetch,audioResponse,type AudioFile} from './audio';

function outputPlan(codec:AudioCodec){
 if(codec==='mp3')return {container:new Mp3OutputFormat({xingHeader:false}),format:'mp3',type:'audio/mpeg'};
 if(['opus','vorbis','flac'].includes(codec))return {container:new OggOutputFormat(),format:'ogg',type:'audio/ogg'};
 const mp4=new Mp4OutputFormat({fastStart:'fragmented',minimumFragmentDuration:5});
 if(mp4.getSupportedAudioCodecs().includes(codec))return {container:mp4,format:'m4a',type:'audio/mp4'};
 const mkv=new MkvOutputFormat({appendOnly:true});
 if(mkv.getSupportedAudioCodecs().includes(codec))return {container:mkv,format:'mka',type:'audio/x-matroska'};
 throw new Error('暂不支持提取此视频的音频编码');
}
function mediaInput(url:string,referer:string){
 const dnsCache=new Set<string>();let requests=0;
 const fetchFn:typeof fetch=async(resource,init)=>{
  if(++requests>900)throw new Error('媒体分段过多，请单独处理此文件');
  const raw=typeof resource==='string'?resource:resource instanceof URL?resource.href:resource.url;
  const headers=new Headers(init?.headers||(resource instanceof Request?resource.headers:undefined));
  const {response}=await safeFetch(raw,{referer,range:headers.get('range')||undefined,signal:init?.signal||undefined,long:true,dnsCache});
  if(response.status===200&&headers.has('range')&&Number(response.headers.get('content-length')||0)>32*1024**2){await response.body?.cancel();throw new Error('视频服务器不支持分段读取，无法提取此大文件');}
  return response;
 };
 return new Input({formats:ALL_FORMATS,source:new UrlSource(url,{fetchFn,maxCacheSize:4*1024**2,parallelism:1,getRetryDelay:()=>null,handleUnhandledError:()=>{}})});
}
async function audioTrack(input:Input){
 const track=await input.getPrimaryAudioTrack();if(!track)throw new Error('该视频没有可提取的音轨');
 if(await track.isLive())throw new Error('直播尚未结束，无法获取完整音频；请使用完整回放链接');
 const codec=await track.getCodec(),config=await track.getDecoderConfig();if(!codec||!config)throw new Error('无法读取音频编码，文件可能受保护或格式不受支持');
 const duration=await track.getDurationFromMetadata()||await track.computeDuration();
 if(!Number.isFinite(duration)||duration<=0)throw new Error('无法确认完整音轨时长');
 return {track,codec,config,duration,...outputPlan(codec)};
}
export async function inspectRemoteMedia(url:string,referer:string){
 const input=mediaInput(url,referer);
 try{const info=await audioTrack(input);return {codec:info.codec,duration:info.duration,format:info.format,type:info.type,hasVideo:(await input.getVideoTracks()).length>0};}
 catch(e){throw new Error(e instanceof Error?e.message:'无法读取视频音轨');}
 finally{input.dispose();}
}
export async function extractRemoteAudio(url:string,referer:string){
 const input=mediaInput(url,referer);
 try{
  const info=await audioTrack(input),sink=new EncodedPacketSink(info.track),first=await sink.getFirstPacket();if(!first)throw new Error('该视频音轨为空');
  const origin=first.timestamp;
  const stream=new TransformStream<Uint8Array,Uint8Array>();
  const output=new Output({format:info.container,target:new AppendOnlyStreamTarget(stream.writable)}),source=new EncodedAudioPacketSource(info.codec);
  output.addAudioTrack(source);let end=origin,count=0;
  // The returned response supplies backpressure; packets are copied without decoding.
  const work=(async()=>{try{
   await output.start();
   for await(const packet of sink.packets(first)){
    await source.add(packet.clone({timestamp:packet.timestamp-origin}),count===0?{decoderConfig:info.config}:undefined);
    end=Math.max(end,packet.timestamp+packet.duration);count++;
   }
   if(!count||end+2<info.duration)throw new Error('音轨传输不完整，请重新下载');
   source.close();await output.finalize();
  }catch(e){await output.cancel().catch(()=>{});throw e;}finally{input.dispose();}})();
  // Muxer cancellation may close its sink normally; retain the failure for the reader.
  let failure:unknown;const completed=work.catch(e=>{failure=e;});
  const reader=stream.readable.getReader();
  const body=new ReadableStream<Uint8Array>({async pull(c){try{const {done,value}=await reader.read();if(done){await completed;if(failure)throw failure;c.close();}else c.enqueue(value);}catch(e){c.error(e);input.dispose();}},async cancel(){input.dispose();await reader.cancel().catch(()=>{});await output.cancel().catch(()=>{});}});
  return {body,type:info.type,format:info.format,duration:info.duration,size:0,status:200,contentRange:null as string|null};
 }catch(e){input.dispose();throw e;}
}
export async function openAudioFile(file:AudioFile,range?:string){
 if(file.mode==='extract')return extractRemoteAudio(file.url,file.source);
 const {response:r,url}=await safeFetch(file.url,{referer:file.source,long:true,range});
 if(!audioResponse(r,url)||!r.body){await r.body?.cancel();throw new Error('该地址未返回可下载的音频');}
 return {body:r.body,type:r.headers.get('content-type')||'application/octet-stream',format:file.format,size:Number(r.headers.get('content-length')||0),status:r.status,contentRange:r.headers.get('content-range')};
}
