/**
 * Approval records shared between the background worker and the approval window.
 *
 * The record lives in chrome.storage.session so the window can read it after
 * the worker has been torn down. The in-flight request lives there too: the
 * promise that was waiting on the prompt dies with the worker, and the next
 * wake resumes from this record instead of signing a second time.
 */

/** Ten minutes. A prompt older than this is a hang, not a request. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

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

const SESSION_INFLIGHT = 'truly:inflight';

/**
 * One dapp request, durable across a service-worker restart.
 *
 * `rawTx` is the signed transaction, written before broadcast. Re-sending
 * those exact bytes is the same transaction, so a retry cannot double-pay.
 */
export interface InFlightRequest {
  readonly requestId: string;
  readonly approvalId: string;
  readonly origin: string;
  readonly method: string;
  readonly params: unknown[];
  readonly ownerAddress: string;
  readonly ownerIndex: number;
  readonly status: 'awaiting' | 'approved' | 'rejected' | 'completed';
  readonly message?: string;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
  readonly windowId?: number;
  readonly rawTx?: string;
  readonly createdAt: number;
}

type InFlightMap = Record<string, InFlightRequest>;

async function readInFlight(): Promise<InFlightMap> {
  const stored = await chrome.storage.session.get(SESSION_INFLIGHT);
  return (stored[SESSION_INFLIGHT] as InFlightMap | undefined) ?? {};
}

async function writeInFlight(all: InFlightMap): Promise<void> {
  await chrome.storage.session.set({ [SESSION_INFLIGHT]: all });
}

export async function getInFlight(requestId: string): Promise<InFlightRequest | null> {
  return (await readInFlight())[requestId] ?? null;
}

export async function getInFlightByApproval(approvalId: string): Promise<InFlightRequest | null> {
  const all = await readInFlight();
  return Object.values(all).find((entry) => entry.approvalId === approvalId) ?? null;
}

export async function listInFlight(): Promise<InFlightRequest[]> {
  return Object.values(await readInFlight());
}

export async function putInFlight(record: InFlightRequest): Promise<void> {
  const all = await readInFlight();
  all[record.requestId] = record;
  await writeInFlight(all);
}

/**
 * Record the user's answer. A second call does not undo the first: the
 * approval window closes itself after Approve, and that close must not be
 * stored as a rejection.
 */
export async function decideApproval(
  approvalId: string,
  approved: boolean,
  reason: string,
): Promise<InFlightRequest | null> {
  const current = await getInFlightByApproval(approvalId);
  if (!current) return null;
  if (current.status !== 'awaiting') return current;

  const next: InFlightRequest = approved
    ? { ...current, status: 'approved' }
    : {
        ...current,
        status: 'rejected',
        error: { code: 4001, message: reason },
      };

  await putInFlight(next);
  await dropApproval(approvalId);
  return next;
}

/** Drop requests the user can no longer answer. Returns the ones just expired. */
export async function pruneInFlight(now = Date.now()): Promise<InFlightRequest[]> {
  const all = await readInFlight();
  const expired: InFlightRequest[] = [];
  for (const [id, entry] of Object.entries(all)) {
    if (now - entry.createdAt < APPROVAL_TTL_MS) continue;
    expired.push(entry);
    delete all[id];
    await dropApproval(entry.approvalId);
  }
  if (expired.length > 0) await writeInFlight(all);
  return expired;
}
