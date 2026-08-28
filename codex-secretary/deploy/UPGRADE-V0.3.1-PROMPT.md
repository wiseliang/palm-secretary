# 掌心助理 v0.3.1 小版本升级指令

将已运行的 v0.3.0 升级到 v0.3.1。此版本不扩大 Linux/root 权限；Codex 继续为 `approvalPolicy=never`、`danger-full-access`、`osUser=codex`。改动目标是让用户无需提及保存目录：凡任务产生可下载成果，Codex 自动实际写入当前项目成果目录，网页输入框上方直接出现下载按钮。

1. 精确校验主人上传的 `palm-secretary-v0.3.1-20260824.tar.gz` 与随包 SHA256；不一致停止。
2. 只读记录 current、服务、RestartCount、监听端口和磁盘；低于 5GB 停止。
3. 备份 app.env（不读取内容）和 `.palm/state.json`，记录旧 current 用于回滚。
4. 解压后确认 `package.json` 为 `0.3.1`，运行原 `deploy/install-release.sh`；不修改 app.env、证书、公网 Nginx、代理、OpenClaw 或其他服务。
5. `nginx -t` 通过后重启 api/web，再验证并 reload Nginx。
6. 登录网页做验收：只说“帮我生成一份内容为 AUTO_DOWNLOAD_OK 的 TXT 文件”，不得提到 outbox 或保存目录。任务应无审批完成，输入框上方自动出现“最新成果”下载按钮；下载后逐字节确认内容。再生成一个 DOCX，确认同样自动出现。
7. 复核模型切换、项目隔离、附件读取、4510/4511/8088/7897 回环监听、RestartCount=0、日志无 ERROR，根分区不少于 5GB。

不输出密码、哈希、Cookie、Token、auth.json、私钥、节点或订阅。失败则精确回切升级前 release。

归档 SHA256：以主人随包提供的 `.sha256.txt` 为准。
