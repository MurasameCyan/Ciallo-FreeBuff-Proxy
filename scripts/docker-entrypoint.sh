#!/bin/sh
# docker-entrypoint.sh —— 修正挂载卷属主后降权到 node 运行。
#
# 为什么需要它：容器以 node(uid 1000) 跑应用，但 docker-compose 里把宿主
# ./data 绑挂进 /data 时，宿主目录首次由 Docker 以 root 创建，node 写不进去
# 会 EACCES（账号池/API Key/模型映射/mihomo 缓存都落 /data）。这里在启动时
# 把 /data 属主改成 node，用户就无需手动 chown，宿主也能直接管理账号文件。
#
# 用命名卷时 /data 属主本就是 node（镜像里已 chown），这段 chown 是空操作。
# 防御式写法：非 root 运行、或没有 su-exec 时，直接 exec，容器照样能起。
set -e

if [ "$(id -u)" = "0" ]; then
  # 只改 /data 本身及其内容，不动 /app（/app 保持 root 只读）
  chown -R node:node /data 2>/dev/null || true
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$@"
  fi
fi

exec "$@"
