import {downloadHeaders,filename} from '@/lib/audio';
import {openAudioFile} from '@/lib/media';
import {beginTransfer,failTransfer,wrapTransferStream} from '@/lib/transfers';
export async function GET(request:Request) {
  let transferId:string|undefined,begun=false;
  try {const q=new URL(request.url).searchParams;
    if(q.get('preview')!=='1'&&q.has('transferId')){transferId=q.get('transferId')!;beginTransfer(transferId,'file',1);begun=true;}
    const url=q.get('url');if(!url)throw new Error('缺少音频地址');
    const range=request.headers.get('range')||undefined;
    if(range&&!/^bytes=\d*-\d*$/.test(range))throw new Error('无效下载范围');
    const mode=q.get('mode')||'direct';if(!['direct','extract'].includes(mode))throw new Error('无效处理方式');
    const name=q.get('filename')||filename('音频','audio');
    const duration=q.has('duration')?Number(q.get('duration')):undefined;
    if(duration!==undefined&&(!Number.isFinite(duration)||duration<=0))throw new Error('无效音轨时长');
    const result=await openAudioFile({url,source:q.get('source')||url,title:'音频',filename:name,format:'audio',size:0,duration,mode:mode as 'direct'|'extract'},range);
    const outputName=mode==='extract'?filename(name.replace(/\.[^.]+$/,''),result.format):name;
    const headers=new Headers(downloadHeaders(outputName.replace(/[\r\n]/g,''),result.type));
    if(q.get('preview')==='1')headers.set('Content-Disposition','inline');
    if(result.contentRange)headers.set('Content-Range',result.contentRange);
    if(mode==='direct')headers.set('Accept-Ranges','bytes');
    if(result.size)headers.set('Content-Length',String(result.size));
    return new Response(transferId?wrapTransferStream(result.body,transferId,result.size||undefined):result.body,{headers,status:result.status});
  }catch(e){if(begun&&transferId)failTransfer(transferId,e);return Response.json({error:e instanceof Error?e.message:'下载失败'},{status:400,headers:{'Cache-Control':'no-store'}});}
}
