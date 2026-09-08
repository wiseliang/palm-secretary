# 工作区备份与隔离恢复

本工具用于 v0.16 任务可靠交付阶段的数据恢复演练。服务器运维只使用 palm-ssh-ops / 直接 SSH。

## 范围与边界

备份 `.palm` 索引、会话撤销记录以及工作区内的普通文件、目录和链接定义。链接不会被跟随；工作区外的实际项目必须显式使用 `--extra-root NAME=PATH` 纳入。例如当前 `projects/obsidian-vault` 指向 `/home/codex/obsidian-vault`，需额外备份该目录。

备份不包含 `/etc/palm-secretary/app.env`、SSH 私钥、Codex 登录凭据及工作区以外的 Codex 原始对话历史。索引中的对话引用不等于完整对话正文备份。此流程完成的是工作区文件与索引恢复验证，不是整台机器灾难恢复；同盘副本也不能抵御整盘损坏。后续异地备份应另行选择受控存储位置和加密方案。

## 已有工具

仓库入口 `deploy/workspace-backup.py`，Python 3.10+、无第三方依赖；服务器安装路径 `/opt/palm-secretary/ops/workspace-backup.py`。以 root 执行的备份目录应为 0700，归档为 0600。归档包含用户数据，不放在可公开下载的工作区，不提交 Git，不打印正文。

创建备份前确认 API 正常且无 running/submissionPending 任务，再停止 API，并在停止后复查任务状态。备份命令必须置于 try/finally 中，确保失败时也重新启动 API。不得因为备份失败而直接解除待核对任务。

下面的路径仅为格式示例；每次使用新的时间戳目录，不覆盖已有归档：

```sh
python3 /opt/palm-secretary/ops/workspace-backup.py backup \
  /home/codex/workspace /opt/palm-secretary/backups/NEW_TIMESTAMP/workspace.tar.gz \
  --extra-root obsidian-vault=/home/codex/obsidian-vault
python3 /opt/palm-secretary/ops/workspace-backup.py verify \
  /opt/palm-secretary/backups/NEW_TIMESTAMP/workspace.tar.gz
python3 /opt/palm-secretary/ops/workspace-backup.py restore \
  /opt/palm-secretary/backups/NEW_TIMESTAMP/workspace.tar.gz \
  /opt/palm-secretary/restore-drills/NEW_TIMESTAMP
```

工具要求有效状态文件且无活动/待核对任务，拒绝将归档写入被备份目录。备份前后核对文件清单、大小、时间及 inode；任何变化均中止。每个文件有 SHA256，归档先完整验证，再以不覆盖已有路径的原子方式发布。

恢复先验证所有条目、路径、大小和摘要，拒绝重复条目、路径越界、特殊文件或未列入清单的数据，只允许新建目的目录。恢复再次校验写入内容，未完成目录保留 `.restore-incomplete` 标记。当前最大数据量 20 GiB，清单最大 32 MiB。

## 恢复后的人工接管

恢复结果布局为 `workspace/` 和显式指定的其他根目录。`restore-manifest.json` 保存原目录映射、原权限和全部链接定义；不会自动创建链接或执行恢复内容。目录权限默认 0700、文件默认 0600，属主为执行恢复的用户。

正式接管前必须核对目标目录、属主、必要执行权限、外部项目映射与链接目标，并保全当前线上状态。不能直接把隔离副本原样替换运行中的工作区，也不能未经重映射就对隔离副本启动生产 API。对话正文与登录凭据的恢复需要单独确认。本工具不自动覆盖生产路径。

## 2026-09-08 实际演练

- 备份：`/opt/palm-secretary/backups/workspace-20260908-141120/workspace.tar.gz`。
- SHA256：`82dcded07cc6f32b0a3566d48e48dfbecf02a41e368c702b094c65d91c3a0c28`。
- 归档大小：24,191,530 字节。
- 隔离恢复：`/opt/palm-secretary/restore-drills/20260908-141120`。
- 2,947 个文件、512 个目录、9 个链接定义；文件摘要全部一致，未创建实际链接。
- 恢复索引计数：11 个项目、77 段对话、315 条任务。
- API 暂停约 10.38 秒，随后重新启动；未覆盖线上数据，应用仍为 v0.16.0。
- Windows/Linux 均通过 6 个测试用例；`test:v026` 已纳入 `test:all` 自动发现入口。

这是文件与索引层面的隔离恢复演练，未模拟服务器丢失、未验证恢复后的真实任务执行，也没有新建定时备份任务。
