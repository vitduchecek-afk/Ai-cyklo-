import { describe, expect, it, vi } from 'vitest';
import { TrailPackError, type KeyValueCache } from '@trailpack/shared';
import { DRIVERS, makeDb, tripDraft } from './helpers';
import { LATEST_SCHEMA_VERSION, migrate } from '../src/migrations';
import { SYNCED_ENTITIES } from '@trailpack/shared';
import { SqlJsDriver, type SqlJsDatabaseLike } from '../src/drivers/sqljs';
import { createExpoSqliteDriver, type ExpoSqliteDatabaseLike } from '../src/drivers/expo';

describe.each(DRIVERS)('database on %s', (_name, factory) => {
  describe('migrations', () => {
    it('creates every table and is idempotent', async () => {
      const { db, driver } = await makeDb(factory);
      expect(await db.migrate()).toBe(LATEST_SCHEMA_VERSION);
      expect(await migrate(driver)).toBe(LATEST_SCHEMA_VERSION);
      const tables = (await driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
      for (const e of SYNCED_ENTITIES) expect(tables).toContain(e);
      for (const t of ['settings', 'kv_cache', 'sync_outbox', 'sync_state', 'sync_conflicts', 'gps_points', 'search_history', 'exchange_rates', 'schema_migrations']) {
        expect(tables).toContain(t);
      }
      const rows = await driver.all('SELECT * FROM schema_migrations');
      expect(rows).toHaveLength(1);
    });

    it('rolls a failing migration back completely', async () => {
      const { driver } = await makeDb(factory);
      await expect(
        migrate(driver, [
          {
            version: 99,
            name: 'broken',
            async up(tx) {
              await tx.exec('CREATE TABLE half_done (x INTEGER)');
              throw new Error('boom');
            },
          },
        ]),
      ).rejects.toThrow('boom');
      expect(await driver.get("SELECT name FROM sqlite_master WHERE name = 'half_done'")).toBeUndefined();
      expect(await driver.get('SELECT version FROM schema_migrations WHERE version = 99')).toBeUndefined();
    });
  });

  describe('CRUD', () => {
    it('inserts with generated base fields and defaults', async () => {
      const { db } = await makeDb(factory);
      const trip = await db.trips.insert(tripDraft());
      expect(trip).toMatchObject({ id: 'id-1', createdAt: '2026-03-01T10:00:00.000Z', deletedAt: null, status: 'planning', participantsCount: 1 });
      expect(await db.trips.get('id-1')).toEqual(trip);
    });

    it('rejects invalid data and duplicate ids', async () => {
      const { db } = await makeDb(factory);
      await expect(db.trips.insert({ name: '' })).rejects.toMatchObject({ code: 'invalid_input' });
      await db.trips.insert({ ...tripDraft(), id: 'same' });
      await expect(db.trips.insert({ ...tripDraft(), id: 'same' })).rejects.toBeInstanceOf(TrailPackError);
      await expect(db.trips.insert({ ...tripDraft(), id: 'same' })).rejects.toMatchObject({ code: 'conflict' });
    });

    it('updates by merging, bumping updatedAt and validating', async () => {
      const { db, clock } = await makeDb(factory);
      const t = await db.trips.insert(tripDraft());
      clock.advance(5000);
      const u = await db.trips.update(t.id, { name: 'Krkonoše', status: 'ready' });
      expect(u).toMatchObject({ name: 'Krkonoše', status: 'ready', createdAt: t.createdAt, updatedAt: '2026-03-01T10:00:05.000Z' });
      await expect(db.trips.update(t.id, { name: '' })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(db.trips.update('missing', { name: 'x' })).rejects.toMatchObject({ code: 'not_found' });
      expect((await db.trips.get(t.id))?.name).toBe('Krkonoše');
    });

    it('keeps updatedAt strictly increasing even if the clock stands still', async () => {
      const { db } = await makeDb(factory);
      const t = await db.trips.insert(tripDraft());
      const u = await db.trips.update(t.id, { name: 'B' });
      expect(Date.parse(u.updatedAt)).toBeGreaterThan(Date.parse(t.updatedAt));
    });

    it('lists with where, order, limit, offset and JSON fields', async () => {
      const { db } = await makeDb(factory);
      await db.trips.insert({ ...tripDraft('A'), status: 'ready', startDate: '2026-06-01' });
      await db.trips.insert({ ...tripDraft('B'), status: 'idea', startDate: '2026-05-01' });
      await db.trips.insert({ ...tripDraft('C'), status: 'ready', startDate: '2026-07-01', favorite: true });
      expect((await db.trips.byStatus('ready')).map((t) => t.name)).toEqual(['A', 'C']);
      expect((await db.trips.list({ orderBy: { field: 'startDate', direction: 'desc' } })).map((t) => t.name)).toEqual(['C', 'A', 'B']);
      expect((await db.trips.list({ orderBy: { field: 'name' }, limit: 1, offset: 1 })).map((t) => t.name)).toEqual(['B']);
      expect((await db.trips.list({ where: { favorite: true } })).map((t) => t.name)).toEqual(['C']);
      expect((await db.trips.list({ where: { status: ['idea', 'ready'] } })).length).toBe(3);
      expect(await db.trips.list({ where: { status: [] } })).toEqual([]);
      expect(await db.trips.count({ status: 'ready' })).toBe(2);
      expect(await db.trips.count()).toBe(3);
    });

    it('rejects field names that could inject SQL', async () => {
      const { db } = await makeDb(factory);
      await expect(db.trips.list({ where: { "name') OR 1=1 --": 'x' } })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(db.trips.list({ orderBy: { field: 'name; DROP TABLE trips' } })).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('searches with escaped LIKE wildcards', async () => {
      const { db } = await makeDb(factory);
      await db.trips.insert(tripDraft('100% hory'));
      await db.trips.insert(tripDraft('Plain'));
      await db.trips.insert(tripDraft('a_b'));
      expect((await db.trips.search('100%')).map((t) => t.name)).toEqual(['100% hory']);
      expect((await db.trips.search('%')).map((t) => t.name)).toEqual(['100% hory']);
      expect((await db.trips.search('a_b')).map((t) => t.name)).toEqual(['a_b']);
      expect(await db.trips.search('plain')).toHaveLength(1);
      expect(await db.trips.search('   ')).toEqual([]);
    });

    it('upsert keeps timestamps and replaces rows', async () => {
      const { db } = await makeDb(factory);
      const t = await db.trips.insert(tripDraft());
      const replaced = await db.trips.upsert({ ...t, name: 'Remote', updatedAt: '2030-01-01T00:00:00.000Z' });
      expect(replaced.updatedAt).toBe('2030-01-01T00:00:00.000Z');
      expect(await db.trips.count()).toBe(1);
      expect((await db.trips.get(t.id))?.name).toBe('Remote');
    });

    it('finders for related entities', async () => {
      const { db } = await makeDb(factory);
      const trip = await db.trips.insert(tripDraft());
      await db.tripDays.insert({ tripId: trip.id, dayIndex: 1 });
      await db.tripDays.insert({ tripId: trip.id, dayIndex: 0 });
      await db.tripDays.insert({ tripId: 'other', dayIndex: 0 });
      expect((await db.tripDays.byTrip(trip.id)).map((d) => d.dayIndex)).toEqual([0, 1]);
      const cl = await db.checklists.insert({ tripId: trip.id, name: 'Balení' });
      await db.checklistItems.insert({ checklistId: cl.id, text: 'b', sortOrder: 2 });
      await db.checklistItems.insert({ checklistId: cl.id, text: 'a', sortOrder: 1 });
      expect((await db.checklistItems.byChecklist(cl.id)).map((i) => i.text)).toEqual(['a', 'b']);
      const conv = await db.aiConversations.insert({ tripId: trip.id, title: 'Chat' } as never);
      await db.aiMessages.insert({ conversationId: conv.id, role: 'user', content: 'hi' });
      expect(await db.aiMessages.byConversation(conv.id)).toHaveLength(1);
      const cat = await db.gearCategories.insert({ key: 'shelter', name: 'Přístřeší' });
      await db.gearItems.insert({ name: 'Stan', categoryKey: 'shelter', weightG: 900 } as never);
      expect(await db.gearItems.byCategory('shelter')).toHaveLength(1);
      expect(cat.key).toBe('shelter');
    });
  });

  describe('soft delete', () => {
    it('hides tombstones, restores and hard deletes', async () => {
      const { db, clock } = await makeDb(factory);
      const t = await db.trips.insert(tripDraft());
      clock.advance(1000);
      const tomb = await db.trips.softDelete(t.id);
      expect(tomb?.deletedAt).toBe('2026-03-01T10:00:01.000Z');
      expect(await db.trips.get(t.id)).toBeUndefined();
      expect(await db.trips.get(t.id, { includeDeleted: true })).toBeDefined();
      expect(await db.trips.list()).toHaveLength(0);
      expect(await db.trips.list({ includeDeleted: true })).toHaveLength(1);
      expect(await db.trips.softDelete(t.id)).toBeUndefined();
      clock.advance(1000);
      const back = await db.trips.restore(t.id);
      expect(back?.deletedAt).toBeNull();
      expect(await db.trips.count()).toBe(1);
      expect(await db.trips.restore('nope')).toBeUndefined();
      expect(await db.trips.hardDelete(t.id)).toBe(true);
      expect(await db.trips.hardDelete(t.id)).toBe(false);
      expect(await db.trips.count(undefined, true)).toBe(0);
    });
  });

  describe('outbox', () => {
    it('does not track by default and tracks once enabled', async () => {
      const { db } = await makeDb(factory);
      await db.trips.insert(tripDraft());
      expect(await db.outbox.count()).toBe(0);
      db.setTrackChanges(true);
      await db.trips.insert(tripDraft('B'));
      expect(await db.outbox.count()).toBe(1);
    });

    it('records upserts / deletes, compacts per entity and ignores sync writes', async () => {
      const { db, clock } = await makeDb(factory, { trackChanges: true });
      const t = await db.trips.insert(tripDraft());
      clock.advance(10);
      await db.trips.update(t.id, { name: 'Two' });
      let pending = await db.outbox.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ entity: 'trips', entityId: t.id, op: 'upsert', deviceId: 'dev-A' });
      expect((pending[0]!.payload as { name: string }).name).toBe('Two');
      clock.advance(10);
      await db.trips.softDelete(t.id);
      pending = await db.outbox.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.op).toBe('delete');
      expect(pending[0]!.payload).toMatchObject({ deletedAt: expect.any(String) });
      await db.trips.upsert({ ...t, id: 'remote-1' }, { fromSync: true });
      expect(await db.outbox.count()).toBe(1);
      await db.trips.insert(tripDraft('C'));
      const all = await db.outbox.pending();
      expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b));
      expect(await db.outbox.markSent(all.map((e) => e.seq))).toBe(2);
      expect(await db.outbox.count()).toBe(0);
    });

    it('queues a tombstone for hard deletes and can enqueue everything', async () => {
      const { db } = await makeDb(factory);
      const a = await db.trips.insert(tripDraft('A'));
      await db.trips.insert(tripDraft('B'));
      await db.trips.softDelete(a.id);
      db.setTrackChanges(true);
      expect(await db.outbox.enqueueAll()).toBe(2);
      const ops = (await db.outbox.pending()).map((e) => e.op).sort();
      expect(ops).toEqual(['delete', 'upsert']);
      await db.trips.hardDelete(a.id);
      expect((await db.outbox.pendingFor('trips', a.id))[0]?.op).toBe('delete');
    });

    it('rolls the entity write back when the outbox write fails', async () => {
      const { db, driver } = await makeDb(factory, { trackChanges: true });
      await driver.exec('DROP TABLE sync_outbox');
      await expect(db.trips.insert(tripDraft())).rejects.toThrow();
      expect(await db.trips.count()).toBe(0);
    });
  });

  describe('deleteTripCascade', () => {
    it('soft-deletes everything that belongs to the trip', async () => {
      const { db } = await makeDb(factory, { trackChanges: true });
      const route = await db.routes.insert({
        name: 'R', source: 'manual', geometry: [[14, 50], [14.1, 50.1]], distanceM: 1, ascentM: 0, descentM: 0, activityType: 'hiking',
      } as never);
      const trip = await db.trips.insert({ ...tripDraft(), routeId: route.id });
      const other = await db.trips.insert(tripDraft('Other'));
      await db.tripDays.insert({ tripId: trip.id, dayIndex: 0 });
      await db.tripDays.insert({ tripId: other.id, dayIndex: 0 });
      const cl = await db.checklists.insert({ tripId: trip.id, name: 'C' });
      await db.checklistItems.insert({ checklistId: cl.id, text: 'x' });
      await db.expenses.insert({ tripId: trip.id, category: 'food', amount: 10, currency: 'CZK' });
      await db.tripParticipants.insert({ tripId: trip.id, name: 'Eva' });
      await db.journalEntries.insert({ tripId: trip.id });
      await db.tripComments.insert({ tripId: trip.id, text: 'hi', authorName: 'Eva' });
      await db.mealPlans.insert({ tripId: trip.id, name: 'M', days: 2, people: 1, targetKcalPerDay: 2500 });
      await db.outbox.clear();

      const deleted = await db.deleteTripCascade(trip.id);
      expect(deleted).toMatchObject({ trips: 1, trip_days: 1, checklists: 1, checklist_items: 1, expenses: 1, trip_participants: 1, journal_entries: 1, routes: 1 });
      expect(await db.trips.get(trip.id)).toBeUndefined();
      expect(await db.routes.get(route.id)).toBeUndefined();
      expect(await db.tripDays.byTrip(trip.id)).toHaveLength(0);
      expect(await db.tripDays.byTrip(other.id)).toHaveLength(1);
      expect(await db.trips.get(other.id)).toBeDefined();
      expect((await db.outbox.pending(100)).every((e) => e.op === 'delete')).toBe(true);
      expect(await db.outbox.count()).toBeGreaterThanOrEqual(8);
      expect(await db.deleteTripCascade('missing')).toEqual({});
    });
  });

  describe('settings', () => {
    it('returns validated defaults, merges patches and rejects invalid values', async () => {
      const { db } = await makeDb(factory);
      const defaults = await db.settings.get();
      expect(defaults).toMatchObject({ language: 'cs', units: 'metric', currency: 'CZK', aiMode: 'off', syncEnabled: false });
      const next = await db.settings.set({ units: 'imperial', fontScale: 1.2 });
      expect(next).toMatchObject({ units: 'imperial', fontScale: 1.2, language: 'cs' });
      expect((await db.settings.get()).units).toBe('imperial');
      await expect(db.settings.set({ fontScale: 99 })).rejects.toMatchObject({ code: 'invalid_input' });
      expect((await db.settings.get()).fontScale).toBe(1.2);
    });

    it('salvages valid keys from a corrupted stored value', async () => {
      const { db, driver } = await makeDb(factory);
      await driver.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['app', JSON.stringify({ units: 'imperial', fontScale: 'huge', theme: 'dark' })]);
      expect(await db.settings.get()).toMatchObject({ units: 'imperial', theme: 'dark', fontScale: 1 });
      await driver.run('UPDATE settings SET value = ?', ['not json']);
      expect((await db.settings.get()).units).toBe('metric');
    });
  });

  describe('cache', () => {
    it('stores values with TTL and exposes stale entries', async () => {
      const { db, clock } = await makeDb(factory);
      const cache: KeyValueCache = db.cache;
      await cache.set('weather:a', { t: 12 }, 1000);
      const hit = await cache.get<{ t: number }>('weather:a');
      expect(hit).toMatchObject({ value: { t: 12 }, storedAt: clock.now(), expiresAt: clock.now() + 1000 });
      clock.advance(5000);
      const stale = await cache.get('weather:a');
      expect(stale!.expiresAt).toBeLessThan(clock.now());
      expect(await cache.get('nope')).toBeUndefined();
    });

    it('clears by prefix (escaped), deletes and prunes', async () => {
      const { db, clock } = await makeDb(factory);
      await db.cache.set('a_1', 1, 10);
      await db.cache.set('a_2', 2, 10);
      await db.cache.set('axb', 3, 10);
      await db.cache.clear('a_');
      expect(await db.cache.size()).toBe(1);
      await db.cache.delete('axb');
      expect(await db.cache.size()).toBe(0);

      await db.cache.set('old', 1, 1000);
      clock.advance(10 * 24 * 3600 * 1000);
      await db.cache.set('new', 1, 1000);
      expect(await db.cache.prune()).toBe(1);
      expect(await db.cache.get('old')).toBeUndefined();
      for (let i = 0; i < 5; i++) {
        clock.advance(1);
        await db.cache.set(`k${i}`, i, 100000);
      }
      expect(await db.cache.prune({ maxEntries: 3 })).toBe(3);
      expect(await db.cache.size()).toBe(3);
      expect(await db.cache.get('k4')).toBeDefined();
    });
  });

  describe('gps points', () => {
    it('appends batches with continuing sequence numbers and reads pages', async () => {
      const { db } = await makeDb(factory);
      await db.gpsPoints.appendBatch('act', [{ lat: 50, lon: 14, ele: 300, time: 1 }, { lat: 50.1, lon: 14.1 }]);
      await db.gpsPoints.appendBatch('act', [{ lat: 50.2, lon: 14.2, accuracy: 5, speed: 1.5 }]);
      await db.gpsPoints.appendBatch('other', [{ lat: 1, lon: 1 }]);
      expect(await db.gpsPoints.count('act')).toBe(3);
      const all = await db.gpsPoints.read('act');
      expect(all).toEqual([{ lat: 50, lon: 14, ele: 300, time: 1 }, { lat: 50.1, lon: 14.1 }, { lat: 50.2, lon: 14.2, accuracy: 5, speed: 1.5 }]);
      expect(await db.gpsPoints.read('act', { from: 1, limit: 1 })).toEqual([{ lat: 50.1, lon: 14.1 }]);
      expect(await db.gpsPoints.deleteForActivity('act')).toBe(3);
      expect(await db.gpsPoints.count('act')).toBe(0);
      expect(await db.gpsPoints.count('other')).toBe(1);
    });

    it('validates points atomically', async () => {
      const { db } = await makeDb(factory);
      await expect(db.gpsPoints.appendBatch('a', [{ lat: 1, lon: 1 }, { lat: 99, lon: 1 }])).rejects.toThrow();
      expect(await db.gpsPoints.count('a')).toBe(0);
      expect(await db.gpsPoints.appendBatch('a', [])).toBe(0);
    });
  });

  describe('search history and exchange rates', () => {
    it('dedupes, orders and caps search history', async () => {
      const { db, clock } = await makeDb(factory);
      await db.searchHistory.add({ query: 'Praha', lat: 50, lon: 14 });
      clock.advance(1000);
      await db.searchHistory.add({ query: 'Brno', label: 'Brno, CZ' });
      clock.advance(1000);
      await db.searchHistory.add({ query: ' Praha ' });
      expect((await db.searchHistory.list()).map((e) => e.query)).toEqual(['Praha', 'Brno']);
      await expect(db.searchHistory.add({ query: '  ' })).rejects.toMatchObject({ code: 'invalid_input' });
      for (let i = 0; i < 60; i++) {
        clock.advance(1);
        await db.searchHistory.add({ query: `q${i}` });
      }
      expect(await db.searchHistory.list(100)).toHaveLength(50);
      await db.searchHistory.clear();
      expect(await db.searchHistory.list()).toEqual([]);
    });

    it('stores rates and returns the latest or the latest before a date', async () => {
      const { db } = await makeDb(factory);
      await db.exchangeRates.set({ base: 'EUR', quote: 'CZK', rate: 24.5, date: '2026-02-01', source: 'ecb' });
      await db.exchangeRates.set({ base: 'EUR', quote: 'CZK', rate: 25, date: '2026-03-01', source: 'ecb' });
      await db.exchangeRates.set({ base: 'EUR', quote: 'CZK', rate: 25.1, date: '2026-03-01', source: 'cnb' });
      expect(await db.exchangeRates.get('EUR', 'CZK')).toMatchObject({ rate: 25.1, date: '2026-03-01', source: 'cnb' });
      expect((await db.exchangeRates.get('EUR', 'CZK', '2026-02-15'))?.rate).toBe(24.5);
      expect(await db.exchangeRates.get('EUR', 'CZK', '2026-01-01')).toBeUndefined();
      expect(await db.exchangeRates.get('USD', 'CZK')).toBeUndefined();
      await expect(db.exchangeRates.set({ base: 'eur', quote: 'CZK', rate: 1, date: '2026-01-01', source: 'x' })).rejects.toThrow();
    });
  });

  describe('sync state and conflicts', () => {
    it('stores state values and conflicts', async () => {
      const { db } = await makeDb(factory);
      expect(await db.syncState.get('cursor')).toBeUndefined();
      await db.syncState.set('cursor', '5');
      await db.syncState.set('cursor', '9');
      expect(await db.syncState.get('cursor')).toBe('9');
      const c = await db.conflicts.add({ entity: 'trips', entityId: 't1', local: { a: 1 }, remote: { a: 2 } });
      expect(await db.conflicts.list()).toEqual([c]);
      expect(await db.conflicts.resolve(c.id)).toBe(true);
      expect(await db.conflicts.resolve(c.id)).toBe(false);
      expect(await db.conflicts.list()).toEqual([]);
      expect(await db.conflicts.list({ includeResolved: true })).toHaveLength(1);
    });
  });

  describe('transactions', () => {
    it('rolls back db.transaction on error and supports nesting', async () => {
      const { db } = await makeDb(factory);
      await expect(
        db.transaction(async (tx) => {
          await tx.trips.insert(tripDraft('inside'));
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await db.trips.count()).toBe(0);
      await db.transaction(async (tx) => {
        await tx.trips.insert(tripDraft('kept'));
        await expect(
          tx.driver.transaction(async (inner) => {
            await inner.run('DELETE FROM trips');
            throw new Error('inner');
          }),
        ).rejects.toThrow('inner');
      });
      expect(await db.trips.count()).toBe(1);
    });

    it('serialises concurrent transactions', async () => {
      const { db } = await makeDb(factory);
      await Promise.all(Array.from({ length: 10 }, (_, i) => db.transaction(async (tx) => void (await tx.trips.insert(tripDraft(`t${i}`))))));
      expect(await db.trips.count()).toBe(10);
    });
  });

  describe('backup', () => {
    async function seeded() {
      const ctx = await makeDb(factory);
      const { db } = ctx;
      const trip = await db.trips.insert(tripDraft('Backup'));
      await db.tripDays.insert({ tripId: trip.id, dayIndex: 0 });
      const gone = await db.expenses.insert({ tripId: trip.id, category: 'food', amount: 1, currency: 'CZK' });
      await db.expenses.softDelete(gone.id);
      await db.gpsPoints.appendBatch('act1', [{ lat: 50, lon: 14 }, { lat: 50.1, lon: 14.1, ele: 3 }]);
      await db.settings.set({ units: 'imperial' });
      return { ...ctx, trip };
    }

    it('round-trips through JSON into an empty database', async () => {
      const { db, trip } = await seeded();
      const file = await db.backup.exportAll();
      expect(file).toMatchObject({ format: 'trailpack-backup', version: 1, schemaVersion: LATEST_SCHEMA_VERSION });
      expect(file.entities.expenses).toHaveLength(0);
      const json = JSON.parse(JSON.stringify(file));

      const fresh = await makeDb(factory, { deviceId: 'dev-B' });
      const res = await fresh.db.backup.importAll(json, 'replace');
      expect(res).toMatchObject({ gpsPoints: 2, entities: { trips: 1, trip_days: 1 } });
      expect(await fresh.db.trips.get(trip.id)).toEqual(trip);
      expect(await fresh.db.gpsPoints.read('act1')).toHaveLength(2);
      expect((await fresh.db.settings.get()).units).toBe('imperial');
      expect(await fresh.db.backup.exportAll()).toEqual({ ...file, exportedAt: expect.any(String) });
    });

    it('replace removes rows that are not in the file, merge keeps newer local data', async () => {
      const { db, trip, clock } = await seeded();
      const file = JSON.parse(JSON.stringify(await db.backup.exportAll()));
      const extra = await db.trips.insert(tripDraft('Extra'));
      clock.advance(1000);
      await db.trips.update(trip.id, { name: 'Newer local' });

      await db.backup.importAll(file, 'merge');
      expect((await db.trips.get(trip.id))?.name).toBe('Newer local');
      expect(await db.trips.get(extra.id)).toBeDefined();
      expect(await db.gpsPoints.count('act1')).toBe(2);

      await db.backup.importAll(file, 'replace');
      expect((await db.trips.get(trip.id))?.name).toBe('Backup');
      expect(await db.trips.get(extra.id, { includeDeleted: true })).toBeUndefined();
    });

    it('queues imported rows for sync when tracking is enabled', async () => {
      const { db } = await seeded();
      const file = JSON.parse(JSON.stringify(await db.backup.exportAll()));
      const fresh = await makeDb(factory, { trackChanges: true });
      await fresh.db.backup.importAll(file, 'merge');
      expect(await fresh.db.outbox.count()).toBe(2);
    });

    it('rejects malformed files without touching data', async () => {
      const { db } = await seeded();
      const file = JSON.parse(JSON.stringify(await db.backup.exportAll()));
      await expect(db.backup.importAll({ foo: 1 }, 'merge')).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(db.backup.importAll({ ...file, version: 2 }, 'merge')).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(db.backup.importAll({ ...file, schemaVersion: 999 }, 'merge')).rejects.toMatchObject({ code: 'unsupported' });
      const bad = { ...file, entities: { ...file.entities, trips: [{ id: 'x', name: '' }] } };
      await expect(db.backup.importAll(bad, 'replace')).rejects.toMatchObject({ code: 'invalid_input' });
      expect(await db.trips.count()).toBe(1);
      const huge = { ...file, gpsPoints: [{ activityId: 'a', points: [{ lat: 100, lon: 0 }] }] };
      await expect(db.backup.importAll(huge, 'merge')).rejects.toMatchObject({ code: 'invalid_input' });
    });
  });

  describe('maintenance', () => {
    it('reports diagnostics and wipes everything', async () => {
      const { db } = await makeDb(factory, { trackChanges: true });
      await db.trips.insert(tripDraft());
      await db.gpsPoints.appendBatch('a', [{ lat: 1, lon: 1 }]);
      await db.cache.set('k', 1, 100);
      await db.conflicts.add({ entity: 'trips', entityId: 'x', local: {}, remote: {} });
      const d = await db.diagnostics();
      expect(d).toMatchObject({ schemaVersion: LATEST_SCHEMA_VERSION, gpsPoints: 1, cacheEntries: 1, outboxPending: 1, conflicts: 1 });
      expect(d.rowCounts.trips).toBe(1);
      expect(Object.keys(d.rowCounts)).toHaveLength(SYNCED_ENTITIES.length);
      await db.settings.set({ units: 'imperial' });
      await db.wipeAll();
      const after = await db.diagnostics();
      expect(after).toMatchObject({ gpsPoints: 0, cacheEntries: 0, outboxPending: 0, conflicts: 0, schemaVersion: LATEST_SCHEMA_VERSION });
      expect(after.rowCounts.trips).toBe(0);
      expect((await db.settings.get()).units).toBe('metric');
    });

    it('seeds gear categories once with deterministic ids and no outbox entries', async () => {
      const { db } = await makeDb(factory, { trackChanges: true });
      const cats = [{ key: 'shelter', name: 'Přístřeší' }, { key: 'sleep', name: 'Spaní', icon: 'moon' }];
      expect(await db.seedGearCategories(cats)).toBe(2);
      expect(await db.seedGearCategories(cats)).toBe(0);
      const list = await db.gearCategories.list({ orderBy: { field: 'sortOrder' } });
      expect(list.map((c) => c.id)).toEqual(['cat_shelter', 'cat_sleep']);
      expect(list[0]).toMatchObject({ builtin: true, icon: 'package' });
      expect(await db.outbox.count()).toBe(0);
    });
  });
});

describe('SqlJsDriver persistence', () => {
  async function open(persist: (b: Uint8Array) => Promise<void>, ms = 5) {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const driver = new SqlJsDriver(new SQL.Database() as unknown as SqlJsDatabaseLike, { persist, persistDebounceMs: ms });
    return { driver, SQL };
  }

  it('debounces exports and flushes on demand', async () => {
    const persist = vi.fn(async (_b: Uint8Array) => {});
    const { driver } = await open(persist, 20);
    await driver.exec('CREATE TABLE t (x)');
    await driver.run('INSERT INTO t VALUES (1)');
    await driver.run('INSERT INTO t VALUES (2)');
    expect(persist).not.toHaveBeenCalled();
    await driver.flush();
    expect(persist).toHaveBeenCalledTimes(1);
    await driver.flush();
    expect(persist).toHaveBeenCalledTimes(1);
    await driver.run('INSERT INTO t VALUES (3)');
    await new Promise((r) => setTimeout(r, 60));
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('persisted bytes can be reopened', async () => {
    let saved: Uint8Array | undefined;
    const { driver, SQL } = await open(async (b) => void (saved = b.slice()));
    const db = createDb(driver);
    await db.migrate();
    await db.trips.insert(tripDraft('persisted'));
    await driver.close();
    const reopened = createDb(new SqlJsDriver(new SQL.Database(saved) as unknown as SqlJsDatabaseLike));
    expect((await reopened.trips.list()).map((t) => t.name)).toEqual(['persisted']);
  });

  it('reports persist failures through onPersistError and retries', async () => {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const onPersistError = vi.fn();
    let fail = true;
    const driver = new SqlJsDriver(new SQL.Database() as unknown as SqlJsDatabaseLike, {
      persist: async () => {
        if (fail) throw new Error('disk full');
      },
      onPersistError,
    });
    await driver.exec('CREATE TABLE t (x)');
    await driver.flush();
    expect(onPersistError).toHaveBeenCalledTimes(1);
    fail = false;
    await driver.flush();
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });
});

import { createDatabase } from '../src/database';
function createDb(driver: SqlJsDriver) {
  return createDatabase(driver, { deviceId: 'x' });
}

describe('createExpoSqliteDriver', () => {
  function fakeExpo() {
    const calls: string[] = [];
    const api = {
      execAsync: async (s: string) => void calls.push(`exec:${s}`),
      runAsync: async (s: string, p: unknown[]) => (calls.push(`run:${s}:${JSON.stringify(p)}`), { changes: 2 }),
      getAllAsync: async <T,>(s: string) => (calls.push(`all:${s}`), [{ a: 1 }] as unknown as T[]),
      getFirstAsync: async <T,>(s: string) => (calls.push(`first:${s}`), null as T | null),
    };
    return { calls, api };
  }

  it('maps the async API', async () => {
    const { calls, api } = fakeExpo();
    const closeAsync = vi.fn(async () => {});
    const d = createExpoSqliteDriver({ ...api, withTransactionAsync: async (t) => t(), closeAsync });
    expect(await d.run('X', [undefined as never, true as never])).toEqual({ changes: 2 });
    expect(calls[0]).toBe('run:X:[null,1]');
    expect(await d.all('Q')).toEqual([{ a: 1 }]);
    expect(await d.get('Q')).toBeUndefined();
    await d.close();
    expect(closeAsync).toHaveBeenCalled();
  });

  it('uses exclusive transactions and savepoints for nesting', async () => {
    const { calls, api } = fakeExpo();
    const d = createExpoSqliteDriver({
      ...api,
      withExclusiveTransactionAsync: async (task) => task(api),
      closeAsync: async () => {},
    } as ExpoSqliteDatabaseLike);
    const out = await d.transaction(async (tx) => {
      await tx.run('A');
      await expect(tx.transaction(async () => { throw new Error('x'); })).rejects.toThrow('x');
      return 42;
    });
    expect(out).toBe(42);
    expect(calls.filter((c) => c.includes('SAVEPOINT') || c.includes('ROLLBACK') || c.includes('RELEASE'))).toHaveLength(3);
  });

  it('fails without a transaction API', async () => {
    const { api } = fakeExpo();
    const d = createExpoSqliteDriver({ ...api, closeAsync: async () => {} });
    await expect(d.transaction(async () => 1)).rejects.toThrow(/transaction API/);
  });
});
