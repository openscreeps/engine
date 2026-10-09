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
 *    is reported under its named divergence (divergences.mjs).
 *  - `processedRooms` is compared as a set (the local result lists failed rooms separately); room
 *    processing order itself is compared through the per-tick processing order (simulation.mjs).
 *  - Rooms without stat increments are dropped from `roomStats` (local reports every processed room).
 * Not compared: static terrain, shard configuration, the local id counter.
 * Everything else, including the random generator state after each tick, must be equal after a JSON
 * round trip (what persistence keeps on both sides).
 */
import shared from './shared.cjs';

const { COLLECTIONS } = shared;
const FIELDS = COLLECTIONS.map(([, field]) => field);
const DATE_COLLECTIONS = ['usersMoney', 'usersResources'];
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

const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function mapStrings(value, fn) {
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[fn(key)] = mapStrings(value[key], fn);
    return out;
  }
  return typeof value === 'string' ? fn(value) : value;
}

const pathOf = (parent, key) =>
  /^[\w$-]+$/.test(key) ? (parent ? `${parent}.${key}` : key) : `${parent}[${JSON.stringify(key)}]`;

export function createComparator(initialWorld) {
  const initialIds = new Set();
  for (const field of FIELDS)
    for (const id of Object.keys(initialWorld[field] ?? {})) initialIds.add(id);
  const oracleLabels = new Map();
  const localLabels = new Map();
  const localByLabel = new Map();
  const stats = {
    pairedByRawId: 0,
    pairedByContent: 0,
    pairedBySimilarity: 0,
    unpairedDocumentTicks: 0,
  };
  const isGenerated = (id) => !initialIds.has(id);

  function pair(oracleId, localId) {
    oracleLabels.set(oracleId, oracleId);
    localLabels.set(localId, oracleId);
    localByLabel.set(oracleId, localId);
  }

  function pairNewDocuments(oracleWorld, localWorld) {
    for (const field of FIELDS) {
      const localNew = Object.values(localWorld[field] ?? {}).filter(
        (doc) => isGenerated(doc._id) && !localLabels.has(doc._id),
      );
      for (const doc of Object.values(oracleWorld[field] ?? {})) {
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
    const signature = (doc, labels, generated) =>
      stable(
        mapStrings({ ...doc, _id: undefined }, (s) =>
          labels.has(s) ? labels.get(s) : generated.has(s) ? '?' : s,
        ),
      );
    for (let progress = true; progress;) {
      progress = false;
      const oracleGenerated = new Set();
      const localGenerated = new Set();
      for (const field of FIELDS) {
        for (const id of Object.keys(oracleWorld[field] ?? {}))
          if (isGenerated(id) && !oracleLabels.has(id)) oracleGenerated.add(id);
        for (const id of Object.keys(localWorld[field] ?? {}))
          if (isGenerated(id) && !localLabels.has(id)) localGenerated.add(id);
      }
      for (const field of FIELDS) {
        const localNew = Object.values(localWorld[field] ?? {}).filter(
          (doc) => localGenerated.has(doc._id) && !localLabels.has(doc._id),
        );
        const localSignatures = localNew.map((doc) => signature(doc, localLabels, localGenerated));
        for (const doc of Object.values(oracleWorld[field] ?? {})) {
          if (!oracleGenerated.has(doc._id) || oracleLabels.has(doc._id)) continue;
          const index = localSignatures.indexOf(signature(doc, oracleLabels, oracleGenerated));
          if (index === -1) continue;
          pair(doc._id, localNew[index]._id);
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
      const relabel = (doc, labels) =>
        mapStrings({ ...doc, _id: undefined }, (s) => (labels.has(s) ? labels.get(s) : s));
      const localNew = Object.values(localWorld[field] ?? {})
        .filter((doc) => isGenerated(doc._id) && !localLabels.has(doc._id))
        .map((doc) => ({ doc, view: relabel(doc, localLabels) }));
      for (const doc of Object.values(oracleWorld[field] ?? {})) {
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
          scored[0].score > MAX_DIFFERING_FIELDS ||
          (scored[1] && scored[1].score === scored[0].score)
        )
          continue;
        pair(doc._id, scored[0].c.doc._id);
        stats.pairedBySimilarity++;
      }
    }
  }

  function canonical(record, labels, side) {
    const unpaired = new Set();
    for (const field of FIELDS) {
      for (const id of Object.keys(record.world[field] ?? {}))
        if (isGenerated(id) && !labels.has(id)) unpaired.add(id);
    }
    stats.unpairedDocumentTicks += unpaired.size;
    return mapStrings(record, (s) =>
      labels.has(s) ? labels.get(s) : unpaired.has(s) ? `${side}:${s}` : s,
    );
  }

  function parseIsoDates(world) {
    for (const field of DATE_COLLECTIONS) {
      for (const doc of Object.values(world[field] ?? {})) {
        if (typeof doc.date === 'string' && ISO_DATE.test(doc.date))
          doc.date = Date.parse(doc.date);
      }
    }
  }

  function project(record) {
    const world = record.world;
    const out = { gameTime: world.gameTime, rngState: world.rngState };
    for (const field of FIELDS) out[field] = world[field] ?? {};
    out.activeRooms = world.activeRooms ?? [];
    out.roomEventLogs = world.roomEventLogs ?? {};
    out.mapViews = world.mapViews ?? {};
    out.history = record.history ?? {};
    const roomStats = {};
    for (const [room, users] of Object.entries(record.roomStats ?? {})) {
      if (Object.keys(users).length) roomStats[room] = users;
    }
    out.roomStats = roomStats;
    out.processedRooms = [...record.processedRooms].sort();
    out.roomErrors = record.roomErrors.map((error) => error.room).sort();
    out.loopErrors = record.loopErrors.length;
    return json(out);
  }

  function diff(oracle, local, path, out) {
    if (stable(oracle) === stable(local)) return;
    const objects =
      oracle !== null &&
      local !== null &&
      typeof oracle === 'object' &&
      typeof local === 'object' &&
      Array.isArray(oracle) === Array.isArray(local);
    if (objects) {
      const keys = new Set([...Object.keys(oracle), ...Object.keys(local)]);
      for (const key of keys) diff(oracle[key], local[key], pathOf(path, key), out);
      return;
    }
    out.push({ path, oracle, local });
  }

  return {
    stats,
    /** Local id of an oracle document id (fixture ids are shared; generated ids once paired). */
    localIdOf(oracleId) {
      return isGenerated(oracleId) ? localByLabel.get(oracleId) : oracleId;
    },
    compareTick(oracleRecord, localRecord) {
      const oracleJson = json(oracleRecord);
      const localJson = json(localRecord);
      // Pairing treats an ISO date and the epoch number of the same instant as equal content; the
      // differences themselves are computed on the raw values.
      const oracleForPairing = json(oracleJson.world);
      parseIsoDates(oracleForPairing);
      pairNewDocuments(oracleForPairing, localJson.world);
      const differences = [];
      diff(
        project(canonical(oracleJson, oracleLabels, 'oracle')),
        project(canonical(localJson, localLabels, 'local')),
        '',
        differences,
      );
      return differences;
    },
    /** Oracle-labelled processing order of the local tick (ids translated through the pairing). */
    labelOrder(order) {
      const out = {};
      for (const [room, ids] of Object.entries(order))
        out[room] = ids.map((id) => localLabels.get(id) ?? id);
      return out;
    },
  };
}
