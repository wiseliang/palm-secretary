// Local-only realistic fixtures for visual and browser QA. Never uses the user's vault.
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { hashPassword } from '../dist-server/auth.js';
const workspace = path.resolve('.local-workspace/knowledge-preview');
const vault = path.join(workspace, 'vault');
for (const directory of ['读书笔记', '工作记录', '资料']) await mkdir(path.join(vault, directory), { recursive: true });
await writeFile(path.join(vault, '读书笔记', '让笔记真正有用.md'), `---
tags: [阅读, 知识管理]
---
# 让笔记真正有用

这是用于页面验收的示例笔记。记录不只是为了保存，也是为了在下一次需要时，重新找到自己的思考。

## 先记录问题，再整理答案

读到一个有启发的观点时，先写下它回答了什么问题。用自己的语言，留下当时的理解。

> [!tip] 给未来的自己留一点线索
> 一篇笔记只讨论一个主题。标题写得具体一些，下一次搜索就更容易找到。

## 建立连接

相关的内容可以相互连接。比如阅读 [[工作记录/每周回顾|每周回顾]]，把阅读所得放回实际工作中。

- 记录一个值得继续追问的问题
- 留下一段自己的解释
- 连接到另一个相关的想法

## 让知识回到行动

| 记录方式 | 下次怎样使用 |
| --- | --- |
| 一句话总结 | 快速回想文章的核心 |
| 具体的例子 | 帮助理解和解释 |
| 关联笔记 | 接着已有的思考往下走 |

- [x] 整理本周的阅读笔记
- [ ] 在下次回顾中重新阅读

\`\`\`text
问题 → 阅读 → 理解 → 行动 → 回顾
\`\`\`

[跳到建立连接](#建立连接)

\`[[代码里的双链不应转换]]\`

![示例图片](../资料/测试.png)

<script>window.knowledgeXss = true</script>
`);
await writeFile(path.join(vault, '工作记录', '每周回顾.md'), '# 每周回顾\n\n这是用于页面验收的示例笔记。\n\n## 本周的收获\n\n中文搜索验收：阅读之后，把一个想法付诸实践。\n\n[[读书笔记/让笔记真正有用#建立连接|返回阅读笔记]]\n\n[[尚未同步的笔记]]');
await writeFile(path.join(vault, '欢迎.md'), '# 欢迎\n\n这是用于页面验收的示例知识库。\n\n[[读书笔记/让笔记真正有用|开始阅读]]');
await writeFile(path.join(vault, '资料', '测试.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=', 'base64'));
await writeFile(path.join(vault, 'AGENTS.md'), 'hidden');
const child = spawn(process.execPath, ['dist-server/index.js'], { env: { ...process.env, APP_PORT: '4599', APP_ORIGIN: 'http://127.0.0.1:4520', SESSION_SECRET: 'local-knowledge-qa-session-only', APP_PASSWORD_HASH: await hashPassword('knowledge-preview'), WORKSPACE_ROOT: workspace, KNOWLEDGE_ROOT: vault, CODEX_BIN: process.execPath, CODEX_ARGS_PREFIX_JSON: JSON.stringify([path.resolve('tests/mock-app-server.mjs')]), MOCK_LOG: path.join(workspace, 'mock.jsonl'), CODEX_VERSION_CHECK_ENABLED: '0', LOG_LEVEL: 'error', TASK_STOP_FREE_BYTES: '1', DISK_WARNING_FREE_BYTES: '1' }, stdio: 'inherit' });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
child.on('exit', code => process.exit(code || 0));
