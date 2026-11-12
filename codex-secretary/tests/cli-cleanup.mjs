import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupCliVersions } from '../dist-server/cli-update.js';
const root = await mkdtemp(path.join(tmpdir(), 'cli-cleanup-'));
try {
  for (const version of ['0.1.0', '0.2.0', '0.3.0', 'user-data']) await mkdir(path.join(root, version));
  await symlink(path.join(root, 'user-data'), path.join(root, '0.4.0'));
  assert.deepEqual(await cleanupCliVersions(root, ['0.2.0', '0.3.0']), ['0.1.0']);
  assert.deepEqual((await readdir(root)).sort(), ['0.2.0', '0.3.0', '0.4.0', 'user-data']);
} finally { await rm(root, { recursive: true }); }
console.log('CLI cleanup retention and symlink isolation passed');
