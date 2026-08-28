# 掌心助理 v0.5.0 可靠任务升级指令

将掌心助理从 v0.4.0 升级到 v0.5.0。新增任务成果自动关联与直接下载、失败/停止任务一键重试、断线任务状态恢复、终态同步、多文件逐项反馈，以及下载文件名清理。不得扩大 Linux/root 权限，不得修改 OpenClaw、Palm Server Ops、Nginx、证书、Cloudflare、QQ/微信/NapCat、Docker、MySQL、Mihomo、防火墙或其他服务。

## 前置与空间

1. 校验发布包 SHA-256、tar 路径安全、`package.json` 版本 0.5.0。
2. 记录 current、state.json 版本与项目/对话/任务计数、服务 PID/RestartCount、端口和磁盘。
3. 部署前可精确删除已确认非 current 的 `/opt/palm-secretary/releases/20260824T061810Z`（v0.3.1）和 `/opt/palm-secretary/releases/20260824T141024Z`（16KB 失败空 release），不得删除 v0.3.3、当前 v0.4 或其他目录。删除前再次 realpath 校验均位于 `/opt/palm-secretary/releases/` 且不是 current。
4. 清理后根分区可用空间须至少 6GB，否则停止部署。
5. 新建 root-only 0700 备份目录；复制 app.env（不读取）、state.json，记录旧 current 和服务基线。

## 安装与迁移

1. 解压到临时目录，执行随包 `deploy/install-release.sh`。脚本只在 Nginx 配置不存在时安装模板；本机已有配置，线上 Nginx 文件 SHA-256/mtime 必须保持不变，Nginx 不 reload/restart。
2. 仅重启 `palm-secretary-api.service` 与 `palm-secretary-web.service`。
3. API 将 state.json 从 version 3 自动迁移至 version 4。projects/threads/tasks 数量必须保持，旧任务补齐空 `attachments` 与 `outputPaths`；owner/mode 不放宽。

## 自动验收

1. current 版本 0.5.0；`/api/health`、Web、8088 均 200。
2. state version=4，迁移前后的项目/对话/任务计数相等。
3. 4510/4511/8088/7897/4520 仅回环；12236 仅 127.0.0.1 与 [::1]；无新增公网端口。
4. api/web active、NRestarts=0、日志无新 ERROR；所有未授权服务 PID/启动时间不变。
5. 部署后根分区至少 5GB，否则恢复旧 current/state，只重启 api/web。
6. 登录交互项不得伪造：任务成果下载、一键重试、多文件反馈和断线恢复列为用户网页验收。

## 回滚与清理

核心自动验收失败时恢复旧 current 和 state.json，仅重启 api/web，保留失败 release。成功后精确删除上传包和临时 staging；保留当前 v0.5、v0.4 回滚点和 v0.3.3，不自动扩大清理。最终不得输出任何凭据或用户内容。
