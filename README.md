# 拾音 · 音频批量下载

把多个网页链接粘贴到网页里，扫描可读取的音频，逐个下载或打包成 ZIP。视频优先使用独立音轨，也可以提取视频里的声音。音频保留原始编码，不强制转换为 MP3。

公开仓库：<https://github.com/renzhonghua8/shiyin-audio-downloader>

## 支持范围

- 小宇宙公开节目页：读取页面提供的原始音频。
- 哔哩哔哩 BV 链接：读取平台提供的独立音轨；支持分 P，也可以用 `?p=2` 指定分 P。
- 喜马拉雅公开免费声音：支持播客分享链接和官网 `/sound/声音ID` 链接，读取官方匿名播放器提供的完整音频。
- 公开音频直链，以及 HTML、RSS 中可发现的音频链接。
- 可读取的 MP4、WebM 等视频和部分 HLS 回放：提取完整音轨，按编码输出 M4A、OGG、MP3 或 MKA。
- 单次最多输入 100 个网页；每个 ZIP 最多 100 个音频，已知大小合计最多 3 GB。

不保证识别所有网页。需要登录、付费、DRM、仅播放后动态加载的媒体、直播，以及部分旧分段视频可能无法处理。音轨提取是流式封装，不安装 FFmpeg，不重新编码，也不保证任意格式都能输出 MP3。

浏览器能打开源网页，不代表源网站会接受部署服务器的请求。HTTP 403、412 表示源网站没有接受这次服务器请求，原因可能涉及请求方式、登录状态或服务器网络；不能仅凭状态码断言禁止下载。自部署不会自动消除这类问题。

哔哩哔哩失败提示会注明「视频资料」或「播放接口」，保留官方返回码和具体说明；非 JSON、缺失字段等异常会显示数据错误。未知返回码不会推测为登录或地区限制。一个网站在本地能够识别，不代表部署服务器会收到相同响应；排查时请提供页面底部「扫描说明」的完整文字。

喜马拉雅接口的官方错误说明会原样保留并限制长度。返回 927 且说明涉及版权地区时，页面会明确显示「版权地区限制」，停止继续尝试其他播放器。该限制针对下载服务器所在地区，浏览器本地可播放也不能保证服务器可读取；应在该节目版权允许的地区部署服务。普通网页接口暂时失败时，会尝试官方分享页使用的匿名播放请求方式；需要验证、登录或受限内容会显示原因。

长音轨使用平台已确认的完整时长进行快速识别，扫描阶段不会为了计算时长提前遍历整条分片音轨。下载仍读取全部音频包并检查实际结束时间；主 CDN 不可读取时会尝试平台提供的备用地址和其他音轨。

点击下载后，按钮和「下载状态」区域会显示准备、提取、传输、完成或失败；同一个任务处理中不能重复提交，网页最多同时发起 3 个下载。已知大小显示传输进度，未知大小显示已传输 MB，批量任务显示已处理音频数。部分文件失败的 ZIP 会保留异常说明，页面也会提示失败原因。

「传输完成」表示服务器已发送完整文件，实际保存结果请查看浏览器下载列表。若浏览器没有弹出下载，请允许此网站下载文件。媒体直接流式传输到浏览器，不会先在网页内存中攒完整个压缩包；公网 HTTP 地址也可以使用下载按钮。下载状态在当前服务进程内暂存，服务重启后不保留。

## CentOS 7.6 部署（x86_64）

CentOS 7 已结束维护，当前 Docker 官方安装说明不再支持它。这里提供的是旧系统兼容方案：安装归档的 Docker 26.1.4，使用 Node 22 Alpine 容器运行已编译的 JavaScript，避开宿主机的旧 glibc。Node 22 的 musl / Linux x64 平台属于实验支持；最低内核 3.10 并不保证每台 CentOS 服务器都能正常运行。

部署脚本会先运行容器兼容性检查，再构建和启动应用。目前没有在你的 CentOS 服务器实测。服务器必须能访问 GitHub、CentOS / Docker 软件仓库、Docker Hub、npm registry、公共 DNS HTTPS 查询和目标媒体网站。长期运行建议使用仍受支持的系统。

以 **root** 登录服务器，执行以下命令。下载 GitHub 源码压缩包的方式不要求先安装 Git，也不修改原来的 yum 仓库文件。

```bash
cd /opt
curl -fL --retry 3 \
  https://github.com/renzhonghua8/shiyin-audio-downloader/archive/refs/heads/main.tar.gz \
  -o shiyin-source.tar.gz
tar -xzf shiyin-source.tar.gz
cd shiyin-audio-downloader-main

# 已安装 Docker 时，脚本会保留现有安装。
bash deployment/install-docker-centos7.sh
bash deployment/deploy.sh

# firewalld 正在运行时，放行访问端口。
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=8080/tcp
  firewall-cmd --reload
fi
```

再到云服务器控制台，给安全组放行入站 **TCP 8080**。浏览器打开：

```text
http://你的服务器公网IP:8080
```

部署会创建 `shiyin` 容器，配置开机恢复和日志轮转。不会保存下载过的音频，也不需要数据库。部署脚本不会覆盖已经存在的同名容器；如果发现同名容器，请先看下面的更新与恢复步骤。

如已安装 Git，也可以用 `git clone https://github.com/renzhonghua8/shiyin-audio-downloader.git` 获取代码，然后在该目录执行上面的两个部署脚本。

### 检查与排错

```bash
docker ps -a --filter name=shiyin
docker logs --tail 100 shiyin
curl -I http://127.0.0.1:8080
```

兼容性检查失败时，应用尚未部署，不应忽略错误继续运行。先保留报错以及 `uname -r`、`docker version` 的输出。若服务器本机可以访问 8080，外部无法访问，再检查公网 IP、安全组和防火墙。

如果网页显示扫描错误 403 / 412，请看扫描说明里的源网站响应；这与访问拾音网页的 8080 端口是两件不同的事。

### 更新与恢复

先取得最新代码（重新下载压缩包，或在 Git checkout 里执行 `git pull --ff-only`）。保留旧容器，给它改名后部署新版：

```bash
backup="shiyin-backup-$(date +%Y%m%d%H%M%S)"
docker stop shiyin
docker rename shiyin "$backup"
bash deployment/deploy.sh
```

若新版失败，可在同一个终端恢复旧容器：

```bash
# 删除刚刚部署的新版容器，旧容器仍保留在 $backup。
docker rm -f shiyin
docker rename "$backup" shiyin
docker start shiyin
```

## 其他 Linux 服务器

在已安装 Docker 的服务器上获取仓库，在仓库根目录执行：

```bash
bash deployment/deploy.sh
```

默认发布端口是 8080，容器内部监听 3000。

## 本地开发和更新预编译版本

使用可正常运行 Node **22.13 或更高版本**的现代开发环境；CentOS 服务器不需要构建工具。

```bash
npm ci
npm run dev
```

开发网页：<http://localhost:5173>。生产模式：

```bash
npm run typecheck
npm test
npm run package:runtime
npm start
```

生产网页默认监听 `0.0.0.0:3000`，可通过 `SHIYIN_HOST`、`SHIYIN_PORT` 修改。`npm run package:runtime` 会构建源码，并更新 `deployment/prebuilt/dist`。**修改源码后必须一起提交这个目录**，Docker 部署使用它，不在服务器上重新编译。

目录说明：

| 路径 | 用途 |
| --- | --- |
| `app/` | 网页和扫描、下载、打包接口 |
| `lib/` | 媒体识别、音轨提取和 ZIP 流 |
| `server.mjs` | 独立 Node 生产服务 |
| `deployment/prebuilt/dist/` | 可直接部署的预编译网页与服务代码 |
| `deployment/runtime/` | Docker 运行时依赖清单及锁文件 |
| `deployment/*.sh` | CentOS Docker 安装和部署脚本 |
| `.github/workflows/verify.yml` | 源码构建及 Docker 启动验证 |

第三方组件保留各自许可证；`vendor/` 包含 CSS 文件和对应的许可证。

## 兼容性依据

- [CentOS Linux 生命周期](https://www.centos.org/centos-linux/)
- [Docker 当前 CentOS 支持范围](https://docs.docker.com/engine/install/centos/)
- [Docker CentOS 7 归档软件包](https://download.docker.com/linux/centos/7/x86_64/stable/Packages/)
- [Node 22 平台要求](https://github.com/nodejs/node/blob/v22.x/BUILDING.md)
- [Node 官方 Docker 镜像说明](https://github.com/nodejs/docker-node/blob/main/README.md)
