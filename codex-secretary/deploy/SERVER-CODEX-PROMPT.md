# 给服务器端 Codex / OpenClaw 的部署指令

你正在执行“掌心助理 v0.1”部署。必须逐步执行；可安全自动完成的步骤直接完成。只有 Tailscale 首次登录需要主人操作时才暂停。不要输出任何 Token、Cookie、`auth.json`、代理节点、订阅地址、`SESSION_SECRET` 或其他凭据。

## 输入

- 主人会给出上传压缩包的绝对路径。
- 主人会在消息中另行给出该压缩包的 SHA256；必须校验一致。

## 安全边界

1. 不修改 OpenClaw、NapCat、QQ、Mihomo、MySQL、现有 Nginx 站点、防火墙、DNS、路由或 Codex 登录文件。
2. 不给 `codex` sudo/root 权限，不加入 docker 组；应用服务固定使用 `codex` 普通用户。
3. 禁止 Tailscale Funnel。4510、4511、8088 和 Codex App Server 不得监听 `0.0.0.0` 或 `[::]`。
4. 不删除任何现有文件、镜像、日志、工作区或旧 release。磁盘不足时停止并汇报，不扩大清理范围。
5. 任何检查失败先汇报；不要绕过校验或安全限制。

## 执行步骤

### 1. 只读预检

- 用 `sha256sum` 校验上传包与主人提供的 SHA256。
- 用 `tar -tzf` 检查成员，不允许绝对路径或 `..` 路径穿越。
- 记录 `df -h /`，根分区可用空间必须至少 5GB。
- 记录但不改动：`mihomo`、`napcat`、OpenClaw、onebot_filter、nginx 状态及当前监听端口。
- 确认用户 `codex`、`/home/codex/.local/bin/codex-proxy`、`/home/codex/.codex` 存在，并以 `codex` 用户执行 `codex-proxy --version` 与登录状态只读检查；不得显示认证文件内容。

### 2. 安装 Tailscale（仅缺少时）

- 若 `tailscale` 不存在，按 Tailscale 官方 Linux 安装方式执行：`curl -fsSL https://tailscale.com/install.sh | sh`。
- 执行 `tailscale up --hostname=palm-secretary --accept-dns=false`。
- 如果输出浏览器登录 URL，只向主人报告该 URL，然后暂停。主人确认登录完成后，从本步骤继续。
- 登录完成后确认 BackendState 为 Running。禁止执行任何 `tailscale funnel` 命令。

### 3. 让普通用户可使用 Node 22

- 先执行 `sudo -u codex -H /usr/local/bin/node --version`，要求 Node >=22.13。
- 若不可用，只允许在 `/usr/local/bin/node`、`npm`、`npx` 三个路径均不存在时，把现有 `/root/.nvm/versions/node/v22.23.1` 完整复制为 `/opt/palm-node-v22.23.1`，设为 `root:root` 且目录可读可执行，再分别创建到其 `bin/node`、`bin/npm`、`bin/npx` 的 `/usr/local/bin` 符号链接。
- 任一路径已存在但不符合版本要求时停止汇报，禁止覆盖。

### 4. 安装 release

- 使用 `mktemp -d` 创建临时目录，将校验过的压缩包解压到其中。
- 找到包含 `package.json` 与 `deploy/install-release.sh` 的项目根目录。
- 执行 `chmod 0755 deploy/install-release.sh`，再以 root 执行它。脚本会安装依赖、构建并配置 systemd/Nginx，但此时不会启动应用。

### 5. 写入私密环境文件

确定实际 HTTPS 访问地址并生成至少 20 位随机登录密码；使用 `npm run password:hash -- "密码"` 生成哈希。创建 `/etc/palm-secretary/app.env`，所有者 `root:codex`、权限 `0640`。应用只接受密码登录产生的 Session Cookie，不信任 Tailscale 身份 Header。内容为：

```dotenv
APP_HOST=127.0.0.1
APP_PORT=4511
APP_ORIGIN=https://<实际访问域名>
APP_PASSWORD_HASH=<生成的 scrypt 哈希，绝不输出>
SESSION_SECRET=<用 openssl rand -hex 32 生成，绝不输出>
SESSION_HOURS=168
WORKSPACE_ROOT=/home/codex/workspace
CODEX_BIN=/home/codex/.local/bin/codex-proxy
CODEX_ARGS_PREFIX_JSON=[]
CODEX_USER_HOME=/home/codex
CODEX_HOME=/home/codex/.codex
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
ALL_PROXY=http://127.0.0.1:7897
MAX_UPLOAD_BYTES=104857600
DISK_WARNING_FREE_BYTES=6442450944
TASK_STOP_FREE_BYTES=4294967296
```

不要在命令回显或最终报告中显示该文件内容。

### 6. 启动私网服务

- `systemctl enable --now palm-secretary-api palm-secretary-web`
- 确认两项服务 active 后执行 `nginx -t`，成功才 `systemctl reload nginx`。
- 执行 `tailscale serve --bg http://127.0.0.1:8088`。如提示启用 tailnet HTTPS，按提示完成；不得改用 Funnel。

### 7. 最终只读验收

- `curl http://127.0.0.1:4511/api/health` 返回 `{"ok":true}`。
- 4510、4511、8088 仅监听 `127.0.0.1`；Mihomo 7897 仍仅监听回环；没有新增公网端口。
- `palm-secretary-api` 与 `palm-secretary-web` 的运行用户均为 `codex`，RestartCount 为 0。
- 从日志中确认无持续的代理、DNS、TLS、权限或 Codex App Server 错误；不要粘贴可能含敏感内容的原始日志。
- OpenClaw、NapCat、QQ、Mihomo、MySQL、Nginx 原有服务状态未受影响。
- 根分区仍至少有 5GB 可用空间。
- `tailscale serve status` 显示私网 HTTPS 映射到 `127.0.0.1:8088`，且没有 Funnel。

最后只汇报：部署是否通过、私网 HTTPS 地址、服务/监听/磁盘摘要，以及请主人在 Android 安装 Tailscale、登录同一 tailnet、打开该地址并“添加到主屏幕”。不显示任何密钥或认证材料。
