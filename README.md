# blfp-release-mirror

[![tests](https://github.com/EVFBV/blfp-release-mirror/actions/workflows/test.yml/badge.svg)](https://github.com/EVFBV/blfp-release-mirror/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

自动把 GitHub 仓库 [EVFBV/blfp-client](https://github.com/EVFBV/blfp-client) 的 **最新 Release（包含 pre-release 预发布版）**
拉到本地磁盘、**自动删除旧版本**，并对外提供**浏览器直接下载**和**HTTP API 下载**的 Docker 服务。

> 本项目仓库：<https://github.com/EVFBV/blfp-release-mirror> · MIT License
> 要镜像的仓库可以随时改（环境变量或运行时 API，见「运行时配置」），不限于 blfp-client。

- 默认仓库：`EVFBV/blfp-client`（可用 `GITHUB_REPO` 或 `POST /api/settings` 换成任意仓库）
- 默认行为：只保留最新 1 个版本，旧的自动删除；每 10 分钟检查一次新版本
- 零第三方依赖（只用 Node.js 内置模块），镜像基于 `node:22-alpine`

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 自动同步 | 定时轮询 GitHub Releases，发现新版本自动下载 |
| 包含 pre-release | `INCLUDE_PRERELEASE=true`（默认），`v2.3.21-pre` 这类预发布版也会被拉取 |
| 智能判断"最新" | 按语义化版本比较（`v2.3.21-pre > v2.3.20-pre > v2.3.19`），不依赖 API 返回顺序 |
| 删除旧版本 | `KEEP_VERSIONS=N` 只保留最新 N 个版本，其余文件自动清理；残留半成品 `.part` 也会清理 |
| 下载可靠性 | 断点续传（HTTP Range）、sha256 校验（用 GitHub 提供的 digest）、失败重试（指数退避）、卡死自动中断重试 |
| 浏览器直接访问 | 打开首页即可看到所有版本和文件并点击下载；`/latest` 永远指向最新版 |
| API 下载 | `GET /api/latest`、`GET /api/files` 等 JSON 接口，`/download/<文件名>` 可直接下载 |
| 启动即同步 | 容器启动后立刻同步一次，不用等一个轮询周期 |
| 可鉴权 | `API_TOKEN` 保护写接口，`PROTECT_DOWNLOADS=true` 连下载也要求鉴权 |
| **可运行时换仓库** | 不改环境变量、不重启容器，通过 `POST /api/settings` 或网页表单随时切换要镜像的 GitHub 仓库，配置持久化在 `/data/settings.json` |
| 自带健康检查 | `GET /health`，Dockerfile 已配置 `HEALTHCHECK` |

---

## 快速开始

### 方式一：docker compose（推荐）

```bash
# 在项目目录下
docker compose up -d --build

# 查看日志（能看到下载进度、清理旧版本的记录）
docker logs -f blfp-release-mirror

# 打开浏览器
# http://localhost:8080
```

### 方式二：docker run

```bash
docker build -t blfp-release-mirror:latest .

docker run -d \
  --name blfp-release-mirror \
  --restart unless-stopped \
  -p 8080:8080 \
  -e GITHUB_REPO=EVFBV/blfp-client \
  -e INCLUDE_PRERELEASE=true \
  -e KEEP_VERSIONS=1 \
  -e SYNC_INTERVAL_SECONDS=600 \
  -v blfp-data:/data \
  blfp-release-mirror:latest
```

### 方式三：不用 Docker，直接本机跑

```bash
DATA_DIR=./data PORT=8080 node src/server.js
```

> 需要的只是 Node.js 20.10+，没有 npm 依赖，不用 `npm install`。

---

## 访问方式

### 1. 浏览器直接访问

| 地址 | 作用 |
| --- | --- |
| `http://<host>:8080/` | 网页控制台：版本列表、文件列表、下载按钮、同步状态与进度 |
| `http://<host>:8080/latest` | **永远下载最新版本**（只有一个文件时自动 302 到该文件；多个文件时返回列表） |
| `http://<host>:8080/latest/<文件名>` | 从最新版本里取指定文件 |
| `http://<host>:8080/download/<文件名>` | 按文件名下载（带 `Content-Disposition`，浏览器会直接开始下载） |
| `http://<host>:8080/files/<文件名>` | 按文件名直接访问（网页内预览用，不强制下载） |
| `http://<host>:8080/releases/<tag>/<文件名>` | 指定历史版本的文件（前提是该版本还在保留范围内） |

所有文件接口都支持 `Range`，可以用迅雷 / IDM / `curl -C -` 多线程或断点续传。

### 2. API 调用

```bash
# 最新版本信息（JSON，含 sha256、大小、下载地址）
curl http://localhost:8080/api/latest

# 本地已有文件列表
curl http://localhost:8080/api/files

# 所有保留版本及其资产
curl http://localhost:8080/api/releases

# 只检查远端有没有新版本（不下载）
curl http://localhost:8080/api/check

# 运行状态、下载进度、磁盘占用
curl http://localhost:8080/api/status

# 直接下载最新版（-J 保留文件名，-L 跟随跳转）
curl -L -O -J http://localhost:8080/latest

# 按文件名下载
curl -L -O -J "http://localhost:8080/download/BLFP-Setup-v2.3.22-pre.exe"

# 断点续传下载
curl -L -C - -o BLFP.exe "http://localhost:8080/download/BLFP-Setup-v2.3.22-pre.exe"

# 立即触发一次同步（后台执行，202）
curl -X POST http://localhost:8080/api/sync

# 立即同步并等待结果
curl -X POST "http://localhost:8080/api/sync?wait=1"
```

用 Node / Python 调用示例：

```js
// Node.js 18+ / 浏览器
const latest = await (await fetch('http://localhost:8080/api/latest')).json();
console.log(latest.tag, latest.primaryDownloadUrl);
const buf = Buffer.from(await (await fetch(latest.primaryDownloadUrl)).arrayBuffer());
```

```python
import requests  # 或 urllib
latest = requests.get("http://localhost:8080/api/latest").json()
print(latest["tag"], latest["files"][0]["sizeHuman"])
data = requests.get(latest["primaryDownloadUrl"]).content
```

### 3. 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（始终开放，供监控/编排使用） |
| GET | `/api/status` | 仓库、同步状态与实时进度、磁盘占用、当前配置 |
| GET | `/api/config` | 生效的配置（不含敏感值） |
| GET | `/api/releases` | 保留的版本列表及各自资产（含 sha256、下载地址） |
| GET | `/api/latest` | 最新的一个版本（含 `primaryDownloadUrl`） |
| GET | `/api/files` | 本地磁盘上实际存在的文件 |
| GET | `/api/check` | 对比远端最新版本，返回 `updateAvailable` |
| GET | `/api/settings` | 当前生效的运行时配置及其来源（环境变量 / settings.json） |
| POST | `/api/settings` | **运行时修改配置**（含切换镜像仓库），持久化并立即生效 |
| POST | `/api/sync` | 立即同步；加 `?wait=1` 等待完成并返回结果 |
| GET/HEAD | `/download/<文件>`、`/files/<文件>`、`/latest`、`/releases/<tag>/<文件>` | 文件下发，支持 Range |

---

## 运行时配置（不重启换仓库）

镜像哪个仓库不必写死在环境变量里：网页首页有「镜像配置」表单，也可以用 API 直接改。
保存后写入 `/data/settings.json`、立即生效，并自动触发一次同步（切换仓库时会顺带清掉旧仓库的文件）。

```bash
# 换成另一个仓库（支持 owner/repo 或完整 GitHub 链接），并只镜像 exe
curl -X POST http://localhost:8080/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"repo":"some-owner/some-repo","includePrerelease":true,"keepVersions":1,"assetRegex":"\\.exe$"}'

# 改轮询间隔 / 并发 / 是否包含 pre
curl -X POST http://localhost:8080/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"syncIntervalSeconds":300,"downloadConcurrency":3,"includePrerelease":false}'

# 查看当前配置（含每个字段来自环境变量还是被 settings.json 覆盖）
curl http://localhost:8080/api/settings

# 恢复为环境变量里的默认配置
curl -X POST http://localhost:8080/api/settings -H 'Content-Type: application/json' -d '{"reset":true}'
```

优先级：**`/data/settings.json` > 环境变量 > 内置默认值**。

可运行时修改的字段：`repo`、`apiBase`、`includePrerelease`、`includeDraft`、`keepVersions`、
`assetRegex`、`assetExcludeRegex`、`syncIntervalSeconds`、`downloadConcurrency`、`maxRetries`、
`stallTimeoutSeconds`、`publicBaseUrl`、`corsOrigin`。

> `GITHUB_TOKEN`（以及 `DATA_DIR`、`PORT`、`BIND`）**只能通过环境变量设置**：出于安全考虑不接受运行时写入，
> 也不会存进明文的 `settings.json`。私有仓库请用环境变量提供令牌，再随时用 API 切换仓库。
> 若服务暴露在公网，请务必设置 `API_TOKEN`，否则任何人都能改这些配置。

鉴权（设置 `API_TOKEN` 后）：

```bash
curl -X POST -H "Authorization: Bearer <API_TOKEN>" http://localhost:8080/api/sync
curl -X POST "http://localhost:8080/api/sync?token=<API_TOKEN>"          # 也可以用查询参数
curl -H "X-API-Token: <API_TOKEN>" http://localhost:8080/api/files       # 或者自定义头
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GITHUB_REPO` | `EVFBV/blfp-client` | 要镜像的仓库，`owner/repo` 或完整 GitHub 地址 |
| `GITHUB_TOKEN` | 空 | 可选。公开仓库不填也能用；填了把 GitHub API 限额从 60 次/小时提升到 5000 次/小时，私有仓库必需 |
| `GITHUB_API_BASE` | `https://api.github.com` | API 地址，GitHub Enterprise 或测试时可改 |
| `INCLUDE_PRERELEASE` | `true` | **是否包含 pre-release**（你要求的"包括 pre"） |
| `INCLUDE_DRAFT` | `false` | 是否包含草稿发布（需要 token 权限） |
| `KEEP_VERSIONS` | `1` | 本地保留最新几个版本，超出的自动删除。设 `2` 可保留上一版用于回滚 |
| `ASSET_REGEX` | 空 | 只下载名字匹配该正则的资产，例如 `\.exe$` 只下 exe |
| `ASSET_EXCLUDE_REGEX` | 空 | 排除匹配的资产，例如 `\.blockmap$` |
| `DATA_DIR` | `/data` | 数据目录（建议挂载卷） |
| `PORT` | `8080` | 监听端口 |
| `BIND` | `0.0.0.0` | 监听地址 |
| `PUBLIC_BASE_URL` | 空 | 对外地址，反代后设置它，API 返回的下载链接才是外网地址 |
| `SYNC_INTERVAL_SECONDS` | `600` | 轮询间隔（秒），`0` = 关闭定时同步 |
| `SYNC_ON_START` | `true` | 启动后是否立刻同步一次 |
| `DOWNLOAD_CONCURRENCY` | `2` | 同时下载几个资产 |
| `MAX_RETRIES` | `3` | 单个文件下载失败重试次数（指数退避 1s/2s/4s…） |
| `STALL_TIMEOUT_SECONDS` | `60` | 多久没收到数据判定为卡死并中断重试 |
| `API_TOKEN` | 空 | 设置后 `POST /api/sync` 需要鉴权 |
| `PROTECT_DOWNLOADS` | `false` | 设 `true` 后下载与查询接口也需要 `API_TOKEN` |
| `CORS_ORIGIN` | `*` | API 的 CORS 来源，设为空字符串可关闭 |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

> 除 `GITHUB_TOKEN`、`DATA_DIR`、`PORT`、`BIND` 外，上表字段都可以通过 `POST /api/settings` 在运行时覆盖，
> 且 `/data/settings.json` 的优先级高于环境变量（详见下面的「运行时配置」）。

---

## 磁盘占用与"删旧版"策略

每个安装包约 **257 MB**，因此默认策略是最节省空间的：

- `KEEP_VERSIONS=1`：磁盘上永远只有**最新一个版本**的文件，新版本下载完成后立刻删除旧版本文件。
- `KEEP_VERSIONS=2`：保留最新两个版本（方便回滚），再旧的删除。
- 删除动作发生在**新文件下载并校验通过之后**，不会出现"旧的删了新的没下完"的空窗。
- 文件名与 GitHub 资产名一致（例如 `BLFP-Setup-v2.3.22-pre.exe`）；如果保留多个版本且不同版本存在同名资产，会自动带 tag 前缀避免互相覆盖。
- 中断下载留下的 `.part` 文件会被用于断点续传；超过 6 小时未更新的 `.part` 会在同步时清理。
- 想确认删了什么，看容器日志里的 `已清理 N 个旧文件，释放 xxx`。

`/data` 目录结构：

```
/data
├── files/                      # 下载好的资产文件（对外提供下载的就是这里）
│   └── BLFP-Setup-v2.3.22-pre.exe
├── files/xxx.exe.part          # 下载中的临时文件（断点续传用，成功后自动消失）
├── manifest.json               # 已同步版本、文件名、大小、sha256 的记录
└── settings.json               # 运行时配置（用 API/网页改过配置才会出现）
```

---

## 常见问题

**Q：会不会一直重复下载同一个 257 MB 文件？**
不会。同步时先检查本地文件的大小（必要时校验 sha256，或复用 `manifest.json` 里记录的 size+mtime），一致就跳过；实测第二次同步只输出"已是最新，跳过下载"。

**Q：没有 GITHUB_TOKEN 会怎样？**
公开仓库可以正常用，但 GitHub 对未认证请求限制为 60 次/小时。默认 10 分钟一次 = 6 次/小时，完全够用；如果把间隔改得很短或频繁手动触发，建议配 token。

**Q：支持私有仓库吗？**
支持，设置 `GITHUB_TOKEN`（需要 `repo` 读权限）即可。

**Q：反代到公网怎么配？**
```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_request_buffering off;   # 大文件下载更稳
    client_max_body_size 0;
}
```
并设置 `PUBLIC_BASE_URL=https://dl.example.com`，这样 API 返回的下载地址才是外网可用的。

**Q：怎么只保留正式版、不要 pre 版？**
`-e INCLUDE_PRERELEASE=false`。此时若远端最新是 pre 版，会选用最新的正式版。

**Q：怎么强制重新下载当前版本？**
删掉 `/data/files/` 里对应文件再 `curl -X POST /api/sync` 即可（服务会发现文件缺失并重新下载）。

**Q：端口/容器起不来？**
`docker logs blfp-release-mirror` 看日志；常见原因是 `ASSET_REGEX` 写成了非法正则（启动时会直接报错并指出变量名），或数据卷没有写权限（容器内以 `node` 用户运行，`/data` 需要可写）。

---

## 目录结构

```
.
├── src/
│   ├── server.js       # HTTP 服务：网页、文件下发（Range/ETag）、JSON API、鉴权
│   ├── sync.js         # 同步引擎：选择版本、下载、更新 manifest、清理旧版本、定时器
│   ├── downloader.js   # 下载：断点续传、sha256 校验、重试、卡死看门狗
│   ├── github.js       # GitHub API：releases 列表、语义化版本比较与过滤
│   ├── store.js        # 本地存储：manifest 原子读写、文件列表、prune、磁盘统计
│   ├── config.js       # 环境变量解析与校验
│   ├── settings.js     # 运行时配置（settings.json，可在网页/API 里换仓库）
│   ├── logger.js       # 日志
│   └── util.js         # 通用工具（并发池、哈希、文件名净化等）
├── public/index.html   # 网页控制台（直接访问用的页面）
├── test/               # 自动化测试（含假 GitHub 服务的端到端测试）
├── Dockerfile
├── docker-compose.yml
├── env.example
└── package.json
```

---

## 测试

```bash
node --test test/*.test.js
```

CI（`.github/workflows/test.yml`）会在 Node 20 / Node 22 上跑全部测试，并额外构建 Docker 镜像、
启动容器验证 `/health` 与 `/api/settings`。

覆盖内容：

- 版本比较与"最新版"选择（含 pre-release 优先于旧正式版、`INCLUDE_PRERELEASE=false`、资产正则过滤、同名资产改名）
- 断点续传（伪造半成品 `.part` → Range 续传 → sha256 一致）、校验失败清理、重试、404 快速失败、速率限制错误提示
- 端到端：假 GitHub 服务 → 首次同步 → 新版本发布后**旧文件被删除** → 重复同步跳过 → 本地文件被删后自愈
- HTTP：完整下载、Range/206/416、HEAD、`/latest` 302、路径穿越防护、`/api/sync` 异步与等待模式、`/api/check`
- 鉴权：`API_TOKEN` + `PROTECT_DOWNLOADS` 的各种组合，以及配置错误时明确拒绝
- 运行时配置：**把镜像仓库从 A 换成 B → 下载 B 的资产并清理 A 的文件**、配置持久化（重启后仍生效）、
  非法值（仓库格式 / 越界数字 / 非法正则 / 未知字段 / 试图写入 token）返回 400 且不污染已有配置

---

## 安全说明

- 下载文件名经净化处理（只取 basename），路径穿越（`../`）请求会被拒绝，不会读到 `manifest.json` 之外的文件。
- 设置 `API_TOKEN` 后写接口需要鉴权，且比较使用定长比较避免时序攻击。
- 镜像以非 root 用户 `node` 运行，只暴露一个端口，数据全部在 `/data` 卷内。
- 建议把服务放在内网或反代后面；如需公网暴露，请同时开启 `API_TOKEN` 与 `PROTECT_DOWNLOADS`。
