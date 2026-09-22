#!/usr/bin/env bash
set -euo pipefail

VERSION=${1:-}
if [[ ! ${VERSION} =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "无效的 Codex CLI 版本" >&2
  exit 2
fi
if [[ $(id -un) != codex ]]; then
  echo "必须由 codex 用户执行更新" >&2
  exit 3
fi

NPM_BIN=${NPM_BIN:-/usr/local/bin/npm}
PACKAGE_ROOT=/home/codex/.codex/packages/npm
TARGET_DIR="${PACKAGE_ROOT}/${VERSION}"
PROXY_PATH=/home/codex/.local/bin/codex-proxy
VENDOR_PATH="node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
TARGET_BIN="${TARGET_DIR}/${VENDOR_PATH}"
install -d -m 0700 "${PACKAGE_ROOT}" /home/codex/.local/bin

if [[ ! -x ${TARGET_BIN} ]]; then
  STAGING_DIR=$(mktemp -d "${PACKAGE_ROOT}/.${VERSION}.XXXXXX")
  cleanup() { rm -rf -- "${STAGING_DIR}"; }
  trap cleanup EXIT
  "${NPM_BIN}" --prefix "${STAGING_DIR}" install --no-save --no-audit --no-fund --omit=dev "@openai/codex@${VERSION}"
  STAGING_BIN="${STAGING_DIR}/${VENDOR_PATH}"
  [[ -x ${STAGING_BIN} ]] || { echo "安装包缺少 Linux x64 Codex 二进制" >&2; exit 4; }
  INSTALLED_VERSION=$("${STAGING_BIN}" --version | awk '{print $2}')
  [[ ${INSTALLED_VERSION} == "${VERSION}" ]] || { echo "安装版本校验失败" >&2; exit 5; }
  chmod -R u=rwX,go= "${STAGING_DIR}"
  mv -- "${STAGING_DIR}" "${TARGET_DIR}"
  trap - EXIT
fi

VERIFIED_VERSION=$("${TARGET_BIN}" --version | awk '{print $2}')
[[ ${VERIFIED_VERSION} == "${VERSION}" ]] || { echo "目标版本校验失败" >&2; exit 6; }

PROXY_TMP=$(mktemp /home/codex/.local/bin/.codex-proxy.XXXXXX)
cleanup_proxy() { rm -f -- "${PROXY_TMP}"; }
trap cleanup_proxy EXIT
cat >"${PROXY_TMP}" <<EOF
#!/bin/sh
export HTTP_PROXY='http://127.0.0.1:7897'
export HTTPS_PROXY='http://127.0.0.1:7897'
export ALL_PROXY='socks5h://127.0.0.1:7897'
export http_proxy='http://127.0.0.1:7897'
export https_proxy='http://127.0.0.1:7897'
export all_proxy='socks5h://127.0.0.1:7897'
export NO_PROXY='127.0.0.1,localhost,::1'
export no_proxy='127.0.0.1,localhost,::1'
exec '${TARGET_BIN}' "\$@"
EOF
chmod 0700 "${PROXY_TMP}"
mv -f -- "${PROXY_TMP}" "${PROXY_PATH}"
trap - EXIT
echo "${VERSION}"
