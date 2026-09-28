import type {AudioFile} from './audio';
import {openAudioFile} from './media';
const encoder=new TextEncoder();
const table=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function update(crc:number,chunk:Uint8Array){for(let i=0;i<chunk.length;i++)crc=table[(crc^chunk[i])&255]^(crc>>>8);return crc>>>0;}
function record(size:number,fields:[number,number,number][]){const b=new Uint8Array(size),d=new DataView(b.buffer);for(const [o,n,w] of fields)if(w===2)d.setUint16(o,n,true);else d.setUint32(o,n,true);return b;}
type Entry={name:Uint8Array;offset:number;size:number;crc:number};
export async function* zipFiles(files:AudioFile[]){
 const entries:Entry[]=[],failures:string[]=[],used=new Set<string>();let offset=0;const now=new Date(),date=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate(),time=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);
 const names=files.map(f=>{let name=f.filename.replace(/[\x00-\x1f/\\]/g,' ').slice(0,140);const stem=name.replace(/\.[^.]+$/,''),ext=name.slice(stem.length);let n=2;while(used.has(name))name=stem+' ('+(n++)+')'+ext;used.add(name);return name;});
 async function* entry(name:string,body:ReadableStream<Uint8Array>,expected=0){
  const bytes=encoder.encode(name),start=offset;let size=0,crc=0xffffffff,error='';
  const head=record(30,[[0,0x04034b50,4],[4,20,2],[6,0x808,2],[10,time,2],[12,date,2],[26,bytes.length,2]]);offset+=head.length+bytes.length;yield head;yield bytes;const reader=body.getReader();
  try{while(true){const {value,done}=await reader.read();if(done)break;if(offset+value.length>0xc0000000)throw new Error('压缩包超过 3 GB，请分批下载');size+=value.length;crc=update(crc,value);offset+=value.length;yield value;}if(expected&&size!==expected)throw new Error('音频传输未完成');}catch(e){error=e instanceof Error?e.message:'网络传输中断';}finally{await reader.cancel().catch(()=>{});}
  const checksum=(crc^0xffffffff)>>>0,descriptor=record(16,[[0,0x08074b50,4],[4,checksum,4],[8,size,4],[12,size,4]]);offset+=descriptor.length;yield descriptor;entries.push({name:bytes,offset:start,size,crc:checksum});if(error)failures.push(name+'：'+error+'。此文件可能不完整，请重新单独下载。');
 }
 for(let i=0;i<files.length;i++){const f=files[i];try{const audio=await openAudioFile(f),size=audio.size;if(offset+size>0xbf000000){await audio.body.cancel();throw new Error('压缩包已接近 3 GB，请另行下载本文件');}yield*entry(names[i],audio.body,size);}catch(e){failures.push(names[i]+'：'+(e instanceof Error?e.message:'下载失败')+'\n来源：'+f.source);}}
 if(failures.length){const b=encoder.encode('以下音频未能完整下载，请返回网页重试。\n\n'+failures.join('\n\n'));yield*entry('_下载异常说明.txt',new ReadableStream({start(c){c.enqueue(b);c.close();}}));}
 const centralStart=offset;for(const e of entries){const h=record(46,[[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x808,2],[12,time,2],[14,date,2],[16,e.crc,4],[20,e.size,4],[24,e.size,4],[28,e.name.length,2],[42,e.offset,4]]);offset+=h.length+e.name.length;yield h;yield e.name;}
 yield record(22,[[0,0x06054b50,4],[8,entries.length,2],[10,entries.length,2],[12,offset-centralStart,4],[16,centralStart,4]]);
}
export function zipStream(files:AudioFile[]){const it=zipFiles(files);return new ReadableStream<Uint8Array>({async pull(c){try{const {done,value}=await it.next();if(done)c.close();else c.enqueue(value);}catch(e){c.error(e);}},async cancel(){await it.return(undefined);}});}
