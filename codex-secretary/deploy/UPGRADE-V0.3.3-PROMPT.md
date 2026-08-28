# 掌心助理 v0.3.3 附件体验升级指令

将掌心助理升级到 v0.3.3。此包包含 v0.3.2 的上传可靠性修复，并把上传反馈升级为接近 Codex 的附件卡片。不得扩大 Linux/root 权限，不修改密码、Codex 登录、Cloudflare DNS/证书、Mihomo、OpenClaw 或其他业务服务。

1. 校验主人上传的 `palm-secretary-v0.3.3-20260824.tar.gz` 与随包 SHA256；不一致停止。
2. 只读记录 current、api/web/nginx 状态、RestartCount、监听端口和根分区空间；可用空间低于 5GB 停止。
3. 备份 `/etc/palm-secretary/app.env`（只复制，不读取/输出内容）、`/home/codex/workspace/.palm/state.json` 和定义 `server_name ai.wiseliang.cloud` 的 Nginx 配置文件；记录旧 current 用于回滚。
4. 解压确认 `package.json` 为 `0.3.3`，执行 `deploy/install-release.sh`；不得重写 app.env。
5. 若 v0.3.2 的公网上传超时配置尚未应用：通过 `nginx -T` 精确定位 `ai.wiseliang.cloud` HTTPS server，在该 server 保持 `client_max_body_size 100m`、设置 `client_body_timeout 300s`；在承接 `/api/files/upload` 的现有反代 location 中设置 `proxy_request_buffering off`、`proxy_send_timeout 300s`、`proxy_read_timeout 300s`。不要改其他站点、证书、安全头或 Tailscale 请求头清理。
6. `nginx -t` 通过后才 reload；重启 palm-secretary-api/web。
7. 登录网页或 Android App 验收：选择文件后立即出现附件卡片；显示文件名、大小、实时百分比和进度条；网络错误显示原因和重试按钮；成功后显示“✓ 已上传 · 发送时自动附带”；发送消息后 Codex 能读取文件；文件页面上传时也有明显成功反馈。
8. 再上传小 TXT 和 20–50MB 文件，确认均成功且无重复文件；复核项目隔离、4510/4511/8088/7897 回环、无新增公网端口、RestartCount=0、日志无 ERROR、根分区不少于 5GB。

失败则精确回切旧 current 和备份配置。全程不得输出密码、哈希、Cookie、Token、auth.json、私钥、代理节点或订阅。

归档 SHA256 以主人随包提供的 `.sha256.txt` 为准。
