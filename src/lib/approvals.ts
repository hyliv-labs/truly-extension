/**
 * Approval records shared between the background worker and the approval window.
 *
 * The record lives in chrome.storage.session so the window can read it after
 * the worker has been torn down. The promise that resolves the request is
 * worker-local, so a teardown mid-prompt surfaces as a rejected request rather
 * than a silent hang — see the note in provider.ts.
 */

const SESSION_APPROVALS = 'truly:approvals';

export interface ApprovalRecord {
  readonly id: string;
  readonly origin: string;
  readonly method: string;
  /** Decoded, human-readable message for personal_sign. */
  readonly message?: string;
  readonly ownerAddress: string;
  readonly createdAt: number;
}

type ApprovalMap = Record<string, ApprovalRecord>;

async function readAll(): Promise<ApprovalMap> {
  const stored = await chrome.storage.session.get(SESSION_APPROVALS);
  return (stored[SESSION_APPROVALS] as ApprovalMap | undefined) ?? {};
}

export async function putApproval(record: ApprovalRecord): Promise<void> {
  const all = await readAll();
  all[record.id] = record;
  await chrome.storage.session.set({ [SESSION_APPROVALS]: all });
}

export async function getApproval(
  id: string,
): Promise<ApprovalRecord | null> {
  return (await readAll())[id] ?? null;
}

export async function dropApproval(id: string): Promise<void> {
  const all = await readAll();
  delete all[id];
  await chrome.storage.session.set({ [SESSION_APPROVALS]: all });
}
