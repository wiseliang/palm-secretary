# 掌心助理：服务器部署说明

当前应用版本：v0.4.0。v0.4 新增持久任务中心、项目工作台搜索、项目重命名和多文件顺序上传。

部署目标是让 Web、API 和 Codex App Server 全部只监听本机地址，再通过 Tailscale Serve 提供私网 HTTPS。禁止使用 Funnel，禁止把 4510、4511、8088 或 App Server 端口暴露到公网。

## 部署顺序

1. 验证压缩包 SHA256，解压到临时目录。
2. 确认 `codex` 普通用户可执行 Node.js 22；不要让 Codex 获得 root 权限，也不要把它加入 docker 组。
3. 执行 `chmod 0755 deploy/install-release.sh && sudo deploy/install-release.sh`。
4. 安装并登录 Tailscale。首次 `tailscale up --hostname=palm-secretary --accept-dns=false` 会返回登录地址，需要由服务器所有者在浏览器完成。
5. 读取 `tailscale status --json` 中本机的 MagicDNS 名称和所有者 `LoginName`，分别写入 `APP_ORIGIN` 与 `TAILSCALE_OWNER_LOGIN`。Tailscale Serve 会注入并保护身份请求头，因此所有者从 tailnet 访问时自动登录。
6. 推荐把 `APP_PASSWORD_HASH` 留空，关闭密码入口。若将来需要密码后备入口，再生成至少 20 位随机密码，用 `npm run password:hash -- "密码"` 得到哈希；只把哈希写入环境文件。
7. 创建 `/etc/palm-secretary/app.env`，权限 `root:codex 0640`，内容参考 `.env.example`。`SESSION_SECRET` 使用 `openssl rand -hex 32` 生成。
8. 启动 `palm-secretary-web` 和 `palm-secretary-api`，再安全地 reload Nginx。
9. 执行 `tailscale serve --bg http://127.0.0.1:8088`。不要使用 `tailscale funnel`。
10. 从 Android 的 Tailscale 网络访问 HTTPS 地址并完成验收。

## 回滚

部署脚本把每次版本放在 `/opt/palm-secretary/releases`。若新版本失败，把 `/opt/palm-secretary/current` 重新指向上一个版本，再重启两个 palm-secretary 服务即可。不要删除当前工作区、Codex 登录文件或 `/etc/palm-secretary/app.env`。

## 安全边界

- API、Web、Nginx 内部入口都只监听 `127.0.0.1`。
- 只信任与 `TAILSCALE_OWNER_LOGIN` 完全匹配的 Tailscale 身份；Nginx 内部入口不得改为公网监听。
- App Server 使用 stdio 子进程，不开启远程 WebSocket 监听。
- Codex 只能写 `/home/codex/workspace` 和自己的 `.codex` 目录。
- 低于 6GB 显示磁盘警告，低于 4GB 自动拒绝新任务和上传。
- 单文件上传上限 100MB。
- v0.3 的 Codex App Server 使用 `approvalPolicy=never` 与 `danger-full-access`，常规命令和文件变更不再弹出审批。
- “完整访问”仅指 Codex 沙箱；进程仍是无 sudo 的 `codex` 普通用户，并继续受 systemd 的可写路径约束。
- 项目数据持久化在 `/home/codex/workspace/.palm/state.json`，项目目录位于 `/home/codex/workspace/projects/`。
- 模型列表由当前 ChatGPT Plus 登录的 `model/list` 实时提供；每个项目独立保存模型与推理强度。
