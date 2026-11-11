import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrailPackError } from '@trailpack/shared';
import { computeBackoffMs, contentHash, hashString, type SyncStatus } from '../src';
import { FakeServer, makeDevice, sharedClock, trip } from './helpers';

afterEach(() => vi.useRealTimers());

async function pair() {
  const server = new FakeServer();
  const clock = sharedClock();
  const a = await makeDevice('dev-A', server, clock);
  const b = await makeDevice('dev-B', server, clock);
  return { server, clock, a, b };
}

describe('replication', () => {
  it('propagates creates and updates between two devices', async () => {
    const { a, b, clock } = await pair();
    const t = await a.db.trips.insert(trip('Šumava'));
    await a.db.tripDays.insert({ tripId: t.id, dayIndex: 0 });
    const r1 = await a.engine.syncOnce();
    expect(r1.pushed).toBe(2);
    expect(await a.db.outbox.count()).toBe(0);

    const r2 = await b.engine.syncOnce();
    expect(r2).toMatchObject({ pulled: 2, applied: 2, conflicts: 0 });
    expect(await b.db.trips.get(t.id)).toEqual(t);
    expect(await b.db.tripDays.byTrip(t.id)).toHaveLength(1);
    expect(await b.db.outbox.count()).toBe(0); // remote applies are not echoed back

    clock.advance(60_000);
    await b.db.trips.update(t.id, { name: 'Krkonoše' });
    await b.engine.syncOnce();
    await a.engine.syncOnce();
    expect((await a.db.trips.get(t.id))?.name).toBe('Krkonoše');
    expect(await a.engine.listConflicts()).toEqual([]);
  });

  it('is a no-op when nothing changed and ignores own changes', async () => {
    const { a, server } = await pair();
    await a.db.trips.insert(trip('x'));
    await a.engine.syncOnce();
    const again = await a.engine.syncOnce();
    expect(again).toMatchObject({ pushed: 0, pulled: 0 });
    expect(server.pullCalls.every((c) => c.deviceId === 'dev-A')).toBe(true);
  });

  it('uploads data that existed before the engine was created (bootstrap)', async () => {
    const server = new FakeServer();
    const clock = sharedClock();
    const { createDatabase } = await import('@trailpack/database');
    const { NodeSqliteDriver } = await import('@trailpack/database/node');
    const { SyncEngine } = await import('../src');
    const db = createDatabase(new NodeSqliteDriver(), { deviceId: 'dev-C', clock: clock.now });
    await db.migrate();
    await db.trips.insert(trip('old data'));
    const engine = new SyncEngine({ db, transport: server, deviceId: 'dev-C', now: clock.now });
    expect(db.trackChanges).toBe(true);
    expect((await engine.syncOnce()).pushed).toBe(1);
  });

  it('pages large pushes and pulls', async () => {
    const server = new FakeServer();
    const clock = sharedClock();
    const a = await makeDevice('dev-A', server, clock);
    const b = await makeDevice('dev-B', server, clock);
    await a.db.transaction(async (tx) => {
      for (let i = 0; i < 1200; i++) await tx.trips.insert(trip(`t${i}`));
    });
    const r = await a.engine.syncOnce();
    expect(r.pushed).toBe(1200);
    expect(server.pushCalls.map((c) => c.changes.length)).toEqual([500, 500, 200]);
    const rb = await b.engine.syncOnce();
    expect(rb.applied).toBe(1200);
    expect(server.pullCalls.filter((c) => c.deviceId === 'dev-B')).toHaveLength(3);
    expect(await b.db.trips.count()).toBe(1200);
    expect(await b.db.syncState.get('cursor')).toBe('1200');
  });

  it('reports permanently rejected changes and drops them from the outbox', async () => {
    const { a, server } = await pair();
    const t = await a.db.trips.insert(trip('bad'));
    server.rejectIds.add(t.id);
    const r = await a.engine.syncOnce();
    expect(r.rejected).toEqual([{ id: t.id, reason: 'invalid_data' }]);
    expect(r.pushed).toBe(0);
    expect(await a.db.outbox.count()).toBe(0);
  });

  it('sends shareId for shared trips and their children', async () => {
    const { a, server } = await pair();
    const t = await a.db.trips.insert(trip('Shared', { shareId: 'share-1' }));
    const cl = await a.db.checklists.insert({ tripId: t.id, name: 'C' });
    await a.db.checklistItems.insert({ checklistId: cl.id, text: 'i' });
    await a.db.trips.insert(trip('Private'));
    await a.engine.syncOnce();
    const byEntity = Object.fromEntries(server.pushCalls[0]!.changes.map((c) => [`${c.entity}:${c.data?.name ?? c.data?.text}`, c.shareId]));
    expect(byEntity).toMatchObject({ 'trips:Shared': 'share-1', 'checklists:C': 'share-1', 'checklist_items:i': 'share-1', 'trips:Private': undefined });
  });

  it('skips malformed remote data without failing the sync', async () => {
    const { a, b, server } = await pair();
    await a.db.trips.insert(trip('good'));
    await a.engine.syncOnce();
    server.log.push({ entity: 'trips', id: 'broken', op: 'upsert', data: { id: 'broken', name: '' }, updatedAt: '2026-04-01T09:00:00.000Z', deviceId: 'dev-X', serverSeq: ++server.seq });
    server.log.push({ entity: 'trips', id: 'mismatch', op: 'upsert', data: { id: 'other', name: 'x' }, updatedAt: '2026-04-01T09:00:00.000Z', deviceId: 'dev-X', serverSeq: ++server.seq });
    server.log.push({ entity: 'trips', id: 'ghost', op: 'delete', updatedAt: '2026-04-01T09:00:00.000Z', deviceId: 'dev-X', serverSeq: ++server.seq });
    const r = await b.engine.syncOnce();
    expect(r).toMatchObject({ pulled: 4, applied: 1, skipped: 3 });
    expect(await b.db.trips.count()).toBe(1);
    expect(await b.db.syncState.get('cursor')).toBe(String(server.seq));
  });
});

describe('tombstones', () => {
  it('propagates soft deletes and undo', async () => {
    const { a, b, clock } = await pair();
    const t = await a.db.trips.insert(trip('Gone'));
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    clock.advance(1000);
    await a.db.trips.softDelete(t.id);
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    expect(await b.db.trips.get(t.id)).toBeUndefined();
    expect(await b.db.trips.get(t.id, { includeDeleted: true })).toBeDefined();
    clock.advance(1000);
    await a.db.trips.restore(t.id);
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    expect((await b.db.trips.get(t.id))?.deletedAt).toBeNull();
  });

  it('keeps a tombstone for entities never seen and does not resurrect from older upserts', async () => {
    const { a, b, server, clock } = await pair();
    const t = await a.db.trips.insert(trip('Short lived'));
    const oldUpsert = { entity: 'trips' as const, id: t.id, op: 'upsert' as const, data: { ...t }, updatedAt: t.updatedAt, deviceId: 'dev-A' };
    clock.advance(1000);
    await a.db.trips.softDelete(t.id);
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    expect(await b.db.trips.get(t.id, { includeDeleted: true })).toMatchObject({ deletedAt: expect.any(String) });
    server.log.push({ ...oldUpsert, serverSeq: ++server.seq }); // late, stale delivery
    const r = await b.engine.syncOnce();
    expect(r.skipped).toBe(1);
    expect(await b.db.trips.get(t.id)).toBeUndefined();
  });

  it('applies hard-delete tombstones', async () => {
    const { a, b } = await pair();
    const t = await a.db.trips.insert(trip('Purge'));
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    await a.db.trips.hardDelete(t.id);
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    expect(await b.db.trips.get(t.id)).toBeUndefined();
  });
});

describe('conflicts', () => {
  async function conflicted() {
    const ctx = await pair();
    const { a, b, clock } = ctx;
    const t = await a.db.trips.insert(trip('Base'));
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    clock.advance(10_000);
    await a.db.trips.update(t.id, { name: 'From A' });
    clock.advance(10_000);
    await b.db.trips.update(t.id, { name: 'From B' }); // later edit
    return { ...ctx, t };
  }

  it('remote wins when newer; both versions are kept and the loser is not uploaded', async () => {
    const { a, b, t, server } = await conflicted();
    await b.engine.syncOnce();
    const r = await a.engine.syncOnce();
    expect(r.conflicts).toBe(1);
    expect((await a.db.trips.get(t.id))?.name).toBe('From B');
    const conflicts = await a.engine.listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ entity: 'trips', entityId: t.id, resolved: false });
    expect(conflicts[0]!.local.name).toBe('From A');
    expect(conflicts[0]!.remote.name).toBe('From B');
    expect(a.engine.getStatus().conflicts).toBe(1);
    expect(server.log.filter((c) => c.id === t.id && c.deviceId === 'dev-A').length).toBeLessThanOrEqual(1);
    expect(await a.db.outbox.count()).toBe(0);
  });

  it('local wins when newer: local is kept and pushed, conflict still recorded', async () => {
    const { a, b, t, clock } = await conflicted();
    clock.advance(10_000);
    await a.db.trips.update(t.id, { name: 'A again' }); // newest
    await b.engine.syncOnce();
    const r = await a.engine.syncOnce();
    expect(r.conflicts).toBe(1);
    expect((await a.db.trips.get(t.id))?.name).toBe('A again');
    expect(await a.engine.listConflicts()).toHaveLength(1);
    await b.engine.syncOnce();
    expect((await b.db.trips.get(t.id))?.name).toBe('A again');
  });

  it('resolveConflict keeps the chosen version everywhere', async () => {
    const { a, b, t } = await conflicted();
    await b.engine.syncOnce();
    await a.engine.syncOnce();
    const [c] = await a.engine.listConflicts();
    await a.engine.resolveConflict(c!.id, 'local');
    expect((await a.db.trips.get(t.id))?.name).toBe('From A');
    expect(await a.engine.listConflicts()).toEqual([]);
    expect(a.engine.getStatus().conflicts).toBe(0);
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    expect((await b.db.trips.get(t.id))?.name).toBe('From A');
    await expect(a.engine.resolveConflict(c!.id, 'remote')).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.engine.resolveConflict('missing', 'remote')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('resolveConflict "remote" when local had won', async () => {
    const { a, b, t, clock } = await conflicted();
    clock.advance(10_000);
    await a.db.trips.update(t.id, { name: 'A newest' });
    await b.engine.syncOnce();
    await a.engine.syncOnce();
    const [c] = await a.engine.listConflicts();
    await a.engine.resolveConflict(c!.id, 'remote');
    expect((await a.db.trips.get(t.id))?.name).toBe('From B');
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    expect((await b.db.trips.get(t.id))?.name).toBe('From B');
  });

  it('delete vs edit conflict is recorded and the later write wins', async () => {
    const { a, b, clock } = await pair();
    const t = await a.db.trips.insert(trip('Doomed'));
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    clock.advance(1000);
    await a.db.trips.update(t.id, { name: 'Edited' });
    clock.advance(1000);
    await b.db.trips.softDelete(t.id);
    await b.engine.syncOnce();
    const r = await a.engine.syncOnce();
    expect(r.conflicts).toBe(1);
    expect(await a.db.trips.get(t.id)).toBeUndefined();
    const [c] = await a.engine.listConflicts();
    expect(c!.local.name).toBe('Edited');
  });

  it('identical concurrent edits do not create a conflict', async () => {
    const { a, b, clock } = await pair();
    const t = await a.db.trips.insert(trip('Same'));
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    clock.advance(1000);
    await a.db.trips.update(t.id, { name: 'Equal' });
    clock.advance(1000);
    await b.db.trips.update(t.id, { name: 'Equal' });
    await b.engine.syncOnce();
    const r = await a.engine.syncOnce();
    expect(r.conflicts).toBe(0);
    expect(await a.engine.listConflicts()).toEqual([]);
  });

  it('breaks exact timestamp ties deterministically on both devices', async () => {
    const { a, b } = await pair();
    const t = await a.db.trips.insert(trip('Tie'));
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    const ts = '2026-04-01T09:00:00.000Z';
    await a.db.trips.upsert({ ...t, name: 'tie-A', updatedAt: ts });
    await b.db.trips.upsert({ ...t, name: 'tie-B', updatedAt: ts });
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    await a.engine.syncOnce();
    await b.engine.syncOnce();
    const an = (await a.db.trips.get(t.id))?.name;
    const bn = (await b.db.trips.get(t.id))?.name;
    expect(an).toBe(bn);
    expect(an).toBe('tie-B'); // larger device id wins
  });
});

describe('status, errors and retries', () => {
  it('goes offline on network errors, keeps pending changes and recovers', async () => {
    const { a, server } = await pair();
    const seen: SyncStatus[] = [];
    const unsubscribe = a.engine.subscribe((s) => seen.push(s));
    await a.db.trips.insert(trip('later'));
    server.failWith = new TrailPackError('network', 'fetch failed');
    await expect(a.engine.syncOnce()).rejects.toMatchObject({ code: 'network' });
    expect(a.engine.getStatus()).toMatchObject({ state: 'offline', lastError: 'fetch failed', pending: 1, lastSyncAt: null });
    server.failWith = undefined;
    await a.engine.syncOnce();
    expect(a.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, pending: 0, lastSyncAt: '2026-04-01T08:00:00.000Z' });
    expect(seen.map((s) => s.state)).toEqual(expect.arrayContaining(['syncing', 'offline', 'idle']));
    unsubscribe();
    const n = seen.length;
    await a.db.trips.insert(trip('x'));
    await a.engine.syncOnce();
    expect(seen.length).toBe(n);
  });

  it('flags server errors as error state and wraps unknown failures', async () => {
    const { a, server } = await pair();
    server.failWith = new TrailPackError('provider_error', 'HTTP 500', { status: 500 });
    await expect(a.engine.syncOnce()).rejects.toMatchObject({ code: 'provider_error' });
    expect(a.engine.getStatus().state).toBe('error');
    server.failWith = new Error('weird');
    await expect(a.engine.syncOnce()).rejects.toBeInstanceOf(TrailPackError);
  });

  it('rejects malformed server responses', async () => {
    const { a, server } = await pair();
    server.push = async () => ({ nope: true }) as never;
    await a.db.trips.insert(trip('x'));
    await expect(a.engine.syncOnce()).rejects.toBeInstanceOf(TrailPackError);
    expect(a.engine.getStatus().state).toBe('error');
    expect(await a.db.outbox.count()).toBe(1);
  });

  it('shares one cycle between concurrent callers', async () => {
    const { a, server } = await pair();
    await a.db.trips.insert(trip('x'));
    const [r1, r2] = await Promise.all([a.engine.syncOnce(), a.engine.syncOnce()]);
    expect(r1).toBe(r2);
    expect(server.pushCalls).toHaveLength(1);
  });

  it('refreshStatus reads counters from the database', async () => {
    const { a } = await pair();
    await a.db.trips.insert(trip('x'));
    expect((await a.engine.refreshStatus()).pending).toBe(1);
  });

  it('computes capped exponential backoff with jitter', () => {
    expect([1, 2, 3, 4, 5].map((n) => computeBackoffMs(n, 100, 1000))).toEqual([100, 200, 400, 800, 1000]);
    expect(computeBackoffMs(0, 100, 1000)).toBe(0);
    expect(computeBackoffMs(2, 100, 1000, 0.5, () => 1)).toBe(100);
    expect(computeBackoffMs(500, 100, 1000)).toBe(1000);
  });

  it('start() polls at the interval, backs off after failures and resets on notifyOnline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { a, server } = await pair();
    server.failWith = new TrailPackError('network', 'down');
    const opts = { intervalMs: 10_000, backoffBaseMs: 100, backoffMaxMs: 400, jitter: 0, random: () => 0 };
    a.engine.start(opts);
    const calls = () => server.pushCalls.length + server.pullCalls.length;
    // an empty outbox skips push, so count pulls
    await vi.advanceTimersByTimeAsync(0);
    expect(server.pullCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(server.pullCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.pullCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(server.pullCalls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(400);
    expect(server.pullCalls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(400); // capped at 400
    expect(server.pullCalls).toHaveLength(5);
    expect(a.engine.getStatus().state).toBe('offline');

    server.failWith = undefined;
    a.engine.notifyOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.pullCalls).toHaveLength(6);
    expect(a.engine.getStatus().state).toBe('idle');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(server.pullCalls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.pullCalls).toHaveLength(7);

    a.engine.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.pullCalls).toHaveLength(7);
    expect(calls()).toBe(7);
  });

  it('notifyOnline without start() triggers a single sync', async () => {
    const { a, server } = await pair();
    a.engine.notifyOnline();
    await vi.waitFor(() => expect(server.pullCalls).toHaveLength(1));
  });
});

describe('hash helpers', () => {
  it('hashString is stable and sensitive', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('abc')).toHaveLength(14);
  });

  it('contentHash ignores updatedAt and key order, but not content or deletion', () => {
    const base = { id: '1', name: 'x', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null };
    expect(contentHash(base)).toBe(contentHash({ name: 'x', deletedAt: null, updatedAt: '2030-01-01T00:00:00.000Z', id: '1' }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, name: 'y' }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, deletedAt: '2026-02-01T00:00:00.000Z' }));
    expect(contentHash({ ...base, deletedAt: 'a' })).toBe(contentHash({ ...base, deletedAt: 'b' }));
  });
});
