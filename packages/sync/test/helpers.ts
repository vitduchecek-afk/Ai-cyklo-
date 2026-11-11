import { createDatabase, type TrailPackDatabase } from '@trailpack/database';
import { NodeSqliteDriver } from '@trailpack/database/node';
import { SyncEngine, type PullResponse, type PushRequest, type PushResponse, type ServerChange, type SyncTransport } from '../src';

/** In-memory sync server with an append-only log, mirroring the real API's semantics. */
export class FakeServer implements SyncTransport {
  log: ServerChange[] = [];
  seq = 0;
  pushCalls: PushRequest[] = [];
  pullCalls: { cursor: string; limit?: number; deviceId?: string }[] = [];
  failWith: Error | undefined;
  rejectIds = new Set<string>();

  async push(req: PushRequest): Promise<PushResponse> {
    this.pushCalls.push(req);
    if (this.failWith) throw this.failWith;
    const rejected: { id: string; reason: string }[] = [];
    let accepted = 0;
    for (const c of req.changes) {
      if (this.rejectIds.has(c.id)) {
        rejected.push({ id: c.id, reason: 'invalid_data' });
        continue;
      }
      this.log = this.log.filter((l) => !(l.entity === c.entity && l.id === c.id && Date.parse(l.updatedAt) <= Date.parse(c.updatedAt)));
      this.log.push({ ...c, serverSeq: ++this.seq });
      accepted++;
    }
    return { accepted, rejected, cursor: String(this.seq) };
  }

  async pull(q: { cursor: string; limit?: number; deviceId?: string }): Promise<PullResponse> {
    this.pullCalls.push(q);
    if (this.failWith) throw this.failWith;
    const limit = q.limit ?? 500;
    const rows = this.log.filter((c) => c.serverSeq > Number(q.cursor) && c.deviceId !== q.deviceId).sort((a, b) => a.serverSeq - b.serverSeq);
    const page = rows.slice(0, limit);
    return { changes: page, cursor: page.length ? String(page[page.length - 1]!.serverSeq) : q.cursor, hasMore: rows.length > limit };
  }
}

export interface Device {
  id: string;
  db: TrailPackDatabase;
  engine: SyncEngine;
}

/** Shared controllable wall clock for all simulated devices. */
export function sharedClock(start = '2026-04-01T08:00:00.000Z') {
  let t = Date.parse(start);
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

export async function makeDevice(id: string, transport: SyncTransport, clock: { now(): number }, batchSize?: number): Promise<Device> {
  const db = createDatabase(new NodeSqliteDriver(), { deviceId: id, clock: clock.now });
  await db.migrate();
  const engine = new SyncEngine({ db, transport, deviceId: id, now: clock.now, batchSize });
  return { id, db, engine };
}

export const trip = (name: string, extra: Record<string, unknown> = {}) => ({ name, activityType: 'hiking' as const, ...extra });
