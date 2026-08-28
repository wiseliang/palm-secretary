# 掌心助理 v0.3.2 上传可靠性升级指令

将已运行的 v0.3.1 升级到 v0.3.2。本次只修复文件上传链路，不扩大 Linux/root 权限，不修改密码、Codex 登录、Cloudflare DNS/证书、Mihomo、OpenClaw 或其他业务服务。

1. 校验主人上传的 `palm-secretary-v0.3.2-20260824.tar.gz` 与随包 SHA256；不一致立即停止。
2. 只读记录 current、api/web/nginx 状态、RestartCount、监听端口和根分区空间；可用空间低于 5GB 停止。
3. 备份 `/etc/palm-secretary/app.env`（只复制，不读取/输出内容）、`/home/codex/workspace/.palm/state.json` 和定义 `server_name ai.wiseliang.cloud` 的 Nginx 配置文件；记录旧 current 目标用于回滚。
4. 解压并确认 `package.json` 版本为 `0.3.2`，执行随包 `deploy/install-release.sh`。不得重写 app.env。
5. 通过 `nginx -T` 只读定位公网 `ai.wiseliang.cloud` HTTPS server 块。在该 server 保持 `client_max_body_size 100m`，设置 `client_body_timeout 300s`；在实际承接 `/api/files/upload` 的现有反代 location 中设置 `proxy_request_buffering off`、`proxy_send_timeout 300s`、`proxy_read_timeout 300s`。不得改动证书、其他域名、Tailscale 请求头清理、安全头或限速配置。
6. 运行 `nginx -t`，通过后才 reload；重启 palm-secretary-api/web。
7. 验收：health=200；网页显示上传百分比；上传一个小 TXT 和一个 20–50MB 文件均成功；同一个 `X-Upload-Id` 的重试不得产生重复文件；超限上传返回明确 413；上传文件实际出现在当前项目 inbox 且 Codex 能读取；测试文件事后精确删除。
8. 复核 4510/4511/8088/7897 仍仅回环、无新增公网端口、api/web/nginx RestartCount=0、近 10 分钟无上传/权限/代理错误，根分区不少于 5GB。

任一步失败，精确回切旧 current 和备份的 Nginx 文件，`nginx -t` 通过后 reload，并恢复 api/web。全程不得输出密码、哈希、Cookie、Token、auth.json、私钥、代理节点或订阅。

归档 SHA256 以主人随包提供的 `.sha256.txt` 为准。
