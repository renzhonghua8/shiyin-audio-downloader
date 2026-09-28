import { startProdServer } from 'vinext/server/prod-server';
import { fileURLToPath } from 'node:url';

const port=Number(process.env.SHIYIN_PORT||3000);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('SHIYIN_PORT 无效');
await startProdServer({
  port,
  host:process.env.SHIYIN_HOST||'0.0.0.0',
  outDir:fileURLToPath(new URL('./dist',import.meta.url)),
});
