/*
 * Compares oracle and local tick records.
 *
 * Normalizations (each is counted in `stats`):
 *  - Storage-generated document ids (random in screeps/storage). Documents created during the run are
 *    paired across sides, first by equal raw id and type, then by equal content with already-paired
 *    ids substituted; a pairing is kept for the rest of the run. Paired local ids are rewritten to the
 *    oracle id. Unpaired documents keep their ids prefixed `oracle:`/`local:` and surface as
 *    missing/extra documents.
 *  - Pairing only: the `date` of `users.money`/`users.resources` documents is matched as an instant
 *    (upstream `new Date()` is persisted as an ISO-8601 string by the storage RPC/LokiJS; the local
 *    world stores epoch milliseconds). The raw values are still diffed; the representation difference
 *    is reported under its named divergence (divergences.ts).
 *  - `processedRooms` is compared as a set (the local result lists failed rooms separately); room
 *    processing order itself is compared through the per-tick processing order (simulation.ts).
 *  - Rooms without stat increments are dropped from `roomStats` (local reports every processed room).
 * Not compared: static terrain, shard configuration, the local id counter.
 * Everything else, including the random generator state after each tick, must be equal after a JSON
 * round trip (what persistence keeps on both sides).
 */
import { createRequire } from 'node:module';
import type { Shared } from './shared.cts';
import type { Difference, ObservedWorld, ProcessingOrder, TickRecord } from './types.ts';
import { required } from '../assert.ts';

const shared = createRequire(import.meta.url)('./shared.cts') as Shared;
type Document = { _id: string; type?: string; date?: string | number; [key: string]: unknown };
type Collections = Partial<
  Record<(typeof shared.COLLECTIONS)[number][1], Record<string, Document>>
>;
type ComparisonRecord = Pick<TickRecord, 'processedRooms' | 'roomErrors' | 'loopErrors'> &
  Partial<Omit<TickRecord, 'world'>> & { world: Partial<ObservedWorld> };
// JSON persistence is the comparison boundary: documents retain upstream-only fields.
const collections = (world: Partial<ObservedWorld>): Collections => world as unknown as Collections;

const { COLLECTIONS } = shared;
const FIELDS = COLLECTIONS.map(([, field]) => field);
const DATE_COLLECTIONS: Array<'usersMoney' | 'usersResources'> = ['usersMoney', 'usersResources'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTITY_FIELDS = [
  'type',
  'user',
  'room',
  'x',
  'y',
  'name',
  'resourceType',
  'creepId',
  'powerCreepId',
];
const MAX_DIFFERING_FIELDS = 3;

const json = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

function stable(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${String(stable(object[key]))}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function mapStrings<T>(value: T, fn: (value: string) => string): T {
  if (Array.isArray(value)) return value.map((item: unknown) => mapStrings(item, fn)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[fn(key)] = mapStrings(item, fn);
    return out as T;
  }
  return (typeof value === 'string' ? fn(value) : value) as T;
}

const pathOf = (parent: string, key: string) =>
  /^[\w$-]+$/.test(key) ? (parent ? `${parent}.${key}` : key) : `${parent}[${JSON.stringify(key)}]`;

export function createComparator(initialWorld: Partial<ObservedWorld>) {
  const initialIds = new Set<string>();
  for (const field of FIELDS)
    for (const id of Object.keys(initialWorld[field] ?? {})) initialIds.add(id);
  const oracleLabels = new Map<string, string>();
  const localLabels = new Map<string, string>();
  const localByLabel = new Map<string, string>();
  const stats = {
    pairedByRawId: 0,
    pairedByContent: 0,
    pairedBySimilarity: 0,
    unpairedDocumentTicks: 0,
  };
  const isGenerated = (id: string) => !initialIds.has(id);

  function pair(oracleId: string, localId: string) {
    oracleLabels.set(oracleId, oracleId);
    localLabels.set(localId, oracleId);
    localByLabel.set(oracleId, localId);
  }

  function pairNewDocuments(
    oracleWorld: Partial<ObservedWorld>,
    localWorld: Partial<ObservedWorld>,
  ) {
    for (const field of FIELDS) {
      const localNew = Object.values(collections(localWorld)[field] ?? {}).filter(
        (doc) => isGenerated(doc._id) && !localLabels.has(doc._id),
      );
      for (const doc of Object.values(collections(oracleWorld)[field] ?? {})) {
        if (!isGenerated(doc._id) || oracleLabels.has(doc._id)) continue;
        const match = localNew.find(
          (c) => c._id === doc._id && c.type === doc.type && !localLabels.has(c._id),
        );
        if (match) {
          pair(doc._id, match._id);
          stats.pairedByRawId++;
        }
      }
    }
    // Content pairing, repeated while it makes progress (documents may reference each other).
    const signature = (doc: Document, labels: Map<string, string>, generated: Set<string>) =>
      stable(
        mapStrings(
          { ...doc, _id: undefined },
          (s) => labels.get(s) ?? (generated.has(s) ? '?' : s),
        ),
      );
    for (let progress = true; progress;) {
      progress = false;
      const oracleGenerated = new Set<string>();
      const localGenerated = new Set<string>();
      for (const field of FIELDS) {
        for (const id of Object.keys(collections(oracleWorld)[field] ?? {}))
          if (isGenerated(id) && !oracleLabels.has(id)) oracleGenerated.add(id);
        for (const id of Object.keys(collections(localWorld)[field] ?? {}))
          if (isGenerated(id) && !localLabels.has(id)) localGenerated.add(id);
      }
      for (const field of FIELDS) {
        const localNew = Object.values(collections(localWorld)[field] ?? {}).filter(
          (doc) => localGenerated.has(doc._id) && !localLabels.has(doc._id),
        );
        const localSignatures: Array<string | undefined | null> = localNew.map((doc) =>
          signature(doc, localLabels, localGenerated),
        );
        for (const doc of Object.values(collections(oracleWorld)[field] ?? {})) {
          if (!oracleGenerated.has(doc._id) || oracleLabels.has(doc._id)) continue;
          const index = localSignatures.indexOf(signature(doc, oracleLabels, oracleGenerated));
          if (index === -1) continue;
          pair(doc._id, required(localNew[index])._id);
          localSignatures[index] = null;
          stats.pairedByContent++;
          progress = true;
        }
      }
    }
    // Similarity pairing for documents that differ in content (a real difference must be reported field
    // by field, not as a missing and an extra document): identity fields must agree, at most
    // MAX_DIFFERING_FIELDS other top-level fields may differ, and the closest candidate must be unique.
    for (const field of FIELDS) {
      const relabel = (doc: Document, labels: Map<string, string>): Record<string, unknown> =>
        mapStrings({ ...doc, _id: undefined }, (s) => labels.get(s) ?? s);
      const localNew = Object.values(collections(localWorld)[field] ?? {})
        .filter((doc) => isGenerated(doc._id) && !localLabels.has(doc._id))
        .map((doc) => ({ doc, view: relabel(doc, localLabels) }));
      for (const doc of Object.values(collections(oracleWorld)[field] ?? {})) {
        if (!isGenerated(doc._id) || oracleLabels.has(doc._id)) continue;
        const view = relabel(doc, oracleLabels);
        const scored = localNew
          .filter(
            (c) =>
              !localLabels.has(c.doc._id) &&
              IDENTITY_FIELDS.every((key) => stable(c.view[key]) === stable(view[key])),
          )
          .map((c) => ({
            c,
            score: [...new Set([...Object.keys(view), ...Object.keys(c.view)])].filter(
              (key) => stable(view[key]) !== stable(c.view[key]),
            ).length,
          }))
          .sort((a, b) => a.score - b.score);
        if (
          !scored.length ||
          required(scored[0]).score > MAX_DIFFERING_FIELDS ||
          (scored[1] && scored[1].score === required(scored[0]).score)
        )
          continue;
        pair(doc._id, required(scored[0]).c.doc._id);
        stats.pairedBySimilarity++;
      }
    }
  }

  function canonical(
    record: ComparisonRecord,
    labels: Map<string, string>,
    side: string,
  ): ComparisonRecord {
    const unpaired = new Set<string>();
    for (const field of FIELDS) {
      for (const id of Object.keys(record.world[field] ?? {}))
        if (isGenerated(id) && !labels.has(id)) unpaired.add(id);
    }
    stats.unpairedDocumentTicks += unpaired.size;
    return mapStrings(record, (s) => labels.get(s) ?? (unpaired.has(s) ? `${side}:${s}` : s));
  }

  function parseIsoDates(world: Partial<ObservedWorld>) {
    for (const field of DATE_COLLECTIONS) {
      for (const doc of Object.values(collections(world)[field] ?? {})) {
        if (typeof doc.date === 'string' && ISO_DATE.test(doc.date))
          doc.date = Date.parse(doc.date);
      }
    }
  }

  function project(record: ComparisonRecord) {
    const world = record.world;
    const out: Record<string, unknown> = { gameTime: world.gameTime, rngState: world.rngState };
    for (const field of FIELDS) out[field] = world[field] ?? {};
    out.activeRooms = world.activeRooms ?? [];
    out.roomEventLogs = world.roomEventLogs ?? {};
    out.mapViews = world.mapViews ?? {};
    out.history = record.history ?? {};
    const roomStats: TickRecord['roomStats'] = {};
    for (const [room, users] of Object.entries(record.roomStats ?? {})) {
      if (Object.keys(users).length) roomStats[room] = users;
    }
    out.roomStats = roomStats;
    out.processedRooms = [...record.processedRooms].sort();
    out.roomErrors = record.roomErrors.map((error) => error.room).sort();
    out.loopErrors = record.loopErrors.length;
    return json(out);
  }

  function diff(oracle: unknown, local: unknown, path: string, out: Difference[]) {
    if (stable(oracle) === stable(local)) return;
    const objects =
      oracle !== null &&
      local !== null &&
      typeof oracle === 'object' &&
      typeof local === 'object' &&
      Array.isArray(oracle) === Array.isArray(local);
    if (objects) {
      const oracleObject = oracle as Record<string, unknown>;
      const localObject = local as Record<string, unknown>;
      const keys = new Set([...Object.keys(oracleObject), ...Object.keys(localObject)]);
      for (const key of keys) diff(oracleObject[key], localObject[key], pathOf(path, key), out);
      return;
    }
    out.push({ path, oracle, local });
  }

  return {
    stats,
    /** Local id of an oracle document id (fixture ids are shared; generated ids once paired). */
    localIdOf(oracleId: string) {
      return isGenerated(oracleId) ? localByLabel.get(oracleId) : oracleId;
    },
    compareTick(oracleRecord: TickRecord, localRecord: TickRecord) {
      const oracleJson = json(oracleRecord);
      const localJson = json(localRecord);
      // Pairing treats an ISO date and the epoch number of the same instant as equal content; the
      // differences themselves are computed on the raw values.
      const oracleForPairing = json(oracleJson.world);
      parseIsoDates(oracleForPairing);
      pairNewDocuments(oracleForPairing, localJson.world);
      const differences: Difference[] = [];
      diff(
        project(canonical(oracleJson, oracleLabels, 'oracle')),
        project(canonical(localJson, localLabels, 'local')),
        '',
        differences,
      );
      return differences;
    },
    /** Oracle-labelled processing order of the local tick (ids translated through the pairing). */
    labelOrder(order: ProcessingOrder): ProcessingOrder {
      const out: ProcessingOrder = {};
      for (const [room, ids] of Object.entries(order))
        out[room] = ids.map((id) => localLabels.get(id) ?? id);
      return out;
    },
  };
}
