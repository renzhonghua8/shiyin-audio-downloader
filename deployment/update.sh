#!/bin/bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo '请以 root 执行'; exit 1; }
cd "$(dirname "$0")/.."
shiyin_commit=${1:-local-$(date +%Y%m%d%H%M%S)-$$}
if [[ ! $shiyin_commit =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo '镜像版本号无效'; exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  bash deployment/install-docker-centos7.sh
fi
systemctl enable docker
systemctl start docker
docker info >/dev/null
test -f deployment/prebuilt/dist/client/shiyin-browser-helper.zip
docker run --rm node:22-alpine node -e \
  'if(!globalThis.fetch||!AbortSignal.any||!globalThis.TransformStream)throw Error("运行环境不兼容");const s=require("node:http").createServer((_q,r)=>r.end("ok"));s.listen(0,"0.0.0.0",()=>{console.log(process.version,"HTTP 就绪");s.close()})'
docker build -t "shiyin:$shiyin_commit" .
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=8080/tcp
  firewall-cmd --add-port=8080/tcp
fi
backup_container=''
old_running=false
if docker container inspect shiyin >/dev/null 2>&1; then
  old_running=$(docker inspect --format '{{.State.Running}}' shiyin)
  backup_container="shiyin-backup-$(date +%Y%m%d%H%M%S)-$$"
  docker stop shiyin
  if ! docker rename shiyin "$backup_container"; then
    if [[ $old_running == true ]]; then docker start shiyin; fi
    exit 1
  fi
fi
rollback() {
  local failure=$?
  trap - ERR
  set +e
  docker logs --tail 80 shiyin 2>/dev/null
  if [[ -n $backup_container ]]; then
    docker rm -f shiyin >/dev/null 2>&1
    if docker rename "$backup_container" shiyin; then
      if [[ $old_running == true ]]; then
        if docker start shiyin; then
          echo '新版部署失败，已恢复旧容器。'
        else
          echo '旧容器名称已恢复，但启动失败，请检查日志。'
        fi
      else
        echo '新版部署失败，已恢复旧容器的停止状态。'
      fi
    else
      echo "旧容器备份：$backup_container，请根据日志恢复。"
    fi
  else
    docker stop shiyin >/dev/null 2>&1
  fi
  exit "$failure"
}
trap rollback ERR
docker run -d --name shiyin --restart unless-stopped --init \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 8080:3000 "shiyin:$shiyin_commit"
ready=false
for attempt in $(seq 1 30); do
  if curl -fsS --connect-timeout 2 --max-time 5 \
    http://127.0.0.1:8080/ >/dev/null; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]]
curl -fsS --connect-timeout 2 --max-time 10 \
  http://127.0.0.1:8080/shiyin-browser-helper.zip >/dev/null
if [[ -n $backup_container ]]; then
  printf '%s\n%s\n' "$backup_container" "$old_running" >/opt/shiyin-last-backup
  echo "已保留旧容器：$backup_container"
fi
trap - ERR
echo '部署成功。请在云服务器安全组放行 TCP 8080。'
echo '访问：http://服务器公网IP:8080'
