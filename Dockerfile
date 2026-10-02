# 使用官方 Node 运行时（本项目零第三方依赖，无需 npm install）
FROM node:22-alpine

LABEL org.opencontainers.image.title="blfp-release-mirror" \
      org.opencontainers.image.description="自动同步 GitHub Releases（含 pre-release）到本地并删除旧版本，提供直接下载与 API" \
      org.opencontainers.image.source="https://github.com/EVFBV/blfp-release-mirror" \
      org.opencontainers.image.licenses="MIT"

# tini 让容器正确处理信号（可选但更稳）
RUN apk add --no-cache tini

WORKDIR /app

# 先拷 package.json，利用镜像层缓存
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    BIND=0.0.0.0 \
    GITHUB_REPO=EVFBV/blfp-client \
    INCLUDE_PRERELEASE=true \
    INCLUDE_DRAFT=false \
    KEEP_VERSIONS=1 \
    SYNC_INTERVAL_SECONDS=600 \
    SYNC_ON_START=true \
    DOWNLOAD_CONCURRENCY=2 \
    MAX_RETRIES=3 \
    STALL_TIMEOUT_SECONDS=60 \
    PROTECT_DOWNLOADS=false \
    LOG_LEVEL=info

RUN mkdir -p /data/files && chown -R node:node /data /app

USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
