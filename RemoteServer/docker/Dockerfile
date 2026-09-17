# ============================================================
# UFO 远程控制中继服务器 · 容器镜像
#
# 特点：零第三方依赖，所以镜像可以做得很小，也不需要 npm install。
# 用 alpine 是为了体积小；Node 版本用 20 LTS。
# ============================================================
FROM node:20-alpine

LABEL org.opencontainers.image.title="UFO Assistant Remote Relay"
LABEL org.opencontainers.image.description="WebSocket room relay for Web-UFO-Player remote control"
LABEL org.opencontainers.image.source="https://github.com/Mistpeach/Web-UFO-Player"

WORKDIR /app

# 只需要这几个文件。server.js 是零依赖的，没有 node_modules。
COPY server.js ./
COPY config.example.json ./
COPY package.json ./
COPY PROTOCOL.md ./
COPY PRINCIPLE.md ./
COPY README.md ./

# 日志目录（容器里也会被 volume 覆盖）
RUN mkdir -p /app/logs && chown -R node:node /app

# 用非 root 运行
USER node

# 容器内监听 8787；对外由反向代理或 compose 的端口映射暴露
ENV UFO_HOST=0.0.0.0
ENV UFO_PORT=8787
EXPOSE 8787

# 健康检查：容器自己能感知服务是否还活着
# （alpine 自带的 wget 够用，不额外装 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
