import {createTransfer,getTransfer,validTransferId,type TransferKind} from '@/lib/transfers';
const headers={'Cache-Control':'no-store, max-age=0','Pragma':'no-cache'};
export async function POST(request:Request){try{
 if(Number(request.headers.get('content-length')||0)>4096)throw new Error('下载任务信息过大');
 const text=await request.text();if(text.length>4096)throw new Error('下载任务信息过大');
 const data=JSON.parse(text) as {kind?:unknown;title?:unknown;totalFiles?:unknown};
 if(!data||Array.isArray(data)||typeof data!=='object'||!['file','bundle'].includes(String(data.kind))||typeof data.title!=='string'||(data.totalFiles!==undefined&&typeof data.totalFiles!=='number'))throw new Error('下载任务信息无效');
 return Response.json(createTransfer(data.kind as TransferKind,data.title,data.totalFiles===undefined?1:data.totalFiles as number),{status:201,headers});
 }catch(error){const message=error instanceof Error?error.message:'创建下载任务失败';return Response.json({error:message},{status:message==='当前下载任务过多，请稍后重试'?429:400,headers});}}
export async function GET(request:Request){
 const id=new URL(request.url).searchParams.get('id');if(!id||!validTransferId(id))return Response.json({error:'无效下载任务 ID'},{status:400,headers});
 const t=getTransfer(id);return t?Response.json(t,{headers}):Response.json({error:'下载任务不存在或已过期，请重新下载'},{status:404,headers});
}
