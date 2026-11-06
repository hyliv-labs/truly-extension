/**
 * How far the Railgun sync has got. Lives in the offscreen document.
 *
 * Deliberately separate from railgun-run.ts: answering "how far along is it?"
 * must not load the Railgun SDK, and must not wait behind the sync itself.
 *
 * Why it exists: the first sync downloads and hashes all ~134k Arbitrum
 * Railgun commitments, which takes minutes. Without a status the popup could
 * only show a spinner, and a sync that had STALLED (rate-limited RPC) looked
 * identical to one that was merely slow.
 */

export type RailgunSyncPhase =
  | 'idle'
  /** Engine and RPC providers starting. */
  | 'starting'
  /** Downloading and hashing the merkle tree. The long part, first time only. */
  | 'syncing'
  /** Tree done; decrypting the commitments that could be this wallet's. */
  | 'scanning-wallet'
  | 'ready'
  | 'error';

export interface RailgunSyncStatus {
  readonly phase: RailgunSyncPhase;
  /** 0..1 for the current phase. */
  readonly progress: number;
  readonly startedAt: number | null;
  readonly updatedAt: number;
  /** RPC calls the engine had to give up on. Rising while stuck = rate limited. */
  readonly rpcErrors: number;
  readonly error?: string;
}

let status: RailgunSyncStatus = {
  phase: 'idle',
  progress: 0,
  startedAt: null,
  updatedAt: Date.now(),
  rpcErrors: 0,
};

export function getRailgunSyncStatus(): RailgunSyncStatus {
  return status;
}

export function setRailgunSyncStatus(patch: Partial<RailgunSyncStatus>): void {
  const next = { ...status, ...patch, updatedAt: Date.now() };
  // Progress only moves forward within a phase; the engine reports per-batch
  // values that can dip when it starts a new tree.
  if (patch.phase === undefined || patch.phase === status.phase) {
    next.progress = Math.max(status.progress, next.progress);
  }
  if (next.startedAt === null && next.phase !== 'idle') next.startedAt = Date.now();
  status = next;
}

export function countRailgunRpcError(): void {
  status = { ...status, rpcErrors: status.rpcErrors + 1, updatedAt: Date.now() };
}
