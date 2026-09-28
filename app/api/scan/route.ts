import { scanPage } from '@/lib/audio';
export async function POST(request:Request) {
  try {
    if(Number(request.headers.get('content-length')||0)>8000)return Response.json({error:'链接过长'},{status:400});
    const body=await request.text();if(body.length>8000)throw new Error('链接过长');
    const {url}=JSON.parse(body);if(typeof url!=='string'||url.length>4096)throw new Error('请输入有效网页链接');
    return Response.json(await scanPage(url),{headers:{'Cache-Control':'no-store'}});
  } catch(error){return Response.json({error:error instanceof Error?error.message:'扫描失败，请稍后重试'},{status:400});}
}
