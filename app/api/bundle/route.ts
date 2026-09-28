import {publicUrl,downloadHeaders,type AudioFile} from '@/lib/audio';
import {zipStream} from '@/lib/zip';
export async function POST(request:Request){try{
 if(Number(request.headers.get('content-length')||0)>512000)throw new Error('下载列表过大，请分批下载');const body=await request.text();if(body.length>512000)throw new Error('下载列表过大，请分批下载');const payload=new URLSearchParams(body).get('manifest');if(!payload)throw new Error('缺少下载列表');const files=JSON.parse(payload) as AudioFile[];
 if(!Array.isArray(files)||!files.length||files.length>100)throw new Error('每个压缩包请选择 1–100 个音频');for(const f of files){if(typeof f.url!=='string'||f.url.length>4096||typeof f.source!=='string'||typeof f.filename!=='string'||f.filename.length>180||!Number.isFinite(f.size)||f.size<0||(f.mode!==undefined&&!['direct','extract'].includes(f.mode)))throw new Error('下载列表无效');publicUrl(f.url);publicUrl(f.source);}if(files.reduce((n,f)=>n+f.size,0)>3*1024**3)throw new Error('所选音频超过 3 GB，请分批下载');
 return new Response(zipStream(files),{headers:downloadHeaders('拾音-'+new Date().toISOString().slice(0,10)+'.zip','application/zip')});
 }catch(e){return new Response('<!doctype html><meta charset="utf-8"><p>'+String(e instanceof Error?e.message:'下载失败').replace(/[<&]/g,c=>c==='<'?'&lt;':'&amp;')+'</p>',{status:400,headers:{'Content-Type':'text/html; charset=utf-8'}});}}
