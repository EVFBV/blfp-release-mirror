#!/usr/bin/env bash
#
# blfp-release-mirror 一键安装脚本（自动挑选延迟最低的可用镜像源）
#
#   拉取前逐个探测镜像源，判断标准是「真的能取到 manifest + 能取到 layer 数据」而不是只 ping 通；
#   再按实测延迟排序，自动用最快的那一个拉取，拉完打回标准名字 ghcr.io/...，
#   所以之后的 docker compose / docker run 照旧能用官方名字。
#
# 用法示例：
#   bash install.sh                            # 自动选源 → 拉取 → 启动容器
#   bash install.sh --list                     # 只探测并打印各源延迟与可用性
#   bash install.sh --dry-run                  # 探测后只打印将要执行的命令
#   bash install.sh --source ghcr.nju.edu.cn   # 强制使用某个源
#   bash install.sh --tag latest --port 8080 --no-start
#   bash install.sh --quick                    # 跳过 layer 数据校验（更快）
#
set -uo pipefail

# ---------------------------------------------------------------------------
# 默认配置（都可用命令行参数覆盖）
# ---------------------------------------------------------------------------
CANONICAL_REPO="ghcr.io/evfbv/blfp-release-mirror"   # 标准名字（拉完会打回这个名字）
UPSTREAM_REPO="evfbv/blfp-release-mirror"            # 各源上的仓库路径
TAG="1.0.0"
PORT="8080"
CONTAINER_NAME="blfp-release-mirror"
VOLUME_NAME="blfp-data"
GITHUB_REPO="EVFBV/blfp-client"
INCLUDE_PRERELEASE="true"
KEEP_VERSIONS="1"
SYNC_INTERVAL_SECONDS="600"
PROBE_TIMEOUT="12"
MODE="install"                                        # install | list | dry-run
FORCED_SOURCE=""
QUICK="0"
NO_START="0"
SAMPLES="2"

ACCEPT="application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json"

# ---------------------------------------------------------------------------
# 镜像源列表： 名称|docker 拉取用的镜像前缀|注册表 API host|说明
#   可用性完全由实测决定，这里只列候选。
# ---------------------------------------------------------------------------
SOURCES=(
  "ghcr.nju.edu.cn|ghcr.nju.edu.cn/${UPSTREAM_REPO}|ghcr.nju.edu.cn|南京大学 GHCR 加速（支持匿名）"
  "ghcr.dockerproxy.net|ghcr.dockerproxy.net/${UPSTREAM_REPO}|ghcr.dockerproxy.net|dockerproxy GHCR 加速（支持匿名）"
  "ghcr.io|ghcr.io/${UPSTREAM_REPO}|ghcr.io|GitHub 官方源"
  "ghcr.m.daocloud.io|ghcr.m.daocloud.io/${UPSTREAM_REPO}|ghcr.m.daocloud.io|DaoCloud GHCR 加速"
  "ghcr.chenby.cn|ghcr.chenby.cn/${UPSTREAM_REPO}|ghcr.chenby.cn|chenby GHCR 加速"
  "ghcr.geekery.cn|ghcr.geekery.cn/${UPSTREAM_REPO}|ghcr.geekery.cn|geekery GHCR 加速"
  "docker.io|${UPSTREAM_REPO}|registry-1.docker.io|Docker Hub（发布后才可用）"
  "docker.m.daocloud.io|docker.m.daocloud.io/${UPSTREAM_REPO}|docker.m.daocloud.io|DaoCloud Hub 加速"
  "docker.1ms.run|docker.1ms.run/${UPSTREAM_REPO}|docker.1ms.run|1ms Hub 加速"
  "dockerpull.org|dockerpull.org/${UPSTREAM_REPO}|dockerpull.org|dockerpull Hub 加速"
  "hub.rat.dev|hub.rat.dev/${UPSTREAM_REPO}|hub.rat.dev|rat.dev Hub 加速"
)

# 追加自定义源（内网 Harbor 等）：BLFP_EXTRA_SOURCES='名称|镜像前缀|api主机|说明'，多行分隔
if [ -n "${BLFP_EXTRA_SOURCES:-}" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && SOURCES+=("$line")
  done <<<"$BLFP_EXTRA_SOURCES"
fi

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
C_RESET=""; C_OK=""; C_ERR=""; C_DIM=""
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'
fi
info() { printf "%s\n" "$*"; }
ok()   { printf "%s✔%s %s\n" "$C_OK" "$C_RESET" "$*"; }
warn() { printf "! %s\n" "$*"; }
err()  { printf "%s✘%s %s\n" "$C_ERR" "$C_RESET" "$*" >&2; }
dim()  { printf "%s%s%s\n" "$C_DIM" "$*" "$C_RESET"; }

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

参数：
  --tag <标签>              镜像标签，默认 1.0.0（也可用 latest）
  --port <端口>             对外端口，默认 8080
  --name <容器名>           容器名，默认 blfp-release-mirror
  --repo <owner/repo>       要镜像的 GitHub 仓库，默认 EVFBV/blfp-client
  --prerelease <true|false> 是否包含 pre-release，默认 true
  --keep <数量>             本地保留几个版本，默认 1
  --interval <秒>           轮询间隔，默认 600
  --source <源>             强制使用某个源（如 ghcr.nju.edu.cn）
  --list                    只探测并打印各源延迟与可用性
  --dry-run                 探测后只打印将要执行的命令
  --quick                   跳过 layer 数据校验（更快，但结论弱一些）
  --timeout <秒>            单个源的探测超时，默认 12
  --no-start                只拉取，不启动容器
  -h, --help                显示帮助

环境变量：
  BLFP_EXTRA_SOURCES        追加自定义源，格式 '名称|镜像前缀|api主机|说明'，多行分隔

依赖：curl（必需）、docker（拉取/启动时需要）；不依赖 jq / node。
EOF
}

# ---------------------------------------------------------------------------
# 解析参数
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --name) CONTAINER_NAME="${2:?}"; shift 2 ;;
    --repo) GITHUB_REPO="${2:?}"; shift 2 ;;
    --prerelease) INCLUDE_PRERELEASE="${2:?}"; shift 2 ;;
    --keep) KEEP_VERSIONS="${2:?}"; shift 2 ;;
    --interval) SYNC_INTERVAL_SECONDS="${2:?}"; shift 2 ;;
    --source) FORCED_SOURCE="${2:?}"; shift 2 ;;
    --timeout) PROBE_TIMEOUT="${2:?}"; shift 2 ;;
    --list) MODE="list"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --quick) QUICK="1"; shift ;;
    --no-start) NO_START="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "未知参数: $1"; usage; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { err "缺少 curl，无法探测镜像源"; exit 1; }

TMP="$(mktemp -d 2>/dev/null || echo "/tmp/blfp-probe.$$")"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# 探测实现
# ---------------------------------------------------------------------------

# 取匿名 token：依次尝试 自身 service / ghcr.io / Docker Hub 官方 token 服务
fetch_token() {
  local api="$1" url token svc
  for svc in "$api" "ghcr.io"; do
    url="https://${api}/token?service=${svc}&scope=repository:${UPSTREAM_REPO}:pull"
    token=$(curl -s --max-time "$PROBE_TIMEOUT" "$url" 2>/dev/null \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p; s/.*"access_token":"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$token" ] && { printf '%s' "$token"; return 0; }
  done
  token=$(curl -s --max-time "$PROBE_TIMEOUT" \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${UPSTREAM_REPO}:pull" 2>/dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$token" ] && printf '%s' "$token"
  return 0
}

# 取 manifest 的 HTTP 状态码与 digest；token 为空则匿名请求（部分加速源允许匿名）
manifest_probe() {
  local api="$1" token="$2" hdr
  if [ -n "$token" ]; then
    hdr=$(curl -s -D- -o /dev/null --max-time "$PROBE_TIMEOUT" -H "Authorization: Bearer $token" \
      -H "Accept: $ACCEPT" "https://${api}/v2/${UPSTREAM_REPO}/manifests/${TAG}" 2>/dev/null)
  else
    hdr=$(curl -s -D- -o /dev/null --max-time "$PROBE_TIMEOUT" \
      -H "Accept: $ACCEPT" "https://${api}/v2/${UPSTREAM_REPO}/manifests/${TAG}" 2>/dev/null)
  fi
  local code digest
  code=$(printf '%s' "$hdr" | head -1 | awk '{print $2}')
  digest=$(printf '%s' "$hdr" | grep -i '^docker-content-digest:' | tr -d '\r' | awk '{print $2}')
  printf '%s %s' "${code:-000}" "${digest:-}"
}

# 真取一段 layer 数据（跟随 307 跳转），证明该源能吐出镜像内容
blob_probe() {
  local api="$1" token="$2" auth=""
  [ -n "$token" ] && auth="Authorization: Bearer $token"
  local idx sub subm layer out code bytes
  idx=$(curl -s --max-time "$PROBE_TIMEOUT" ${auth:+-H "$auth"} -H "Accept: $ACCEPT" \
    "https://${api}/v2/${UPSTREAM_REPO}/manifests/${TAG}" 2>/dev/null)
  sub=$(printf '%s' "$idx" | sed -n 's/.*"digest": *"\(sha256:[a-f0-9]\{64\}\)".*/\1/p' | head -1)
  [ -z "$sub" ] && return 1
  subm=$(curl -s --max-time "$PROBE_TIMEOUT" ${auth:+-H "$auth"} -H "Accept: $ACCEPT" \
    "https://${api}/v2/${UPSTREAM_REPO}/manifests/${sub}" 2>/dev/null)
  layer=$(printf '%s' "$subm" | sed -n 's/.*"digest": *"\(sha256:[a-f0-9]\{64\}\)".*/\1/p' | head -1)
  [ -z "$layer" ] && return 1
  out=$(curl -sL -o /dev/null -w '%{http_code} %{size_download}' --max-time "$PROBE_TIMEOUT" -r 0-4095 \
    ${auth:+-H "$auth"} "https://${api}/v2/${UPSTREAM_REPO}/blobs/${layer}" 2>/dev/null)
  code=$(printf '%s' "$out" | awk '{print $1}')
  bytes=$(printf '%s' "$out" | awk '{print $2}')
  case "$code" in
    200|206) if [ "${bytes:-0}" -gt 3000 ]; then return 0; else return 1; fi ;;
    *) return 1 ;;
  esac
}

# 探测一个源，结果写入 $TMP/<名称>.result ： ok|延迟|digest|备注|http
probe_source() {
  local name="$1" api="$2" out="$TMP/$1.result"
  local anon code digest token latency=0 t0 t1 s blob="skip"

  anon=$(manifest_probe "$api" "")
  code="${anon%% *}"
  digest="${anon#* }"
  token=""
  if [ "$code" != "200" ]; then
    token=$(fetch_token "$api")
    if [ -n "$token" ]; then
      anon=$(manifest_probe "$api" "$token")
      code="${anon%% *}"
      digest="${anon#* }"
    else
      printf 'fail|-|-|拿不到匿名 token|%s\n' "$code" > "$out"
      return
    fi
  fi

  if [ "$code" != "200" ]; then
    printf 'fail|-|-|manifest 返回 HTTP %s|%s\n' "$code" "$code" > "$out"
    return
  fi

  # 延迟：取 SAMPLES 次里最快的一次
  local si=0
  for (( si=0; si<SAMPLES; si++ )); do
    t0=$(date +%s%N 2>/dev/null || echo 0)
    manifest_probe "$api" "$token" >/dev/null
    t1=$(date +%s%N 2>/dev/null || echo 0)
    s=0
    [ "$t0" != "0" ] && s=$(( (t1 - t0) / 1000000 ))
    if [ "$s" -gt 0 ] 2>/dev/null; then
      if [ "$latency" = "0" ] || [ "$s" -lt "$latency" ]; then latency="$s"; fi
    fi
  done
  [ "$latency" = "0" ] && latency="-"

  if [ "$QUICK" != "1" ]; then
    if blob_probe "$api" "$token"; then blob="ok"; else blob="fail"; fi
    if [ "$blob" = "fail" ]; then
      printf 'fail|-|-|manifest 有但拉不到 layer 数据|200\n' > "$out"
      return
    fi
  fi

  printf 'ok|%s|%s|layer校验=%s|200\n' "$latency" "$digest" "$blob" > "$out"
}

# ---------------------------------------------------------------------------
# 探测所有源（并行）
# ---------------------------------------------------------------------------
info "正在探测镜像源：先确认真的能取到镜像，再按延迟排序（超时 ${PROBE_TIMEOUT}s）"
info ""
pids=()
for entry in "${SOURCES[@]}"; do
  IFS='|' read -r name image api desc <<<"$entry"
  if [ -n "$FORCED_SOURCE" ] && [ "$name" != "$FORCED_SOURCE" ]; then continue; fi
  probe_source "$name" "$api" &
  pids+=("$!")
done
for p in "${pids[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null; done

OFFICIAL_DIGEST="$(cut -d'|' -f3 "$TMP/ghcr.io.result" 2>/dev/null)"

printf "%-22s %-9s %s\n" "镜像源" "延迟" "状态"
printf "%-22s %-9s %s\n" "----------------------" "---------" "-------------------------------------"

BEST_NAME=""; BEST_IMAGE=""; BEST_LATENCY=""; BEST_DIGEST=""
USABLE=()
for entry in "${SOURCES[@]}"; do
  IFS='|' read -r name image api desc <<<"$entry"
  if [ -n "$FORCED_SOURCE" ] && [ "$name" != "$FORCED_SOURCE" ]; then continue; fi
  result="$(cat "$TMP/$name.result" 2>/dev/null || echo 'fail|-|-|探测未执行|')"
  IFS='|' read -r status latency digest note _ <<<"$result"

  if [ "$status" = "ok" ]; then
    if [ -n "$OFFICIAL_DIGEST" ] && [ -n "$digest" ] && [ "$digest" != "$OFFICIAL_DIGEST" ]; then
      printf "%-22s %-9s 镜像 digest 与官方不一致，已排除  %s\n" "$name" "${latency} ms" "$desc"
      continue
    fi
    printf "%-22s %-9s %s可用%s  %s\n" "$name" "${latency} ms" "$C_OK" "$C_RESET" "$desc"
    USABLE+=("${latency}|${name}|${image}")
    if [ -z "$BEST_LATENCY" ] || { [ "$latency" != "-" ] && [ "$latency" -lt "$BEST_LATENCY" ]; } 2>/dev/null; then
      BEST_LATENCY="$latency"; BEST_NAME="$name"; BEST_IMAGE="$image"; BEST_DIGEST="$digest"
    fi
  else
    printf "%-22s %-9s 不可用（%s）  %s\n" "$name" "-" "$note" "$desc"
  fi
done
info ""

if [ -z "$BEST_NAME" ]; then
  err "没有任何可用的镜像源。三条退路："
  info "  1) 用 Release 里的离线镜像包：docker load -i blfp-release-mirror-${TAG}-linux-amd64.tar.gz"
  info "  2) 从源码本地构建：docker build -t ${CANONICAL_REPO}:${TAG} ."
  info "  3) 指定其它源重试：bash install.sh --source <源>；内网仓库可用 BLFP_EXTRA_SOURCES 追加"
  exit 1
fi

if [ "$BEST_NAME" != "ghcr.io" ]; then
  ok "自动选择延迟最低的可用源：${C_OK}${BEST_NAME}${C_RESET}（${BEST_LATENCY} ms），不必死磕官方源"
else
  ok "自动选择：${BEST_NAME}（${BEST_LATENCY} ms，即官方源；其它加速源本次探测均不可用）"
fi
info "  镜像地址：${BEST_IMAGE}:${TAG}"
[ -n "$BEST_DIGEST" ] && info "  镜像摘要：${BEST_DIGEST}（与官方一致）"
info ""

[ "$MODE" = "list" ] && exit 0

# ---------------------------------------------------------------------------
# 拉取：按延迟从快到慢依次尝试，失败自动降级
# ---------------------------------------------------------------------------
RUN_CMD=(docker run -d --name "$CONTAINER_NAME" --restart unless-stopped
  -p "${PORT}:8080"
  -e "GITHUB_REPO=${GITHUB_REPO}"
  -e "INCLUDE_PRERELEASE=${INCLUDE_PRERELEASE}"
  -e "KEEP_VERSIONS=${KEEP_VERSIONS}"
  -e "SYNC_INTERVAL_SECONDS=${SYNC_INTERVAL_SECONDS}"
  -v "${VOLUME_NAME}:/data"
  "${CANONICAL_REPO}:${TAG}")

if [ "$MODE" = "dry-run" ]; then
  warn "dry-run 模式，以下命令未执行："
  printf '  docker pull %s:%s\n' "$BEST_IMAGE" "$TAG"
  [ "$BEST_IMAGE" != "$CANONICAL_REPO" ] && printf '  docker tag %s:%s %s:%s\n' "$BEST_IMAGE" "$TAG" "$CANONICAL_REPO" "$TAG"
  [ "$NO_START" = "1" ] || printf '  %s\n' "${RUN_CMD[*]}"
  exit 0
fi

command -v docker >/dev/null 2>&1 || { err "没有检测到 docker 命令，无法拉取镜像（请先安装 Docker）"; exit 1; }
docker info >/dev/null 2>&1 || { err "docker 守护进程不可用（试试 sudo，或确认 docker 已启动）"; exit 1; }

pulled=""
while IFS='|' read -r lat name image; do
  [ -z "${image:-}" ] && continue
  info "尝试从 ${name} 拉取 ${image}:${TAG} ..."
  if docker pull "${image}:${TAG}"; then
    pulled="$image"
    ok "拉取成功（源：${name}，实测 ${lat} ms）"
    if [ "${image}" != "${CANONICAL_REPO}" ]; then
      docker tag "${image}:${TAG}" "${CANONICAL_REPO}:${TAG}" 2>/dev/null \
        || warn "docker tag 失败（不影响使用，可直接用 ${image}:${TAG}）"
    fi
    break
  fi
  warn "从 ${name} 拉取失败，自动换下一个源..."
done < <(printf '%s\n' "${USABLE[@]}" | awk -F'|' '$1!="-"{print $1"|"$2"|"$3}' | sort -t'|' -k1,1n)

if [ -z "$pulled" ]; then
  err "所有源都拉取失败。建议改用离线包：docker load -i blfp-release-mirror-${TAG}-linux-amd64.tar.gz"
  exit 1
fi
ok "镜像已就绪：${CANONICAL_REPO}:${TAG}"

if [ "$NO_START" = "1" ]; then
  info ""; info "已按要求跳过启动。手动启动命令："
  printf '  %s\n' "${RUN_CMD[*]}"
  exit 0
fi

if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
  warn "已存在同名容器 ${CONTAINER_NAME}，先删除旧容器"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

info "启动容器..."
"${RUN_CMD[@]}" >/dev/null || { err "容器启动失败，用 docker logs ${CONTAINER_NAME} 查看原因"; exit 1; }

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done

info ""
if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  ok "安装完成，服务已启动"
else
  warn "容器已启动，健康检查尚未通过（首次同步要下 200+MB，稍等再看）"
fi
info ""
info "  网页控制台 : http://<本机IP>:${PORT}/"
info "  最新版本   : http://<本机IP>:${PORT}/api/latest"
info "  直接下载   : http://<本机IP>:${PORT}/latest"
info "  立即同步   : curl -X POST http://<本机IP>:${PORT}/api/sync"
info "  查看日志   : docker logs -f ${CONTAINER_NAME}"
