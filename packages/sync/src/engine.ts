/**
 * Offline-first sync engine: pushes the local outbox, pulls remote changes and
 * merges them with last-writer-wins semantics. Edits that raced with a remote
 * change are recorded as conflicts (both versions are kept) so the user can
 * pick the version they want.
 */
import { TrailPackError, toTrailPackError, type EntityBase, type SyncedEntity } from '@trailpack/shared';
import type { OutboxEntry, SyncConflict, TrailPackDatabase } from '@trailpack/database';
import { contentHash } from './hash';
import {
  DEFAULT_PULL_LIMIT,
  MAX_PUSH_CHANGES,
  PullResponseSchema,
  PushResponseSchema,
  type Change,
  type ServerChange,
  type SyncTransport,
} from './protocol';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  /** ISO time of the last fully successful sync. */
  lastSyncAt: string | null;
  /** Local changes waiting for upload. */
  pending: number;
  lastError: string | null;
  /** Unresolved conflicts. */
  conflicts: number;
}

export interface SyncResult {
  pushed: number;
  /** Changes the server refused permanently. */
  rejected: { id: string; reason: string }[];
  pulled: number;
  applied: number;
  /** Remote changes ignored (stale, own, malformed). */
  skipped: number;
  conflicts: number;
}

export interface SyncEngineOptions {
  db: TrailPackDatabase;
  transport: SyncTransport;
  deviceId: string;
  /** Millisecond clock (default `Date.now`). */
  now?: () => number;
  /** Page size for pushes (max 500) and pulls. */
  batchSize?: number;
}

export interface StartOptions {
  /** Delay between successful syncs (default 60 s). */
  intervalMs?: number;
  /** First retry delay after a failure (default 2 s). */
  backoffBaseMs?: number;
  /** Upper bound of the retry delay (default 5 min). */
  backoffMaxMs?: number;
  /** Fraction of the delay randomly shaved off to avoid thundering herds (default 0.2). */
  jitter?: number;
  /** Random source in [0, 1) (injectable for tests). */
  random?: () => number;
}

/** Exponential backoff: `base * 2^(failures-1)` capped at `max`, minus up to `jitter` of the delay. */
export function computeBackoffMs(failures: number, base: number, max: number, jitter = 0, random: () => number = Math.random): number {
  if (failures <= 0) return 0;
  const exp = Math.min(max, base * 2 ** Math.min(failures - 1, 30));
  return Math.round(exp * (1 - jitter * random()));
}

type Listener = (status: SyncStatus) => void;
type ApplyOutcome = 'applied' | 'skipped' | 'conflict';

const OFFLINE_CODES = new Set(['offline', 'network', 'timeout']);

export class SyncEngine {
  private readonly db: TrailPackDatabase;
  private readonly transport: SyncTransport;
  private readonly deviceId: string;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly listeners = new Set<Listener>();

  private status: SyncStatus = { state: 'idle', lastSyncAt: null, pending: 0, lastError: null, conflicts: 0 };
  private running: Promise<SyncResult> | undefined;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startOptions: Required<StartOptions> | undefined;
  private abort: AbortController | undefined;

  constructor(options: SyncEngineOptions) {
    this.db = options.db;
    this.transport = options.transport;
    this.deviceId = options.deviceId;
    this.now = options.now ?? Date.now;
    this.batchSize = Math.max(1, Math.min(MAX_PUSH_CHANGES, options.batchSize ?? MAX_PUSH_CHANGES));
    // Without change tracking nothing could ever be uploaded.
    this.db.setTrackChanges(true);
  }

  // ---- status ------------------------------------------------------------

  getStatus(): SyncStatus {
    return this.status;
  }

  /** Observe status changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-read pending / conflict counters and the last sync time from the database. */
  async refreshStatus(): Promise<SyncStatus> {
    const [pending, conflicts, last] = await Promise.all([this.db.outbox.count(), this.db.conflicts.countOpen(), this.db.syncState.get('lastSyncAt')]);
    this.setStatus({ pending, conflicts, lastSyncAt: last ?? this.status.lastSyncAt });
    return this.status;
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    for (const l of [...this.listeners]) {
      try {
        l(next);
      } catch (e) {
        console.error('[sync] status listener failed', e);
      }
    }
  }

  // ---- public sync API ---------------------------------------------------

  /**
   * Run one push + pull cycle. Concurrent calls share the same cycle.
   * @throws TrailPackError when the transport fails (status is updated first)
   */
  syncOnce(): Promise<SyncResult> {
    if (!this.running) {
      this.running = this.runCycle().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Sync periodically until `stop()`; failures back off exponentially. */
  start(options: StartOptions = {}): void {
    this.stop();
    this.startOptions = {
      intervalMs: options.intervalMs ?? 60_000,
      backoffBaseMs: options.backoffBaseMs ?? 2000,
      backoffMaxMs: options.backoffMaxMs ?? 300_000,
      jitter: options.jitter ?? 0.2,
      random: options.random ?? Math.random,
    };
    this.schedule(0);
  }

  stop(): void {
    this.startOptions = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
  }

  /** The device regained connectivity: reset the backoff and sync right away. */
  notifyOnline(): void {
    this.failures = 0;
    if (this.startOptions) {
      this.schedule(0);
    } else {
      this.syncOnce().catch(() => undefined);
    }
  }

  async listConflicts(): Promise<SyncConflict[]> {
    return this.db.conflicts.list();
  }

  /**
   * Settle a conflict by keeping the local or the remote version. The chosen
   * version is written as a fresh edit so every device converges on it.
   */
  async resolveConflict(id: string, keep: 'local' | 'remote'): Promise<void> {
    const conflict = await this.db.conflicts.get(id);
    if (!conflict || conflict.resolved) throw new TrailPackError('not_found', `Conflict ${id} not found or already resolved`);
    const chosen = (keep === 'local' ? conflict.local : conflict.remote) as unknown as EntityBase;
    await this.db.transaction(async (tx) => {
      const repo = tx.repo(conflict.entity);
      const current = await repo.get(conflict.entityId, { includeDeleted: true });
      const floor = Math.max(
        this.now(),
        Date.parse(String(conflict.local.updatedAt)) + 1,
        Date.parse(String(conflict.remote.updatedAt)) + 1,
        current ? Date.parse(current.updatedAt) + 1 : 0,
      );
      await repo.upsert({ ...chosen, updatedAt: new Date(floor).toISOString() });
      await tx.conflicts.resolve(id);
    });
    await this.refreshStatus();
  }

  // ---- cycle -------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (!this.startOptions) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    const opts = this.startOptions;
    if (!opts) return;
    this.timer = undefined;
    try {
      await this.syncOnce();
      this.schedule(opts.intervalMs);
    } catch {
      this.schedule(computeBackoffMs(this.failures, opts.backoffBaseMs, opts.backoffMaxMs, opts.jitter, opts.random));
    }
  }

  private async runCycle(): Promise<SyncResult> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.setStatus({ state: 'syncing' });
    try {
      if ((await this.db.syncState.get('bootstrapped')) !== '1') {
        // First sync on this device: make sure pre-existing data is uploaded.
        await this.db.outbox.enqueueAll();
        await this.db.syncState.set('bootstrapped', '1');
      }
      const result: SyncResult = { pushed: 0, rejected: [], pulled: 0, applied: 0, skipped: 0, conflicts: 0 };
      // Pull first so that edits racing with remote changes are detected while still in the outbox.
      await this.pull(result, signal);
      await this.push(result, signal);
      const lastSyncAt = new Date(this.now()).toISOString();
      await this.db.syncState.set('lastSyncAt', lastSyncAt);
      this.failures = 0;
      this.setStatus({
        state: 'idle',
        lastSyncAt,
        lastError: null,
        pending: await this.db.outbox.count(),
        conflicts: await this.db.conflicts.countOpen(),
      });
      return result;
    } catch (e) {
      const error = toTrailPackError(e, 'sync');
      this.failures++;
      this.setStatus({
        state: OFFLINE_CODES.has(error.code) ? 'offline' : 'error',
        lastError: error.message,
        pending: await this.db.outbox.count().catch(() => this.status.pending),
        conflicts: await this.db.conflicts.countOpen().catch(() => this.status.conflicts),
      });
      throw error;
    } finally {
      this.abort = undefined;
    }
  }

  // ---- push --------------------------------------------------------------

  private async push(result: SyncResult, signal: AbortSignal): Promise<void> {
    for (;;) {
      const entries = await this.db.outbox.pending(this.batchSize);
      if (entries.length === 0) return;
      const changes: Change[] = [];
      for (const entry of entries) {
        const change = await this.toChange(entry);
        if (change) changes.push(change);
      }
      if (changes.length > 0) {
        const response = PushResponseSchema.parse(await this.transport.push({ deviceId: this.deviceId, changes }, signal));
        result.pushed += response.accepted;
        result.rejected.push(...response.rejected);
      }
      await this.db.outbox.markSent(entries.map((e) => e.seq));
      this.setStatus({ pending: await this.db.outbox.count() });
    }
  }

  private async toChange(entry: OutboxEntry): Promise<Change | undefined> {
    if (!entry.payload) return undefined; // unusable entry – drop it
    const change: Change = {
      entity: entry.entity,
      id: entry.entityId,
      op: entry.op,
      data: entry.payload,
      updatedAt: entry.updatedAt,
      deviceId: this.deviceId,
    };
    const shareId = await this.shareIdFor(entry.entity, entry.payload);
    if (shareId) change.shareId = shareId;
    return change;
  }

  /** Share a change belongs to: the trip's `shareId` for trips and their direct children. */
  private async shareIdFor(entity: SyncedEntity, data: Record<string, unknown>): Promise<string | undefined> {
    if (entity === 'trips') return typeof data.shareId === 'string' ? data.shareId : undefined;
    let tripId = data.tripId;
    if (entity === 'checklist_items' && typeof data.checklistId === 'string') {
      tripId = (await this.db.checklists.get(data.checklistId, { includeDeleted: true }))?.tripId;
    }
    if (typeof tripId !== 'string') return undefined;
    return (await this.db.trips.get(tripId, { includeDeleted: true }))?.shareId;
  }

  // ---- pull --------------------------------------------------------------

  private async pull(result: SyncResult, signal: AbortSignal): Promise<void> {
    let cursor = (await this.db.syncState.get('cursor')) ?? '0';
    for (;;) {
      const page = PullResponseSchema.parse(
        await this.transport.pull({ cursor, limit: Math.min(DEFAULT_PULL_LIMIT, this.batchSize), deviceId: this.deviceId }, signal),
      );
      await this.db.transaction(async (tx) => {
        for (const change of page.changes) {
          result.pulled++;
          const outcome = await this.applyChange(tx, change);
          if (outcome === 'applied') result.applied++;
          else if (outcome === 'conflict') result.conflicts++;
          else result.skipped++;
        }
        await tx.syncState.set('cursor', page.cursor);
      });
      const advanced = page.cursor !== cursor;
      cursor = page.cursor;
      if (!page.hasMore || !advanced) return;
    }
  }

  /**
   * Merge one remote change. Last writer wins by `updatedAt`, ties broken by
   * the larger device id (deterministic on every device).
   */
  private async applyChange(tx: TrailPackDatabase, change: ServerChange): Promise<ApplyOutcome> {
    if (change.deviceId === this.deviceId) return 'skipped';
    const repo = tx.repo(change.entity);
    const local = await repo.get(change.id, { includeDeleted: true });
    const pending = await tx.outbox.pendingFor(change.entity, change.id);
    const localVersion = (local as unknown as Record<string, unknown> | undefined) ?? pending[pending.length - 1]?.payload ?? undefined;

    const base = change.op === 'upsert' ? change.data : (change.data ?? localVersion);
    if (!base) return 'skipped';
    if (typeof base.id === 'string' && base.id !== change.id) return 'skipped';
    const candidate: Record<string, unknown> = { ...base, id: change.id, updatedAt: change.updatedAt };
    if (change.op === 'delete' && !candidate.deletedAt) candidate.deletedAt = change.updatedAt;
    if (change.op === 'upsert') candidate.deletedAt = candidate.deletedAt ?? null;
    const parsed = repo.schema.safeParse(candidate);
    if (!parsed.success) return 'skipped';
    const remote = parsed.data as unknown as Record<string, unknown>;

    if (!localVersion) {
      await repo.upsert(parsed.data, { fromSync: true });
      return 'applied';
    }

    const localTs = Date.parse(String(localVersion.updatedAt));
    const remoteTs = Date.parse(change.updatedAt);

    if (pending.length === 0) {
      // Equal timestamps: the local row is assumed to be this device's write, so the larger device id wins on every device.
      if (remoteTs < localTs || (remoteTs === localTs && change.deviceId <= this.deviceId)) return 'skipped';
      await repo.upsert(parsed.data, { fromSync: true });
      return 'applied';
    }

    // Unsent local edits exist for the same entity.
    if (contentHash(localVersion) === contentHash(remote)) return 'skipped';
    const localWins = remoteTs < localTs || (remoteTs === localTs && change.deviceId < this.deviceId);
    await tx.conflicts.add({ entity: change.entity, entityId: change.id, local: localVersion, remote });
    if (!localWins) {
      await repo.upsert(parsed.data, { fromSync: true });
      await tx.outbox.discardFor(change.entity, change.id);
    }
    return 'conflict';
  }
}
