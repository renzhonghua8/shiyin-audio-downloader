import {randomUUID} from 'node:crypto';

export type TransferKind='file'|'bundle';
export type TransferState='waiting'|'preparing'|'transferring'|'completed'|'partial'|'failed';
export type TransferStatus={
 id:string;kind:TransferKind;title:string;state:TransferState;bytes:number;totalBytes?:number;
 completedFiles:number;totalFiles:number;failures:string[];error?:string;createdAt:number;updatedAt:number;
};
const terminal=new Set<TransferState>(['completed','partial','failed']);
const retention=15*60*1000,activeLifetime=2*60*60*1000,maxTransfers=300;
const globals=globalThis as typeof globalThis&{__shiyinTransfers?:Map<string,TransferStatus>};
const transfers=globals.__shiyinTransfers??=new Map<string,TransferStatus>();
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function message(error:unknown){return (error instanceof Error?error.message:String(error||'下载失败')).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').slice(0,500);}
function snapshot(t:TransferStatus):TransferStatus{return {...t,failures:[...t.failures]};}
function assertActive(t:TransferStatus){if(t.state==='failed')throw new Error(t.error||'下载已中断');}
function clean(){const now=Date.now();for(const [id,t] of transfers){
 if(terminal.has(t.state)){if(now-t.updatedAt>=retention)transfers.delete(id);}
 else if(now-t.createdAt>=activeLifetime){t.state='failed';t.error='下载任务已超过两小时，请重新下载';t.updatedAt=now;}
}}
function fileCount(kind:TransferKind,count:number){if(!Number.isInteger(count)||count<1||count>100||(kind==='file'&&count!==1))throw new Error('下载文件数量无效');return count;}
export function validTransferId(id:string){return idPattern.test(id);}
export function createTransfer(kind:TransferKind,title:string,totalFiles=1){
 clean();if(kind!=='file'&&kind!=='bundle')throw new Error('无效下载类型');
 if(typeof title!=='string'||!title.trim()||title.trim().length>200||/[\x00-\x1f]/.test(title))throw new Error('下载标题应为 1–200 个字符');
 fileCount(kind,totalFiles);if(transfers.size>=maxTransfers)throw new Error('当前下载任务过多，请稍后重试');
 const now=Date.now(),t:TransferStatus={id:randomUUID(),kind,title:title.trim(),state:'waiting',bytes:0,completedFiles:0,totalFiles,failures:[],createdAt:now,updatedAt:now};
 transfers.set(t.id,t);return snapshot(t);
}
export function getTransfer(id:string){clean();const t=transfers.get(id);return t?snapshot(t):undefined;}
export function beginTransfer(id:string,kind:TransferKind,totalFiles?:number){
 clean();const t=transfers.get(id);if(!t)throw new Error('下载任务不存在或已过期，请重新点击下载');
 if(t.kind!==kind)throw new Error('下载任务类型不匹配');
 if(t.state!=='waiting')throw new Error('该下载任务已经开始，请重新点击下载');
 if(totalFiles!==undefined)t.totalFiles=fileCount(kind,totalFiles);
 t.state='preparing';t.updatedAt=Date.now();return snapshot(t);
}
export function failTransfer(id:string,error:unknown){
 clean();const t=transfers.get(id);if(!t||terminal.has(t.state))return;
 t.state='failed';t.error=message(error);t.updatedAt=Date.now();
}
export function recordTransferFile(id:string,filename:string,error?:string){
 clean();const t=transfers.get(id);if(!t||terminal.has(t.state))return;
 t.completedFiles=Math.min(t.totalFiles,t.completedFiles+1);
 if(error&&t.failures.length<100)t.failures.push((filename+'：'+message(error)).slice(0,650));
 t.updatedAt=Date.now();
}
export function setTransferTotalFiles(id:string,totalFiles:number){
 clean();const t=transfers.get(id);if(!t||terminal.has(t.state))return;
 t.totalFiles=fileCount(t.kind,totalFiles);t.updatedAt=Date.now();
}
export function finishTransfer(id:string,failures?:string[]){
 clean();const t=transfers.get(id);if(!t||terminal.has(t.state))return;
 if(failures)t.failures.push(...failures.slice(0,100-t.failures.length).map(message));
 if(t.kind==='file')t.completedFiles=1;
 t.state=t.failures.length?'partial':'completed';t.updatedAt=Date.now();
}
export function wrapTransferStream(body:ReadableStream<Uint8Array>,id:string,expectedBytes?:number){
 clean();const t=transfers.get(id);if(!t||terminal.has(t.state))throw new Error('下载任务不可用，请重新下载');
 if(expectedBytes!==undefined&&(!Number.isFinite(expectedBytes)||expectedBytes<0))throw new Error('下载大小无效');
 if(expectedBytes)t.totalBytes=expectedBytes;
 const reader=body.getReader();let finished=false,timer:ReturnType<typeof setTimeout>|undefined;
 const stopTimer=()=>{if(timer)clearTimeout(timer);};
 return new ReadableStream<Uint8Array>({
  start(controller){
   timer=setTimeout(()=>{if(finished)return;finished=true;const error=new Error('下载任务已超过两小时，请重新下载');failTransfer(id,error);controller.error(error);void reader.cancel(error).catch(()=>{});},Math.max(1,activeLifetime-(Date.now()-t.createdAt)));
   timer.unref?.();
  },
  async pull(controller){try{
   if(finished)return;
   assertActive(t);
   const {done,value}=await reader.read();if(finished)return;
   assertActive(t);
   if(done){
    if(expectedBytes&&t.bytes!==expectedBytes)throw new Error('文件传输不完整，请重新下载');
    finished=true;stopTimer();finishTransfer(id);controller.close();
   }else{t.bytes+=value.byteLength;t.state='transferring';t.updatedAt=Date.now();controller.enqueue(value);}
  }catch(error){if(finished)return;finished=true;stopTimer();failTransfer(id,error);controller.error(error);await reader.cancel(error).catch(()=>{});}},
  async cancel(reason){if(!finished){finished=true;stopTimer();failTransfer(id,'下载已取消或连接已断开');}await reader.cancel(reason).catch(()=>{});},
 });
}
