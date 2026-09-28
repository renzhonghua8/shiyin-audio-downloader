import {safeFetch,publicUrl,filename,type AudioFile} from './audio';
import {inspectRemoteMedia} from './media';
type Part={cid:number;page:number;part:string;duration:number};
type DashAudio={baseUrl?:string;base_url?:string;backupUrl?:string[];backup_url?:string[];bandwidth:number;codecs:string};
async function api<T>(url:string,referer:string){const {response}=await safeFetch(url,{referer});const d=await response.json() as {code:number;message?:string;data:T};if(d.code!==0||!d.data)throw new Error(d.code===-104||d.code===-101?'该视频需要登录或访问权限':`哔哩哔哩暂时无法提供媒体（${d.code}），请稍后重试`);return d.data;}
export async function scanBilibili(raw:string){
 const u=publicUrl(raw),id=u.pathname.match(/\/video\/(BV[a-zA-Z0-9]{10})/i)?.[1];if(!id)throw new Error('请使用含 BV 号的哔哩哔哩视频链接');
 const source='https://www.bilibili.com/video/'+id+'/';
 const info=await api<{title:string;pages:Part[];duration:number}>('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(id),source);
 const p=u.searchParams.get('p'),parts=p?info.pages.filter(x=>x.page===Number(p)):info.pages.slice(0,100);
 if(!parts.length)throw new Error('没有找到该分 P 视频');
 const files:AudioFile[]=[],warnings:string[]=[];
 for(const part of parts){try{
  const pageSource=source+(info.pages.length>1?'?p='+part.page:'');
  const play=await api<{timelength:number;dash?:{audio?:DashAudio[]};durl?:{url:string;length:number;backup_url?:string[]}[]}>('https://api.bilibili.com/x/player/playurl?'+new URLSearchParams({bvid:id,cid:String(part.cid),qn:'32',fnval:'16',fnver:'0',fourk:'1'}),pageSource);
  const platformDuration=play.timelength/1000;
  if(!Number.isFinite(platformDuration)||platformDuration<=0)throw new Error('平台未提供完整音视频时长');
  if(platformDuration+2<part.duration)throw new Error('平台仅提供了试看片段，未下载；完整内容需要相应权限');
  const audio=[...(play.dash?.audio||[])].sort((a,b)=>b.bandwidth-a.bandwidth);
  if(!audio.length&&play.durl&&play.durl.length>1)throw new Error('此视频使用多段旧格式，暂不支持完整提取');
  const candidates=audio.length
   ?audio.flatMap(track=>[track.baseUrl||track.base_url,...(track.backupUrl||track.backup_url||[])])
   :[play.durl?.[0]?.url,...(play.durl?.[0]?.backup_url||[])];
  const addresses=[...new Set(candidates.filter((url):url is string=>typeof url==='string'&&!!url))];
  if(!addresses.length)throw new Error('平台未提供可读取的音轨');
  let found=false,lastError='音轨地址暂时无法读取';
  for(const mediaUrl of addresses){try{
   // A full-length API response supplies the duration of fragmented MP4.
   // Do not traverse the entire audio during discovery; extraction checks
   // the actual final packet before declaring the stream complete.
   const inspected=await inspectRemoteMedia(mediaUrl,pageSource,platformDuration);
   if(inspected.duration+2<part.duration)throw new Error('音轨时长短于完整视频，未下载');
   const title=info.pages.length>1?info.title+' · P'+part.page+' '+part.part:info.title;
   files.push({url:mediaUrl,source:pageSource,title,filename:filename(title,inspected.format),format:inspected.format,size:0,duration:inspected.duration,mode:'extract',sourceFormat:audio.length?'独立音轨':'视频',codec:inspected.codec});
   found=true;break;
  }catch(e){lastError=e instanceof Error?e.message:'音轨地址读取失败';}}
  if(!found)throw new Error('主音轨和备用地址均未能读取：'+lastError);
 }catch(e){warnings.push('P'+part.page+'：'+(e instanceof Error?e.message:'获取音轨失败'));}}
 if(info.pages.length>100&&!p)warnings.push('该视频超过 100 个分 P，本次只处理前 100 个');
 return {title:info.title,files,warnings};
}
