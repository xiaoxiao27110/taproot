import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approvalFilePath, loadPendingApprovals, updateApprovalDecision } from '../src/approvalModel';

test('approval model lists pending approvals and writes remembered decisions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taproot-approval-'));
  try {
    const configPath = path.join(root, 'nodes.yaml');
    const filePath = approvalFilePath(configPath);
    await writeFile(configPath, 'nodes: {}\n', 'utf8');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(
        [
          {
            id: 'appr-one',
            status: 'pending',
            tool: 'cluster_exec',
            target: 'gpu-node-1',
            details: { command: 'whoami' },
            created_at: '2026-06-20T01:20:00.000Z',
          },
          {
            id: 'appr-two',
            status: 'approved',
            tool: 'cluster_exec',
            target: 'gpu-node-1',
            details: { command: 'pwd' },
            created_at: '2026-06-19T01:20:00.000Z',
          },
        ],
        null,
        2,
      )}\n`,
      'utf8',
    );

    const pending = await loadPendingApprovals(configPath);
    assert.deepEqual(pending.map((item) => item.id), ['appr-one']);

    const updated = await updateApprovalDecision(configPath, 'appr-one', 'remember');
    assert.equal(updated.status, 'remembered');

    const records = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(records[0].status, 'remembered');
    assert.equal(typeof records[0].remembered_at, 'string');
    assert.equal(typeof records[0].updated_at, 'string');

    await assert.rejects(
      updateApprovalDecision(configPath, 'appr-one', 'approve'),
      /only pending approvals can be changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
