#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "必须以 root 执行部署脚本" >&2
  exit 1
fi

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RELEASE_ID=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE_DIR="/opt/palm-secretary/releases/${RELEASE_ID}"

id codex >/dev/null
command -v nginx >/dev/null
command -v openssl >/dev/null

FREE_KB=$(df --output=avail / | tail -1 | tr -d ' ')
if (( FREE_KB < 5 * 1024 * 1024 )); then
  echo "根分区可用空间不足 5GB，停止部署" >&2
  exit 1
fi

if ! sudo -u codex -H /usr/local/bin/node --version >/dev/null 2>&1; then
  echo "codex 用户无法使用 /usr/local/bin/node，请先完成 Node 22 普通用户安装" >&2
  exit 1
fi

install -d -o root -g root -m 0755 /opt/palm-secretary/releases
install -d -o codex -g codex -m 0700 /home/codex/workspace /home/codex/workspace/inbox /home/codex/workspace/outbox /home/codex/workspace/projects /home/codex/workspace/.palm
install -d -o root -g codex -m 0750 /etc/palm-secretary
install -d -o codex -g codex -m 0750 "${RELEASE_DIR}"

cp -a "${SOURCE_DIR}/app" "${SOURCE_DIR}/public" "${SOURCE_DIR}/server" "${SOURCE_DIR}/deploy" "${RELEASE_DIR}/"
cp -a "${SOURCE_DIR}/package.json" "${SOURCE_DIR}/package-lock.json" "${SOURCE_DIR}/tsconfig.json" "${SOURCE_DIR}/tsconfig.server.json" "${SOURCE_DIR}/next.config.ts" "${SOURCE_DIR}/vite.config.ts" "${SOURCE_DIR}/eslint.config.mjs" "${SOURCE_DIR}/.openai" "${RELEASE_DIR}/"
chown -R codex:codex "${RELEASE_DIR}"

if [[ ! -e /home/codex/workspace/AGENTS.md ]]; then
  install -o codex -g codex -m 0600 "${RELEASE_DIR}/deploy/workspace-AGENTS.md" /home/codex/workspace/AGENTS.md
fi

sudo -u codex -H env HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 \
  /usr/local/bin/npm --prefix "${RELEASE_DIR}" ci --no-audit --no-fund
sudo -u codex -H env NODE_ENV=production \
  /usr/local/bin/npm --prefix "${RELEASE_DIR}" run build

ln -sfn "${RELEASE_DIR}" /opt/palm-secretary/current
install -m 0644 "${RELEASE_DIR}/deploy/palm-secretary-api.service" /etc/systemd/system/palm-secretary-api.service
install -m 0644 "${RELEASE_DIR}/deploy/palm-secretary-web.service" /etc/systemd/system/palm-secretary-web.service
if [[ ! -e /etc/nginx/conf.d/palm-secretary.conf ]]; then
  install -m 0644 "${RELEASE_DIR}/deploy/nginx-palm-secretary.conf" /etc/nginx/conf.d/palm-secretary.conf
fi

nginx -t
systemctl daemon-reload

echo "代码已安装到 ${RELEASE_DIR}。下一步生成 /etc/palm-secretary/app.env，然后再启动服务。"
