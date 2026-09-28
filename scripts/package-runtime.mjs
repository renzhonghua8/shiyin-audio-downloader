import {cpSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.join(root,'dist'),target=path.join(root,'deployment/prebuilt/dist');
if(!existsSync(path.join(source,'server/index.js'))||!existsSync(path.join(source,'client')))throw new Error('请先构建生产版本。');
rmSync(target,{recursive:true,force:true});mkdirSync(path.dirname(target),{recursive:true});
cpSync(source,target,{recursive:true,filter:p=>!p.includes(path.sep+'.openai'+path.sep)&&path.basename(p)!=='.openai'});
console.log('已更新 deployment/prebuilt/dist，可提交并部署。');
