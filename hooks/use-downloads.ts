"use client";

import {useCallback,useEffect,useRef,useState} from 'react';
import {toast} from 'sonner';
import type {AudioFile} from '@/lib/audio';

type TransferState='waiting'|'preparing'|'transferring'|'completed'|'partial'|'failed';
type TransferSnapshot={id:string;kind:'file'|'bundle';title:string;state:TransferState;bytes:number;totalBytes?:number;completedFiles:number;totalFiles:number;error?:string;failures?:string[]};
export type DownloadTask=Omit<TransferSnapshot,'id'|'state'>&{clientId:string;id?:string;state:TransferState|'connecting'|'unavailable';fileUrl?:string;extract?:boolean;statusWarning?:string};
type Runtime={key:string;done:boolean;frame?:HTMLIFrameElement;timer?:ReturnType<typeof setTimeout>;controllers:Set<AbortController>;errors:number};
const terminal=new Set(['completed','partial','failed','unavailable']);
export const downloading=(task:DownloadTask)=>!terminal.has(task.state);

export function downloadUrl(f:AudioFile){
  return '/api/download?'+new URLSearchParams({url:f.url,source:f.source,filename:f.filename,mode:f.mode||'direct',...(f.duration?{duration:String(f.duration)}:{})});
}

export function downloadLabel(task:DownloadTask){
  if(task.state==='connecting'||task.state==='waiting')return '正在准备下载';
  if(task.state==='preparing')return task.kind==='bundle'?'正在准备压缩包':task.extract?'正在提取完整音轨':'正在连接音频';
  if(task.state==='transferring')return task.kind==='bundle'?'正在打包并传输':'正在下载';
  if(task.state==='completed')return '传输完成';
  if(task.state==='partial')return '部分音频下载失败';
  if(task.state==='unavailable')return '无法获取下载状态';
  return '下载失败';
}

export function useDownloads(){
  const [tasks,setTasks]=useState<DownloadTask[]>([]);
  const running=useRef(new Map<string,Runtime>()),serial=useRef(0),mounted=useRef(true),cleanupTimers=useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(()=>{
    mounted.current=true;
    return()=>{
      mounted.current=false;
      for(const task of running.current.values()){
        task.done=true;clearTimeout(task.timer);
        for(const controller of task.controllers)controller.abort();
        task.frame?.remove();
      }
      running.current.clear();
      for(const timer of cleanupTimers.current)clearTimeout(timer);
      document.querySelectorAll('iframe[data-shiyin-download]').forEach(frame=>frame.remove());
    };
  },[]);

  const launch=useCallback(async(kind:'file'|'bundle',files:AudioFile[])=>{
    const key=kind==='bundle'?'bundle':'file:'+files[0].url;
    if(running.current.has(key))return;
    if(running.current.size>=3){toast.error('已有 3 个下载正在处理，请等其中一个完成后再试');return;}
    // A DOM target name needs uniqueness, not a secure-context-only UUID.
    const clientId=Date.now().toString(36)+'-'+(++serial.current);
    const runtime:Runtime={key,done:false,controllers:new Set(),errors:0};
    running.current.set(key,runtime);
    const title=(kind==='bundle'?`批量下载 · ${files.length} 个音频`:files[0].title).trim().slice(0,200)||'音频下载';
    const initial:DownloadTask={clientId,kind,title,state:'connecting',bytes:0,completedFiles:0,totalFiles:files.length,...(kind==='file'?{fileUrl:files[0].url,extract:files[0].mode==='extract'}:{})};
    setTasks(previous=>[initial,...previous.filter(task=>downloading(task)||previous.indexOf(task)<7)]);
    function update(change:Partial<DownloadTask>){if(mounted.current)setTasks(previous=>previous.map(task=>task.clientId===clientId?{...task,...change}:task));}
    function finish(streamEnded=true){
      runtime.done=true;clearTimeout(runtime.timer);running.current.delete(key);
      for(const controller of runtime.controllers)controller.abort();
      // Attachment navigations have no reliable load event. Keep the frame until
      // the server reports the stream ended, then allow the browser to settle.
      if(runtime.frame){const frame=runtime.frame;const timer=setTimeout(()=>{frame.remove();cleanupTimers.current.delete(timer);},streamEnded?30_000:2*60*60*1000+30_000);cleanupTimers.current.add(timer);}
    }
    function fail(error:string){if(runtime.done)return;update({state:'failed',error,statusWarning:undefined});finish();toast.error(error);}
    async function request(url:string,init?:RequestInit){
      const controller=new AbortController();runtime.controllers.add(controller);
      const timeout=setTimeout(()=>controller.abort(),15_000);
      try{
        const response=await fetch(url,{...init,cache:'no-store',signal:controller.signal});
        // Proxies can return HTML for missing routes. Inspect HTTP status first,
        // and keep response-body reading inside the same timeout as the headers.
        if(response.status===404){await response.body?.cancel();return {ok:false,status:404,data:{error:'服务器缺少下载状态接口，请更新服务器版本'} as TransferSnapshot&{error?:string}};}
        if(!response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();throw new Error(`下载服务返回异常（HTTP ${response.status}），请检查服务器`);}
        const data=await response.json() as TransferSnapshot&{error?:string};
        return {ok:response.ok,status:response.status,data};
      }
      finally{clearTimeout(timeout);runtime.controllers.delete(controller);}
    }
    try{
      const response=await request('/api/transfers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,title,totalFiles:files.length})});
      const created=response.data;
      if(!response.ok)throw new Error(created.error||'无法创建下载任务');
      if(typeof created.id!=='string'||!created.id)throw new Error('服务器未返回下载任务，请更新服务器版本');
      if(runtime.done)return;
      update({...created,statusWarning:undefined});
      const frame=document.createElement('iframe');frame.hidden=true;frame.name='shiyin-download-'+clientId;frame.dataset.shiyinDownload='';frame.title='音频下载';runtime.frame=frame;
      frame.addEventListener('load',()=>{
        if(runtime.done)return;
        try{
          const message=frame.contentDocument?.body?.textContent?.trim();
          if(!message)return; // Initial about:blank and attachment navigation are not completion signals.
          let error=message;try{const body=JSON.parse(message) as {error?:string};error=body.error||message;}catch{}
          fail(error.slice(0,220));
        }catch{/* A download is tracked through the status API, not iframe events. */}
      });
      document.body.appendChild(frame);
      if(kind==='bundle'){
        const form=document.createElement('form');form.method='POST';form.action='/api/bundle';form.target=frame.name;
        for(const [name,value] of [['manifest',JSON.stringify(files)],['transferId',created.id]]){
          const field=document.createElement('input');field.type='hidden';field.name=name;field.value=value;form.appendChild(field);
        }
        document.body.appendChild(form);try{form.submit();}finally{form.remove();}
      }else frame.src=downloadUrl(files[0])+'&transferId='+encodeURIComponent(created.id);

      const submittedAt=Date.now();
      async function poll(){
        if(runtime.done)return;
        try{
          const response=await request('/api/transfers?id='+encodeURIComponent(created.id));
          const snapshot=response.data;
          if(runtime.done)return;
          if(response.status===404){update({state:'unavailable',error:'下载状态已失效。请先查看浏览器下载列表，确认保存结果后再重试。'});finish(false);toast.warning('下载状态已失效，请查看浏览器下载列表');return;}
          if(!response.ok)throw new Error(snapshot.error||'暂时无法获取下载状态');
          if(snapshot.state==='waiting'&&Date.now()-submittedAt>30_000){update({state:'unavailable',error:'浏览器尚未发起下载。请允许此网站下载文件，查看浏览器提示后再试。'});finish(false);toast.warning('请允许此网站下载文件后再试');return;}
          runtime.errors=0;update({...snapshot,statusWarning:undefined});
          if(terminal.has(snapshot.state)){
            finish();
            if(snapshot.state==='failed')toast.error(snapshot.error||'下载失败，请重试');
            else if(snapshot.state==='partial')toast.warning('压缩包已传输，部分音频失败。请查看异常说明后重试。',{duration:7000});
            else toast.success('传输完成，请在浏览器下载列表查看保存结果。',{duration:6000});
            return;
          }
        }catch{
          if(runtime.done)return;
          runtime.errors++;
          if(runtime.errors>=3)update({statusWarning:'状态连接中断，正在重试。下载可能仍在继续，请查看浏览器下载列表。'});
        }
        if(!runtime.done)runtime.timer=setTimeout(poll,runtime.errors?3000:1200);
      }
      runtime.timer=setTimeout(poll,400);
    }catch(error){fail(error instanceof Error&&error.name!=='AbortError'?error.message:'下载服务连接失败，请检查服务器是否正常运行后重试');}
  },[]);

  return {tasks,startDownload:(file:AudioFile)=>launch('file',[file]),startBundle:(files:AudioFile[])=>launch('bundle',files)};
}
