import { spawnSync } from 'node:child_process';
const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-X', 'utf8', 'tests/workspace-backup-v026.py'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
