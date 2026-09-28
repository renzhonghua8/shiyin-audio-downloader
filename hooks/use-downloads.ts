"use client";

import {useCallback,useEffect,useRef,useState} from 'react';
import {toast} from 'sonner';
import type {AudioFile} from '@/lib/audio';
import {BrowserHelperError,hasBrowserDelivery,isBrowserAudioFile,type BrowserDownloadSnapshot,type CollectedAudioFile} from '@/lib/browser-helper';
import type {BrowserHelperClient} from './use-browser-helper';

type TransferState=BrowserDownloadSnapshot['state'];
type TransferSnapshot=BrowserDownloadSnapshot;
export type DownloadTask=Omit<TransferSnapshot,'id'|'state'>&{clientId:string;id?:string;state:TransferState|'connecting'|'unavailable';delivery:'server'|'browser';fileUrl?:string;fileUrls:string[];extract?:boolean;statusWarning?:string};
type Runtime={key:string;files:Set<string>;done:boolean;frame?:HTMLIFrameElement;timer?:ReturnType<typeof setTimeout>;controllers:Set<AbortController>;errors:number};
const terminal=new Set(['completed','partial','failed','unavailable']);
export const downloading=(task:DownloadTask)=>!terminal.has(task.state);

export function downloadUrl(file:AudioFile){
  if(hasBrowserDelivery(file))throw new Error('浏览器音频请通过浏览器助手保存，或打开来源试听');
  return '/api/download?'+new URLSearchParams({url:file.url,source:file.source,filename:file.filename,mode:file.mode||'direct',...(file.duration?{duration:String(file.duration)}:{})});
}
export function downloadLabel(task:DownloadTask){
  if(task.state==='connecting'||task.state==='waiting')return '正在准备下载';
  if(task.state==='preparing')return task.kind==='bundle'?(task.delivery==='browser'?'正在准备逐个保存':'正在准备压缩包'):task.extract?'正在提取完整音轨':'正在连接音频';
  if(task.state==='transferring')return task.kind==='bundle'?(task.delivery==='browser'?'正在逐个保存':'正在打包并传输'):'正在下载';
  if(task.state==='completed')return task.delivery==='browser'?'已保存到浏览器下载列表':'传输完成';
  if(task.state==='partial')return '部分音频下载失败';
  if(task.state==='unavailable')return '无法获取下载状态';
  return '下载失败';
}

export function useDownloads(helper:BrowserHelperClient){
  const [tasks,setTasks]=useState<DownloadTask[]>([]);
  const running=useRef(new Map<string,Runtime>()),serial=useRef(0),mounted=useRef(true),cleanupTimers=useRef(new Set<ReturnType<typeof setTimeout>>()),retryFiles=useRef(new Map<string,CollectedAudioFile[]>());
  const {connected,download:browserDownload,downloadBatch:browserBatch,getDownloadStatus:browserStatus}=helper;
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

  const launch=useCallback(async(kind:'file'|'bundle',files:CollectedAudioFile[])=>{
    if(!files.length)return;
    const browser=hasBrowserDelivery(files[0]),delivery=browser?'browser':'server';
    if(files.some(file=>hasBrowserDelivery(file)!==browser)){toast.error('浏览器音频和服务器音频需要分别保存');return;}
    if([...running.current.values()].some(task=>files.some(file=>task.files.has(file.url)))){toast('所选音频已有下载正在处理，请等待完成');return;}
    const key=delivery+':'+(kind==='bundle'?'bundle':files[0].url);
    if(running.current.has(key)){toast('已有同一种保存方式的批量任务正在处理，请等待完成后重试');return;}
    if(running.current.size>=3){toast.error('已有 3 个下载正在处理，请等其中一个完成后再试');return;}
    const clientId=Date.now().toString(36)+'-'+(++serial.current);
    const runtime:Runtime={key,files:new Set(files.map(file=>file.url)),done:false,controllers:new Set(),errors:0};
    running.current.set(key,runtime);
    retryFiles.current.set(clientId,files);
    while(retryFiles.current.size>30)retryFiles.current.delete(retryFiles.current.keys().next().value!);
    const title=(kind==='bundle'?(browser?'浏览器逐个保存':'服务器 ZIP')+' · '+files.length+' 个音频':files[0].title).trim().slice(0,200)||'音频下载';
    const initial:DownloadTask={clientId,kind,title,delivery,fileUrls:files.map(file=>file.url),state:'connecting',bytes:0,completedFiles:0,totalFiles:files.length,...(kind==='file'?{fileUrl:files[0].url,extract:files[0].mode==='extract'}:{})};
    setTasks(previous=>[initial,...previous.filter(task=>downloading(task)||previous.indexOf(task)<7)]);
    function update(change:Partial<DownloadTask>){if(mounted.current)setTasks(previous=>previous.map(task=>task.clientId===clientId?{...task,...change}:task));}
    function finish(streamEnded=true){
      if(runtime.done)return;
      runtime.done=true;clearTimeout(runtime.timer);running.current.delete(key);
      for(const controller of runtime.controllers)controller.abort();
      if(runtime.frame){const frame=runtime.frame;const timer=setTimeout(()=>{frame.remove();cleanupTimers.current.delete(timer);},streamEnded?30_000:2*60*60*1000+30_000);cleanupTimers.current.add(timer);}
    }
    function fail(error:string){if(runtime.done)return;update({state:'failed',error,statusWarning:undefined});finish();toast.error(error);}
    function ended(snapshot:TransferSnapshot){
      update({...snapshot,statusWarning:undefined});finish();
      if(snapshot.state==='failed')toast.error(snapshot.error||'下载失败，请重试');
      else if(snapshot.state==='partial')toast.warning(browser?'部分浏览器下载失败，请查看状态后重新下载失败的音频。':'压缩包已传输，部分音频失败。请查看异常说明后重试。',{duration:7000});
      else toast.success(browser?'保存完成，请在浏览器下载列表查看音频。':'传输完成，请在浏览器下载列表查看保存结果。',{duration:6000});
    }
    async function request(url:string,init?:RequestInit){
      const controller=new AbortController();runtime.controllers.add(controller);
      const timeout=setTimeout(()=>controller.abort(),15_000);
      try{
        const response=await fetch(url,{...init,cache:'no-store',signal:controller.signal});
        if(response.status===404){await response.body?.cancel();return {ok:false,status:404,data:{error:'服务器缺少下载状态接口，请更新服务器版本'} as TransferSnapshot};}
        if(!response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();throw new Error('下载服务返回异常（HTTP '+response.status+'），请检查服务器');}
        return {ok:response.ok,status:response.status,data:await response.json() as TransferSnapshot};
      }finally{clearTimeout(timeout);runtime.controllers.delete(controller);}
    }
    try{
      if(browser){
        if(!connected)throw new Error('浏览器助手未连接。请连接当前网站，然后重试；若助手记录已失效，请重新扫描来源。');
        if(!files.every(isBrowserAudioFile))throw new Error('浏览器音频记录无效，请重新扫描来源后重试');
        const created=kind==='bundle'?await browserBatch(files.map(file=>file.helperId)):await browserDownload(files[0].helperId);
        if(runtime.done)return;
        update({...created,statusWarning:undefined});
        if(terminal.has(created.state)){ended(created);return;}
        async function pollBrowser(){
          if(runtime.done)return;
          try{
            const snapshot=await browserStatus(created.id);
            if(runtime.done)return;
            runtime.errors=0;update({...snapshot,statusWarning:undefined});
            if(terminal.has(snapshot.state)){ended(snapshot);return;}
          }catch(error){
            if(runtime.done)return;
            runtime.errors++;
            const expired=error instanceof BrowserHelperError&&/EXPIRED|NOT_FOUND|INVALID_JOB|DISPOSED|UNAVAILABLE/.test(error.code);
            if(expired||runtime.errors>=6){
              const message=(error instanceof Error?error.message:'浏览器助手连接中断')+'。请查看浏览器下载列表确认结果，重新连接助手后再重试；音频记录失效时请重新扫描。';
              update({state:'unavailable',error:message,statusWarning:undefined});finish(false);toast.warning('无法读取助手下载状态，请先查看浏览器下载列表');return;
            }
            update({statusWarning:'正在重新连接浏览器助手。下载可能仍在继续，请查看浏览器下载列表。'});
          }
          if(!runtime.done)runtime.timer=setTimeout(pollBrowser,runtime.errors?3000:1200);
        }
        runtime.timer=setTimeout(pollBrowser,400);
        return;
      }
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
          if(!message)return;
          let error=message;try{const body=JSON.parse(message) as {error?:string};error=body.error||message;}catch{}
          fail(error.slice(0,220));
        }catch{/* Attachment navigation is tracked with the status API. */}
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
      async function pollServer(){
        if(runtime.done)return;
        try{
          const response=await request('/api/transfers?id='+encodeURIComponent(created.id)),snapshot=response.data;
          if(runtime.done)return;
          if(response.status===404){update({state:'unavailable',error:'下载状态已失效。请先查看浏览器下载列表，确认保存结果后再重试。'});finish(false);toast.warning('下载状态已失效，请查看浏览器下载列表');return;}
          if(!response.ok)throw new Error(snapshot.error||'暂时无法获取下载状态');
          if(snapshot.state==='waiting'&&Date.now()-submittedAt>30_000){update({state:'unavailable',error:'浏览器尚未发起下载。请允许此网站下载文件，查看浏览器提示后再试。'});finish(false);toast.warning('请允许此网站下载文件后再试');return;}
          runtime.errors=0;update({...snapshot,statusWarning:undefined});
          if(terminal.has(snapshot.state)){ended(snapshot);return;}
        }catch{
          if(runtime.done)return;
          runtime.errors++;
          if(runtime.errors>=3)update({statusWarning:'状态连接中断，正在重试。下载可能仍在继续，请查看浏览器下载列表。'});
          if(runtime.errors>=10){update({state:'unavailable',error:'下载状态连接持续中断。请先查看浏览器下载列表，再决定是否重试。'});finish(false);return;}
        }
        if(!runtime.done)runtime.timer=setTimeout(pollServer,runtime.errors?3000:1200);
      }
      runtime.timer=setTimeout(pollServer,400);
    }catch(error){
      const detail=error instanceof Error&&error.name!=='AbortError'?error.message:'下载服务连接失败，请检查服务器或浏览器助手后重试';
      fail(browser&&error instanceof BrowserHelperError&&/EXPIRED|STALE|INVALID_FILE|NOT_FOUND/.test(error.code)?detail+'。请重新扫描来源后重试下载。':detail);
    }
  },[connected,browserDownload,browserBatch,browserStatus]);

  const startBundle=useCallback(async(input:CollectedAudioFile[])=>{
    const files=[...new Map(input.map(file=>[file.url,file])).values()];
    if(!files.length)return;
    if(files.length>100){toast.error('每次批量下载最多 100 个音频，请减少选择');return;}
    const browser=files.filter(hasBrowserDelivery),server=files.filter(file=>!hasBrowserDelivery(file));
    if(server.reduce((total,file)=>total+file.size,0)>3*1024**3){toast.error('服务器压缩包超过 3 GB，请减少选择');return;}
    const groups=[server,browser].filter(group=>group.length);
    if(groups.some(group=>running.current.has((hasBrowserDelivery(group[0])?'browser':'server')+':bundle'))){toast('已有同一种保存方式的批量任务正在处理，请等待完成后重试');return;}
    if([...running.current.values()].some(task=>files.some(file=>task.files.has(file.url)))){toast('所选音频已有下载正在处理，请等待完成');return;}
    if(running.current.size+groups.length>3){toast.error('混合批量下载需要 '+groups.length+' 个空闲任务位，请等当前下载完成后重试');return;}
    if(browser.length&&!connected){toast.error('请先连接浏览器助手，或仅选择服务器音频');return;}
    if(browser.length&&!browser.every(isBrowserAudioFile)){toast.error('浏览器音频记录失效，请重新扫描来源');return;}
    if(server.length&&browser.length)toast('将分别保存一个服务器 ZIP 和浏览器助手逐个保存的音频。',{duration:6500});
    else if(browser.length)toast('浏览器助手将逐个保存音频，本次不会生成 ZIP。',{duration:5500});
    await Promise.all(groups.map(group=>launch('bundle',group)));
  },[launch,connected]);
  const startDownload=useCallback((file:CollectedAudioFile)=>launch('file',[file]),[launch]);
  const retryTask=useCallback((task:DownloadTask)=>{
    const files=retryFiles.current.get(task.clientId);
    if(!files){toast.error('任务记录已失效，请在音频列表重新选择下载');return;}
    if(task.state==='unavailable')toast('请先确认浏览器下载列表没有仍在进行的同一任务，以免重复保存。',{duration:6000});
    return launch(task.kind,files);
  },[launch]);
  return {tasks,startDownload,startBundle,retryTask};
}
