# 给服务器 OpenClaw/Codex 的升级指令：掌心助理 v0.3

将已运行的掌心助理升级到 v0.3。保留域名、证书、密码、代理、Codex Plus 登录、现有项目、文件和对话。新增按项目切换模型与推理强度，并再次验证 Codex 完整沙箱访问。

## 边界

- 仅处理主人上传的 `palm-secretary-v0.3.0-20260824.tar.gz`，先用随包 `.sha256.txt` 校验；不一致停止。
- 不回显 app.env、密码哈希、SESSION_SECRET、Cookie、Token、auth.json、证书私钥、代理节点或订阅。
- 不修改 Cloudflare、证书、公网 Nginx、Mihomo、OpenClaw、NapCat、MySQL、QQ、防火墙、DNS、路由。
- 不给 `codex` sudo/root，不加入 docker 组。`danger-full-access` 指 Codex 沙箱完整访问，Linux 进程仍为 `codex:codex`。
- 失败时精确恢复旧 `/opt/palm-secretary/current` 链接并重启旧服务。

## 升级

1. 只读记录 current 真实目标、api/web 状态与 RestartCount、4510/4511/8088/7897 监听和磁盘；根分区低于 5GB 停止。
2. 备份 `/etc/palm-secretary/app.env`（root-only，不读取内容）与 `/home/codex/workspace/.palm/state.json`（若存在）。
3. 解压到新建的精确临时目录，确认 `package.json` 版本为 `0.3.0`，且包含 `server/project-store.ts`、`deploy/install-release.sh`。
4. 以 root 执行安装脚本。不得重写已有 app.env。
5. `nginx -t` 通过后重启 palm-secretary-api/web，再次 `nginx -t` 后仅 reload Nginx。

## 验收

- health 返回 `{"ok":true}`；api/web 为 `codex:codex`，RestartCount=0，近 10 分钟无 ERROR/JSON-RPC/权限/代理错误。
- 4510/4511/8088/7897 仍仅监听 127.0.0.1，无新增公网端口。
- 登录网页后，模型下拉框必须来自当前 Plus 账户实际可用列表，不使用硬编码模型。
- 在项目 A 选择一个非默认模型及推理强度，刷新页面和切换项目后仍保持；项目 B 可选择不同模型。
- 在 A 发“只回复 MODEL_SWITCH_OK”；从 API 日志只确认请求成功，不输出凭据。若所选模型不可用，界面应明确报错而不是永久等待。
- `/api/status` 的非敏感状态显示 `approvalPolicy=never`、`sandbox=danger-full-access`、`osUser=codex`。
- 发起创建 `outbox/权限验收.txt` 的任务，必须直接执行，不出现审批弹窗；文件可下载且内容正确。
- 再复测 TXT 附件读取、图片附件识别、项目文件隔离、对话隔离、双页面不串线和断线自动重连。
- 公网 `https://ai.wiseliang.cloud` 正常证书校验返回 200，原服务均未受影响，根分区不少于 5GB。

完成后仅汇报版本、可用模型数量与当前选择（模型名不是凭据）、完整访问状态、服务、端口、测试和磁盘结果。

归档 SHA256：以主人随包提供的 `.sha256.txt` 为准。
