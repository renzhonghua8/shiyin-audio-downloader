#!/bin/bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo '请以 root 执行此脚本。'; exit 1; fi
if [[ $(uname -m) != x86_64 ]]; then echo '此安装脚本只适用于 x86_64 服务器。'; exit 1; fi
if ! grep -Eq 'CentOS.*release 7\.' /etc/centos-release; then echo '此脚本仅适用于 CentOS 7。'; exit 1; fi
if command -v docker >/dev/null 2>&1; then
  echo '已有 Docker，不覆盖安装。'
  systemctl enable docker
  systemctl start docker
  docker version
  exit 0
fi
if [[ $(printf '%s\n' 3.10 "$(uname -r | cut -d- -f1)" | sort -V | head -n1) != 3.10 ]]; then
  echo '内核低于 3.10，请先升级系统。'; exit 1
fi
repo=/etc/yum.repos.d/shiyin-centos7-deploy.repo
if [[ -e $repo ]]; then cp -p "$repo" "$repo.backup.$(date +%Y%m%d%H%M%S)"; fi
cat > "$repo" <<'REPOS'
[shiyin-c7-base]
name=CentOS 7.9 Archive Base
baseurl=https://vault.centos.org/7.9.2009/os/$basearch/
enabled=0
gpgcheck=1
gpgkey=https://vault.centos.org/RPM-GPG-KEY-CentOS-7

[shiyin-c7-updates]
name=CentOS 7.9 Archive Updates
baseurl=https://vault.centos.org/7.9.2009/updates/$basearch/
enabled=0
gpgcheck=1
gpgkey=https://vault.centos.org/RPM-GPG-KEY-CentOS-7

[shiyin-c7-extras]
name=CentOS 7.9 Archive Extras
baseurl=https://vault.centos.org/7.9.2009/extras/$basearch/
enabled=0
gpgcheck=1
gpgkey=https://vault.centos.org/RPM-GPG-KEY-CentOS-7

[shiyin-docker]
name=Docker CE CentOS 7 Archive
baseurl=https://download.docker.com/linux/centos/7/$basearch/stable
enabled=0
gpgcheck=1
gpgkey=https://download.docker.com/linux/centos/gpg
REPOS
yum --disablerepo='*' --enablerepo='shiyin-c7-*' --enablerepo=shiyin-docker install -y docker-ce-26.1.4-1.el7 docker-ce-cli-26.1.4-1.el7 containerd.io-1.6.33-3.1.el7
systemctl enable docker
systemctl start docker
docker version
echo 'Docker 已安装。下一步执行 bash deployment/deploy.sh，其中包含 Node 容器兼容性检查。'
