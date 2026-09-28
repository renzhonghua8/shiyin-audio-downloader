"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {AudioLines,ArrowDownToLine,Link2,Search,Square,FolderDown,Headphones,FileAudio,ExternalLink,LoaderCircle,Info,CheckCircle2,AlertCircle,Puzzle} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {Progress} from '@/components/ui/progress';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {Toaster,toast} from 'sonner';
import {BrowserHelperError,hasBrowserDelivery,isBilibiliPage,type CollectedAudioFile} from '@/lib/browser-helper';
import {useBrowserHelper} from '@/hooks/use-browser-helper';
import {useDownloads,downloadUrl,downloadLabel,downloading,type DownloadTask} from '@/hooks/use-downloads';

type PageResult={url:string;title:string;state:'waiting'|'scanning'|'done'|'error'|'paused';count:number;warnings:string[]};
const examples='https://www.xiaoyuzhoufm.com/episode/6a912c69f03e74ee6b01234f\nhttps://www.xiaoyuzhoufm.com/episode/6a97a9daa0210c197dcc1ba0\nhttps://www.bilibili.com/video/BV1hky1B4EW4/';
const bytes=(n:number)=>n?'大小 '+(n/1024/1024).toFixed(1)+' MB':'大小未知';
function parseInput(text:string){return [...new Set((text.match(/https?:\/\/[^\s<>"\[\]()]+/g)||[]).map(url=>url.replace(/[，。；]+$/,'')))];}
const transferred=(n:number)=>(n/1024/1024).toFixed(1)+' MB';
function audioIdentity(file:CollectedAudioFile){
 if(!hasBrowserDelivery(file))return file.url;
 const source=new URL(file.source);return 'browser:'+source.pathname+'?p='+(source.searchParams.get('p')||'1');
}
function DownloadIcon({task}:{task:DownloadTask}){return downloading(task)?<LoaderCircle className="spin" size={17}/>:task.state==='completed'?<CheckCircle2 size={17}/>:<AlertCircle size={17}/>;}
function DownloadStatus({task,onRetry}:{task:DownloadTask;onRetry:(task:DownloadTask)=>void}){
 const percent=task.totalBytes&&task.totalBytes>0?Math.min(100,task.bytes/task.totalBytes*100):undefined;
 return <div className={'transfer-card transfer-'+task.state} data-download-state={task.state}>
  <DownloadIcon task={task}/><div className="transfer-content"><div className="transfer-title"><strong>{task.title}</strong><span>{downloadLabel(task)}</span></div>
  <p className="transfer-detail">{task.delivery==='browser'?'浏览器助手保存':'服务器传输'}{task.kind==='bundle'&&' · '+(task.delivery==='browser'?'已保存 ':'已处理 ')+task.completedFiles+' / '+task.totalFiles+' 个音频'} · {transferred(task.bytes)}{task.totalBytes?' / '+transferred(task.totalBytes):''}{task.state==='completed'&&' · 请在浏览器下载列表查看保存结果'}</p>
  {downloading(task)&&percent!==undefined&&<Progress value={percent} aria-label={task.title+'传输进度'}/>}
  {task.error&&<p className="transfer-error">{task.error}</p>}{task.statusWarning&&<p className="transfer-error">{task.statusWarning}</p>}
  {task.state==='partial'&&<p className="transfer-error">{task.failures?.slice(0,2).join('；')||(task.delivery==='browser'?'请在浏览器下载列表查看结果，重新扫描并下载失败的音频。':'请查看压缩包中的「_下载异常说明.txt」，重新下载失败的音频。')}</p>}
  {['failed','unavailable'].includes(task.state)&&<Button variant="ghost" size="sm" className="transfer-retry" onClick={()=>onRetry(task)}>重试此任务</Button>}
  </div>
 </div>;
}

export default function Home(){
 const [input,setInput]=useState(examples),[files,setFiles]=useState<CollectedAudioFile[]>([]),[pages,setPages]=useState<PageResult[]>([]),[selected,setSelected]=useState<Set<string>>(new Set()),[busy,setBusy]=useState(false),[playing,setPlaying]=useState<string|null>(null),[stopped,setStopped]=useState(false),[paused,setPaused]=useState(false);
 const abort=useRef<AbortController|null>(null),active=useRef(false),audio=useRef<HTMLAudioElement|null>(null),resumeQueue=useRef<{links:string[];files:CollectedAudioFile[]}|null>(null);
 const helper=useBrowserHelper();
 const {connected:helperConnected,scan:browserScan,cancelPausedScan}=helper;
 const {tasks,startDownload,startBundle,retryTask}=useDownloads(helper),activeDownloads=tasks.filter(downloading),batchTask=tasks.find(task=>task.kind==='bundle'&&downloading(task)),batchBusy=!!batchTask;
 const urls=parseInput(input),completed=pages.filter(page=>page.state==='done'||page.state==='error').length,selectedFiles=files.filter(file=>selected.has(file.url)),total=files.reduce((n,file)=>n+file.size,0),extractCount=files.filter(file=>file.mode==='extract').length,browserCount=files.filter(hasBrowserDelivery).length;
 const scan=useCallback(async(text:string,resume=false)=>{
  const pending=resume?resumeQueue.current:null;
  const links=pending?.links||parseInput(text);
  if(!links.length){toast.error('请粘贴至少一个完整网页链接');return {error:'缺少链接'};}
  if(links.length>100){toast.error('每次最多扫描 100 个网页，请分批添加');return {error:'链接过多'};}
  if(active.current)return {error:'已有扫描正在进行'};
  if(resume&&!helperConnected){toast.error('请先重新连接浏览器助手，再继续扫描');return {error:'浏览器助手未连接'};}
  if(!resume){try{await cancelPausedScan();}catch(error){const message=error instanceof Error?error.message:'无法结束上次助手扫描';toast.error(message);return {error:message};}}
  if(active.current)return {error:'已有扫描正在进行'};
  active.current=true;const controller=new AbortController();abort.current=controller;
  setBusy(true);setStopped(false);setPaused(false);resumeQueue.current=null;
  audio.current?.pause();setPlaying(null);
  const result:CollectedAudioFile[]=pending?[...pending.files]:[],seen=new Set(result.map(audioIdentity));
  let index=0,needsUser=false;
  if(pending){
   setPages(previous=>previous.map(page=>links.includes(page.url)?{...page,state:'waiting',warnings:[]}:page));
  }else{
   setFiles([]);setSelected(new Set());
   setPages(links.map(url=>({url,title:(()=>{try{return new URL(url).hostname;}catch{return url;}})(),state:'waiting',count:0,warnings:[]})));
  }
  function patch(url:string,change:Partial<PageResult>){setPages(previous=>previous.map(page=>page.url===url?{...page,...change}:page));}
  // One browser lane preserves a page that needs manual login or verification.
  const workers=helperConnected&&links.some(isBilibiliPage)?1:Math.min(3,links.length);
  try{
   await Promise.all(Array.from({length:workers},async()=>{
    while(index<links.length&&!controller.signal.aborted&&!needsUser){
     const position=index++,url=links[position];patch(url,{state:'scanning'});
     try{
      let data:{files:CollectedAudioFile[];title:string;warnings?:string[]};
      if(helperConnected&&isBilibiliPage(url)){
       data=await browserScan(url,{signal:controller.signal});
      }else{
       const response=await fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url}),signal:controller.signal});
       const value=await response.json() as {error?:string;files:CollectedAudioFile[];title:string;warnings?:string[]};
       if(!response.ok)throw new Error(value.error||'扫描失败');
       if(!Array.isArray(value.files)||typeof value.title!=='string')throw new Error('扫描服务未返回有效结果，请更新服务器版本');
       data=value;
      }
      if(controller.signal.aborted)break;
      const additions=data.files.filter(file=>{const identity=audioIdentity(file);if(seen.has(identity))return false;seen.add(identity);return true;});
      result.push(...additions);setFiles([...result]);setSelected(previous=>new Set([...previous,...additions.map(file=>file.url)]));
      patch(url,{state:'done',title:data.title,count:data.files.length,warnings:data.warnings||[]});
     }catch(error){
      if(controller.signal.aborted)break;
      const message=error instanceof Error?error.message:'扫描失败';
      if(error instanceof BrowserHelperError&&['NEEDS_USER','BUSY'].includes(error.code)){
       needsUser=true;resumeQueue.current={links:links.slice(position),files:[...result]};setPaused(true);
       patch(url,{state:'paused',warnings:[message+'。请在已打开的来源页面手动处理，再点击“完成验证后继续扫描”。']});
       setPages(previous=>previous.map(page=>links.slice(position+1).includes(page.url)?{...page,state:'paused',warnings:['等待当前来源页面完成手动操作，后续链接尚未扫描']}:page));
       toast.warning('扫描已暂停，请先在来源页面完成手动操作。',{duration:8000});
       break;
      }
      patch(url,{state:'error',warnings:[message]});
     }
    }
   }));
   if(controller.signal.aborted){
    setStopped(true);
    setPages(previous=>previous.map(page=>['waiting','scanning'].includes(page.state)?{...page,state:'error',warnings:['扫描已停止，可重新扫描']}:page));
    toast('扫描已停止，已找到的音频仍可下载');
   }else if(!needsUser)toast.success('扫描完成，找到 '+result.length+' 个不同音频');
  }finally{
   setBusy(false);active.current=false;if(abort.current===controller)abort.current=null;
  }
  return {files:result.map(file=>({title:file.title,url:file.url,format:file.format,size:file.size,delivery:hasBrowserDelivery(file)?'browser':'server'})),pageCount:links.length,paused:needsUser};
 },[helperConnected,browserScan,cancelPausedScan]);
 useEffect(()=>{
  const lifecycle=new AbortController(),model=(document as unknown as {modelContext?:{registerTool:(tool:unknown,options:unknown)=>Promise<unknown>}}).modelContext;
  if(model?.registerTool)Promise.resolve(model.registerTool({name:'scan_audio_pages',description:'扫描网页音视频，通过已连接的浏览器助手识别哔哩哔哩完整公开音轨；更新结果但不开始下载。',inputSchema:{type:'object',properties:{urls:{type:'array',items:{type:'string'},minItems:1,maxItems:100}},required:['urls'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:async(arg:unknown)=>{
   const value=arg as {urls?:unknown};
   if(!Array.isArray(value.urls)||!value.urls.length||value.urls.length>100||value.urls.some(url=>typeof url!=='string'||!/^https?:\/\//.test(url)))throw new Error('请输入 1–100 个完整网页链接');
   const text=value.urls.join('\n');setInput(text);return scan(text);
  }},{signal:lifecycle.signal})).catch(()=>{});
  return()=>lifecycle.abort();
 },[scan]);
 useEffect(()=>()=>{abort.current?.abort();},[]);
 function changeInput(value:string){
  setInput(value);resumeQueue.current=null;setPaused(false);
  void cancelPausedScan().catch(error=>toast.error(error instanceof Error?error.message:'无法结束上次助手扫描，请重新连接后重试'));
 }
 async function stopPausedScan(){
  try{await cancelPausedScan();resumeQueue.current=null;setPaused(false);setStopped(true);setPages(previous=>previous.map(page=>page.state==='paused'?{...page,state:'error',warnings:['扫描已停止，可重新扫描']}:page));}
  catch(error){toast.error(error instanceof Error?error.message:'无法结束助手扫描，请重新连接后重试');}
 }
 function batch(){void startBundle(selectedFiles);}
 async function preview(file:CollectedAudioFile){
  if(hasBrowserDelivery(file)){audio.current?.pause();setPlaying(null);window.open(file.source,'_blank','noopener,noreferrer');return;}
  if(playing===file.url){audio.current?.pause();setPlaying(null);return;}
  setPlaying(file.url);
  if(audio.current){audio.current.src=downloadUrl(file)+'&preview=1';try{await audio.current.play();}catch{setPlaying(null);toast.error('浏览器无法播放此格式，可直接下载');}}
 }
 const notices=pages.filter(page=>page.state==='error'||page.state==='paused'||page.warnings.length);
 const selectionNote=selectedFiles.some(hasBrowserDelivery)?(selectedFiles.some(file=>!hasBrowserDelivery(file))?'分别保存：服务器音频 ZIP ＋浏览器音频逐个保存':'浏览器助手将逐个保存音频，不生成 ZIP'):'服务器音频保存为 ZIP，视频先提取声音';

 return <div className="app-shell"><Toaster position="bottom-right" richColors/><audio ref={audio} onEnded={()=>setPlaying(null)} onError={()=>{setPlaying(null);toast.error('试听加载失败，尝试直接下载');}} preload="none"/>
 <header className="topbar"><a href="/" className="brand" aria-label="拾音首页"><span className="brand-icon"><AudioLines size={23}/></span><strong>拾音</strong><span className="brand-en">AUDIO COLLECTOR</span></a><span className="top-caption"><Headphones size={16}/> 原始格式 · 原始音质</span></header>
 <main className="workspace"><div className="page-title"><div><p className="eyebrow">YOUR AUDIO, TO GO</p><h1>音频批量下载<span className="title-period">.</span></h1><p className="description">下载网页里的音频，也能提取视频里的完整声音。</p></div><div className="steps"><span><b>01</b> 粘贴链接</span><i/><span><b>02</b> 扫描音频</span><i/><span><b>03</b> 批量下载</span></div></div>
 <section className={'helper-panel helper-'+helper.status} aria-label="浏览器助手">
  <div className="helper-heading"><Puzzle size={20}/><div><h2>{helperConnected?'浏览器助手已连接':helper.status==='checking'?'正在检测浏览器助手':'连接 Chrome / Edge 浏览器助手'}</h2><p>{helperConnected?'哔哩哔哩将通过当前浏览器扫描并保存，其他音频仍由服务器处理。':'安装助手并授权当前网站，可使用浏览器里的正常播放页面识别哔哩哔哩音轨。'}</p></div>
   <Button variant="outline" size="sm" disabled={helper.status==='checking'} onClick={()=>void helper.refresh()}>重新检测</Button>
  </div>
  <details className="helper-install"><summary>{helperConnected?'查看安装与使用说明':'下载助手与安装说明'}</summary><ol>
   <li><a href="/shiyin-browser-helper.zip" download>下载浏览器助手 ZIP</a>，解压到一个固定文件夹。</li>
   <li>打开 Chrome 或 Edge 的扩展程序页面，启用“开发者模式”，点击“加载已解压的扩展程序”，选择刚解压的文件夹。</li>
   <li>回到本网站，点击浏览器工具栏中的“拾音浏览器助手”，按提示连接当前网站；允许授权后刷新网页或点击“重新检测”。</li>
   <li>连接后扫描哔哩哔哩链接。若来源页面要求登录或验证，请手动处理，再回这里继续扫描。</li>
  </ol><p>助手仅保存正常播放页面提供的完整公开音轨；付费、试听、受保护或地区限制仍会显示原因。登录信息留在你的浏览器，真实音轨地址不会发送给服务器。单个音轨最多 3 GB，请预留临时文件和最终音频的磁盘空间。</p></details>
 </section>
 <div className="main-grid"><section className="input-panel panel"><div className="panel-heading"><span className="section-number">01</span><h2>添加网页链接</h2><Link2 size={18}/></div><label className="input-label" htmlFor="page-urls">每行一个，也可以直接粘贴一整段链接</label><textarea id="page-urls" value={input} onChange={event=>changeInput(event.target.value)} disabled={busy} spellCheck={false} placeholder={'https://www.xiaoyuzhoufm.com/episode/…\nhttps://example.com/audio-page'}/><div className="input-meta"><span>{urls.length} 个不同链接</span><Button variant="ghost" size="sm" disabled={busy||!input} onClick={()=>changeInput('')}>清空</Button></div>
 <Button className="scan-button" disabled={!urls.length||busy} onClick={()=>void scan(input)}>{busy?<LoaderCircle className="spin"/>:<Search/>}{busy?'正在寻找音频…':'扫描全部链接'}{!busy&&<span className="key-hint">→</span>}</Button>
 {busy&&<Button variant="outline" className="stop-button" onClick={()=>abort.current?.abort()}><Square/>停止扫描</Button>}
 {paused&&!busy&&<Button variant="outline" className="resume-button" onClick={()=>void scan('',true)}>完成验证后继续扫描</Button>}
 {paused&&!busy&&<Button variant="ghost" className="stop-button" onClick={()=>void stopPausedScan()}>结束本次扫描</Button>}
 {helper.progress&&busy&&<p className="helper-progress" role="status" aria-live="polite">{helper.progress}</p>}
 <div className="support-note"><Info size={17}/><p>支持小宇宙、喜马拉雅、哔哩哔哩和公开媒体链接。优先获取独立音轨，视频仅保存声音。</p></div><div className="formats">{['MP3','M4A','AAC','WAV','FLAC','OGG'].map(format=><span key={format}>{format}</span>)}</div><details className="limitations"><summary>哪些链接可能无法识别？</summary><p>需要登录、受保护内容或仅播放后加载的媒体，可能无法扫描。支持常见 MP4、WebM、MOV 和完整 HLS 回放；进行中的直播、静音视频和不支持的格式会显示原因。</p></details></section>
 <section className="result-panel panel"><div className="result-header"><div className="panel-heading"><span className="section-number">02</span><h2>发现的音频</h2><span className="result-count">{files.length}</span></div><Button variant="outline" className="batch-button" disabled={!selectedFiles.length||busy||batchBusy} aria-busy={batchBusy} onClick={batch}>{batchBusy?<LoaderCircle size={17} className="spin"/>:<FolderDown size={17}/>} {batchBusy?'批量下载中':'批量下载'}{selectedFiles.length>0&&<span>({batchBusy?batchTask?.totalFiles:selectedFiles.length})</span>}</Button></div>
 {(busy||pages.length>0)&&<div className="scan-status"><div><span>{busy?'正在扫描网页':paused?'扫描暂停，等待手动操作':stopped?'扫描已停止':'扫描完成'}</span><span>{completed} / {pages.length}</span></div><Progress value={pages.length?completed/pages.length*100:0} aria-label="网页扫描进度"/></div>}
 {tasks.length>0&&<section className="transfer-panel" aria-label="下载状态"><div className="transfer-heading"><h3>下载状态</h3><span role="status" aria-live="polite">{activeDownloads.length?activeDownloads.length+' 个任务正在处理':'当前任务已结束'}</span></div><p className="transfer-help">文件会保存到浏览器下载列表。服务器批量生成 ZIP，助手批量逐个保存音频；混合选择会分为两个任务。</p>{tasks.map(task=><DownloadStatus key={task.clientId} task={task} onRetry={value=>void retryTask(value)}/>)}</section>}
 {files.length>0?<><div className="selection-bar"><label><Checkbox checked={selected.size===files.length?true:selected.size?'indeterminate':false} onCheckedChange={value=>setSelected(value?new Set(files.map(file=>file.url)):new Set())} aria-label="全选音频"/><span>已选 {selectedFiles.length} 个</span></label><span>{total?bytes(total):''}{extractCount>0&&(total?' + ':'')+extractCount+' 个音轨待提取'}{browserCount>0&&' · '+browserCount+' 个浏览器音轨'} · 自动去重</span></div><div className="audio-list"><Table><colgroup><col className="choose-column"/><col/><col className="download-column"/></colgroup><TableHeader className="sr-only"><TableRow><TableHead>选择</TableHead><TableHead>音频名称</TableHead><TableHead>下载</TableHead></TableRow></TableHeader><TableBody>{files.map((file,index)=>{
 const browser=hasBrowserDelivery(file),pendingTask=tasks.find(task=>downloading(task)&&task.fileUrls.includes(file.url)),task=pendingTask||tasks.find(task=>task.fileUrl===file.url),pending=!!pendingTask;
 return <TableRow key={file.url}><TableCell className="choose-cell"><Checkbox checked={selected.has(file.url)} aria-label={'选择 '+file.title} onCheckedChange={value=>setSelected(previous=>{const next=new Set(previous);if(value)next.add(file.url);else next.delete(file.url);return next;})}/></TableCell><TableCell className="file-cell"><div className="file-info"><button type="button" className={'file-icon '+(playing===file.url?'playing':'')} onClick={()=>void preview(file)} aria-label={(browser?'打开来源试听 ':playing===file.url?'暂停':'试听')+file.title}>{browser?<ExternalLink size={22}/>:playing===file.url?<AudioLines size={22}/>:<FileAudio size={23}/>}</button><div className="file-text"><div className="file-index">TRACK {String(index+1).padStart(2,'0')} {file.podcast&&<span>/ {file.podcast}</span>}</div><h3>{file.title}</h3><div className="file-meta"><span className="format-chip">{file.format.toUpperCase()}</span>{browser&&<span className="browser-chip">浏览器保存</span>}<span>{browser?'完整独立音轨':file.mode==='extract'?'完整音轨 · '+(file.sourceFormat==='独立音轨'?'独立音频':'视频提取'):bytes(file.size)}</span>{file.duration&&<span>{Math.round(file.duration/60)} 分钟</span>}<a href={file.source} target="_blank" rel="noreferrer">来源 <ExternalLink size={12}/></a></div>{task&&<div className={'file-download-status file-status-'+task.state} role="status"><DownloadIcon task={task}/><span>{task.kind==='bundle'&&downloading(task)?'批量任务正在处理':downloadLabel(task)}{task.bytes>0&&task.kind==='file'&&' · '+transferred(task.bytes)}</span></div>}</div></div></TableCell><TableCell className="download-cell"><Button variant="ghost" className="file-download-button" disabled={pending} aria-busy={pending} aria-label={(pending?'正在下载 ':task&&['failed','unavailable'].includes(task.state)?'重试下载 ':'下载 ')+file.title} onClick={()=>void startDownload(file)}>{pending?<LoaderCircle className="spin" size={20}/>:<ArrowDownToLine size={20}/>}<span>{pending?'下载中':task&&['failed','unavailable'].includes(task.state)?'重试':'下载'}</span></Button></TableCell></TableRow>;
 })}</TableBody></Table></div><div className="download-note"><FolderDown size={16}/><span>{selectionNote}</span></div></>:<div className="empty-result"><div className="empty-symbol"><AudioLines size={40}/></div><h3>{busy?'正在网页里寻找声音':pages.length?'暂未找到可下载音频':'你的下一份音频收藏'}</h3><p>{busy?'识别音频、检查链接，结果会逐条出现。':paused?'请先在来源页面完成手动操作，再继续扫描。':pages.length?'查看下方说明，或换一个公开网页链接。':'在左侧粘贴链接，点击扫描就能找到音频。'}</p><div className="empty-lines"><span/><span/><span/></div></div>}</section></div>
 {notices.length>0&&<section className="notice-panel"><h2><Info size={17}/>扫描说明 <span>{notices.length}</span></h2>{notices.map(page=><div key={page.url} className="notice-row"><a href={page.url} target="_blank" rel="noreferrer">{page.title}</a><p>{page.warnings.join('；')}</p></div>)}</section>}
 <footer><span>拾音 <span className="footer-divider">/</span> 让声音随行</span><span>每次最多 100 个网页 · 每次最多 100 个音频 · 服务器 ZIP 上限 3 GB</span></footer></main></div>;
}
