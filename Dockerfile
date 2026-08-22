# syntax=docker/dockerfile:1
#
# 两段：第一段只为下 mihomo 内核，让它不进最终层（.gz 和 curl 都留在这儿）。
# 第二段是运行时，内容就是 node + mihomo + 本仓库的 js。
#
# 内核在构建时下载而不是入库 —— .gitignore 里已忽略。
#
# 移植自 Ciallo-Zen-Proxy Dockerfile（MIT），适配 FreeBuff 的项目结构：
#   - 入口 server.js（不是 server/index.mjs）
#   - 项目有 worker.js + server.js + web/ + server/ + scripts/
#   - 内核是给「出口代理（SUBSCRIPTION_URL）」用的，没配订阅不影响运行

# 这段刻意跑在目标平台（而不是 --platform=$BUILDPLATFORM）。QEMU 模拟慢，
# 但换来的是最后那句 `./mihomo -v` 真的在目标架构上执行了一次 ——
# 资产名拼错、下到半截、拿到不匹配的架构，都会在构建时当场暴露。
FROM alpine:3.20 AS kernel
ARG MIHOMO_VERSION=v1.19.29
ARG TARGETARCH
RUN apk add --no-cache curl
WORKDIR /out
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz" ;; \
      arm64) asset="mihomo-linux-arm64-${MIHOMO_VERSION}.gz" ;; \
      *) echo "不支持的架构: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o mihomo.gz \
      "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}"; \
    gunzip mihomo.gz; \
    chmod +x mihomo; \
    ./mihomo -v

FROM node:22-alpine
# ca-certificates 是给 mihomo 的：Go 从 /etc/ssl/certs 读根证书，
# 没有它拉 https 订阅会失败。Node 自己带了一套编进去的，不受影响。
# su-exec 给入口脚本用：以 root 修正挂载卷属主后降权到 node（见 docker-entrypoint.sh）。
RUN apk add --no-cache ca-certificates su-exec

COPY --from=kernel /out/mihomo /usr/local/bin/mihomo

WORKDIR /app
# 代理出站使用 undici.ProxyAgent；锁定依赖版本，保证本地、CI 与镜像行为一致。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY worker.js ./
COPY server.js ./
COPY server ./server
COPY web ./web
COPY aliases.json ./
COPY scripts ./scripts
# 入口脚本要可执行（Windows 检出可能丢失执行位，这里显式补上）
RUN chmod +x /app/scripts/docker-entrypoint.sh

# 只用 mixed-port 不开 TUN，所以不需要 NET_ADMIN 之类的权限。
# 这里先建好 /data 并归属 node：命名卷首次创建时会继承这个属主。
# 绑挂宿主目录（./data:/data）时属主常是 root —— 交给入口脚本启动时
# chown 一次再降权到 node（见 docker-entrypoint.sh），用户无需手动 chown。
# 因此这里不写 USER node：容器以 root 起，入口脚本修正属主后用 su-exec 落到 node，
# 应用进程本身仍以非 root 运行。
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=8787 \
    TZ=Asia/Shanghai

# 数据目录固定指到挂载卷（账号池/API Key/模型映射/内核缓存都落这里，
# /app 对 node 用户是只读的）
ENV FREEBUFF_DATA_DIR=/data

# 构建标识。面板右上角显示它，「检查更新」拿它和 GitHub 上 beta 的 HEAD 比。
# 刻意放在最后：这个值每次提交都变，放前面会把后面所有层的缓存全打掉。
# 不传也能构建，只是面板显示 unknown 且不会报「有新版本」（见 server/build.mjs）。
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 8787
VOLUME ["/data"]

# 用 node 自己探活，省得为 curl/wget 再装一个包（alpine 的 wget 是 busybox 版，
# 行为和常见写法不一样）。端口由 node 读 env，不靠 shell 展开。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口脚本先以 root 修正 /data 属主，再用 su-exec 降权到 node 执行 CMD。
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "server.js"]
