#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f deployment/prebuilt/dist/server/index.js ]]; then
  echo '缺少预编译版本，请先在受支持的开发环境执行 npm run package:runtime。'; exit 1
fi
docker info >/dev/null
if docker container inspect shiyin >/dev/null 2>&1; then
  echo '已存在名为 shiyin 的容器，未覆盖。查看：docker ps -a --filter name=shiyin'
  exit 1
fi
echo '检查 Node 容器与宿主机内核的兼容性……'
docker run --rm node:22-alpine node -e 'if(!globalThis.fetch||!AbortSignal.any||!globalThis.TransformStream)throw Error("运行环境不兼容");const s=require("node:http").createServer((_q,r)=>r.end("ok"));s.listen(0,"0.0.0.0",()=>{console.log(process.version,"HTTP 就绪");s.close()})'
docker build -t shiyin:1.0 .
docker run -d --name shiyin --restart unless-stopped --init \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 8080:3000 shiyin:1.0
for attempt in $(seq 1 30); do
  if docker exec shiyin node -e "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo '服务已启动。请放行云服务器安全组 TCP 8080，并打开 http://服务器公网IP:8080'
    docker ps --filter name=shiyin
    exit 0
  fi
  sleep 1
done
docker logs --tail 80 shiyin
docker stop shiyin >/dev/null
echo '服务启动失败，已停止本次创建的容器。请保留日志排查；未宣布部署成功。'
exit 1
