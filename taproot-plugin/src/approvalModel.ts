import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ApprovalDecision, ApprovalItem } from './configModel';

const STATUS_BY_DECISION: Record<ApprovalDecision, string> = {
  approve: 'approved',
  remember: 'remembered',
  reject: 'rejected',
};

export function approvalFilePath(configPath: string): string {
  return path.join(path.dirname(configPath), '.taproot', 'approvals.json');
}

export async function loadPendingApprovals(configPath: string): Promise<ApprovalItem[]> {
  const records = await readApprovalRecords(configPath);
  return records
    .filter((item): item is ApprovalItem =>
      isApprovalItem(item) && item.status === 'pending',
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function updateApprovalDecision(
  configPath: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<ApprovalItem> {
  const filePath = approvalFilePath(configPath);
  const records = await readApprovalRecords(configPath);
  const record = records.find((item) => isApprovalItem(item) && item.id === approvalId);
  if (!record || !isApprovalItem(record)) {
    throw new Error(`Approval not found: ${approvalId}`);
  }
  if (record.status !== 'pending') {
    throw new Error(`Approval ${approvalId} is ${record.status}; only pending approvals can be changed.`);
  }

  const status = STATUS_BY_DECISION[decision];
  const timestamp = new Date().toISOString();
  record.status = status;
  record.updated_at = timestamp;
  (record as ApprovalItem & Record<string, unknown>)[`${status}_at`] = timestamp;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
  return record;
}

async function readApprovalRecords(configPath: string): Promise<unknown[]> {
  try {
    const text = await fs.readFile(approvalFilePath(configPath), 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isApprovalItem(item: unknown): item is ApprovalItem {
  return (
    isRecord(item) &&
    typeof item.id === 'string' &&
    typeof item.status === 'string' &&
    typeof item.tool === 'string' &&
    typeof item.target === 'string' &&
    isRecord(item.details) &&
    typeof item.created_at === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
