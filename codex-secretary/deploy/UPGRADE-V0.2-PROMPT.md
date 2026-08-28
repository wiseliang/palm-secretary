# 给服务器 OpenClaw/Codex 的升级指令：掌心助理 v0.2

目标：把已运行的掌心助理 v0.1 升级到 v0.2，保留公网域名、密码、证书、Nginx 外层站点、Codex 登录、代理和已有文件。v0.2 修复附件不可见与审批卡死，并增加项目目录、项目文件和对话隔离。

## 严格边界

- 只处理主人上传的 `palm-secretary-v0.2.0-20260824.tar.gz`。
- 先核对主人随包提供的 SHA256；不一致立即停止。
- 不读取或回显 `/etc/palm-secretary/app.env` 中的密码哈希、会话密钥或任何 Codex 凭据。
- 不修改 Cloudflare、证书、域名、公网 Nginx 站点、Mihomo、OpenClaw、NapCat、MySQL、QQ、防火墙、DNS 或路由。
- Codex 仍以 `codex:codex` 普通用户运行，不授予 sudo/root，不加入 docker 组。
- `danger-full-access` 是 Codex 沙箱模式，不代表 Linux root 权限。
- 任一步失败就保留旧 release，恢复 `/opt/palm-secretary/current` 原链接并重启原服务。

## 执行步骤

1. 只读记录：当前 `/opt/palm-secretary/current` 的真实目标、两个 palm 服务状态和 RestartCount、4510/4511/8088/7897 监听、根分区可用空间。低于 5GB 停止。
2. 校验上传包 SHA256。禁止用通配符猜包名。
3. 备份以下小型元数据（不读取内容）：
   - `/etc/palm-secretary/app.env` 的权限和一份 root-only 备份；
   - 若存在 `/home/codex/workspace/.palm/state.json`，复制为带时间戳的同目录备份；
   - 记录旧 current 目标用于回滚。
4. 将压缩包解压到新建的精确临时目录，确认项目根含 `package.json`、`server/project-store.ts` 和 `deploy/install-release.sh`。
5. 确认 `package.json` 版本为 `0.2.0`，执行 `chmod 0755 deploy/install-release.sh` 后以 root 运行该安装脚本。
6. 安装脚本成功且 `nginx -t` 通过后：
   - 不改 `/etc/palm-secretary/app.env`；
   - 重启 `palm-secretary-api` 与 `palm-secretary-web`；
   - 再次执行 `nginx -t`，通过后仅 reload Nginx。
7. API 首次启动会把旧 `/home/codex/workspace/inbox`、`outbox` 中的普通文件原子移动到默认项目的对应目录。不要手工重复移动，不删除旧目录。

## 必须验收

- `GET http://127.0.0.1:4511/api/health` 返回 `{"ok":true}`。
- api/web 均为 `codex:codex`，RestartCount=0，近 10 分钟无 ERROR、权限、代理、JSON-RPC 错误。
- 4510/4511/8088/7897 仍只监听 127.0.0.1；没有新增公网端口。
- `/home/codex/workspace/.palm/state.json` 为 `codex:codex` 且 0600；存在 `projects/default/inbox`、`projects/default/outbox`、`projects/default/AGENTS.md`。
- 只检查结构，不输出敏感值：运行配置仍有 APP_ORIGIN、APP_PASSWORD_HASH、SESSION_SECRET；无需新增环境变量。
- 从已登录浏览器做功能验收：
  1. 创建“验收项目 A”和“验收项目 B”；
  2. 在 A 上传随机 TXT，发送“读取附件并准确复述随机内容”；必须得到真实内容，不能只说上传成功；
  3. A 的文件不能出现在 B；A 的对话不能在 B 恢复；
  4. 发送一个需要创建 `outbox/验收结果.txt` 的任务，应直接执行且不出现审批弹窗；
  5. 文件中心能下载并逐字节比对结果；测试文件确认路径后删除；
  6. 同时开两个浏览器页面分别在 A/B 发消息，回复不得串线；
  7. 临时断网后恢复，页面应显示“正在重连”并自动重新连接。
- 公网 `https://ai.wiseliang.cloud` 正常证书校验返回 200，API 响应仍为 `Cache-Control: no-store`。
- 原服务 mihomo、napcat、mysql、onebot_filter、OpenClaw 均未受影响；根分区仍不少于 5GB。

## 回滚

如升级失败：把 `/opt/palm-secretary/current` 精确指回步骤 1 记录的旧 release，重启 api/web，`nginx -t` 通过后 reload。v0.2 可能已把旧附件移动到 `workspace/projects/default/inbox|outbox`；回滚到 v0.1 后如需旧文件可见，只在确认同名文件不冲突后再移回旧 `workspace/inbox|outbox`，不得覆盖。

完成后只汇报版本、服务状态、测试结果、监听地址、磁盘空间和是否回滚；不要输出密码、哈希、Cookie、Token、私钥、订阅地址或 auth.json。

归档 SHA256：以主人随包提供的 `.sha256.txt` 为准。
