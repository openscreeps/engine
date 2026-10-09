/*
 * Document builders for conformance fixtures, in the shapes the upstream backend and processor
 * write (`processor/intents/creeps/build.js` structure creation, `spawns/tick.js` creep creation,
 * backend room generation). Both sides receive the same JSON input.
 */

export function terrain({ walls = [], swamps = [] } = {}) {
  const cells = Array(2500).fill('0');
  for (const [x, y] of walls) cells[y * 50 + x] = '1';
  for (const [x, y] of swamps) cells[y * 50 + x] = '2';
  return cells.join('');
}

export function user(id, username, extra = {}) {
  return {
    _id: id,
    username,
    usernameLower: username.toLowerCase(),
    cpu: 100,
    cpuAvailable: 10000,
    gcl: 0,
    power: 0,
    money: 0,
    rooms: [],
    active: 10000,
    ...extra,
  };
}

/** NPC accounts as created by the backend (`Invader` 2, `Source Keeper` 3); never run by the runner. */
export function npcUsers() {
  return {
    2: {
      _id: '2',
      username: 'Invader',
      usernameLower: 'invader',
      cpu: 0,
      cpuAvailable: 0,
      gcl: 0,
      active: 0,
    },
    3: {
      _id: '3',
      username: 'Source Keeper',
      usernameLower: 'source keeper',
      cpu: 0,
      cpuAvailable: 0,
      gcl: 0,
      active: 0,
    },
  };
}

export function room(id, extra = {}) {
  return { _id: id, status: 'normal', ...extra };
}

export function creep(
  id,
  { room, x, y, user, name = id, body, store = {}, ageTime = 10000, ...extra },
) {
  const parts = body.map((part) =>
    typeof part === 'string' ? { type: part, hits: 100 } : { hits: 100, ...part },
  );
  const hits = parts.reduce((sum, part) => sum + part.hits, 0);
  const carry = parts.filter((part) => part.type === 'carry').length;
  return {
    _id: id,
    type: 'creep',
    room,
    x,
    y,
    name,
    user,
    body: parts,
    hits,
    hitsMax: parts.length * 100,
    store,
    storeCapacity: carry * 50,
    fatigue: 0,
    ageTime,
    spawning: false,
    notifyWhenAttacked: true,
    actionLog: {},
    ...extra,
  };
}

export function controller(id, { room, x, y, user, level = 1, progress = 0, ...extra }) {
  return {
    _id: id,
    type: 'controller',
    room,
    x,
    y,
    user,
    level,
    progress,
    downgradeTime: null,
    safeMode: null,
    safeModeAvailable: 1,
    safeModeCooldown: null,
    isPowerEnabled: false,
    ...extra,
  };
}

export function source(id, { room, x, y, energy = 3000, ...extra }) {
  return {
    _id: id,
    type: 'source',
    room,
    x,
    y,
    energy,
    energyCapacity: 3000,
    ticksToRegeneration: 300,
    nextRegenerationTime: null,
    invaderHarvested: 0,
    ...extra,
  };
}

export function mineral(
  id,
  { room, x, y, mineralType = 'H', mineralAmount = 70000, density = 3, ...extra },
) {
  return {
    _id: id,
    type: 'mineral',
    room,
    x,
    y,
    mineralType,
    mineralAmount,
    density,
    nextRegenerationTime: null,
    ...extra,
  };
}

const STRUCTURES = {
  spawn: (o) => ({
    name: o.name,
    store: { energy: 300 },
    storeCapacityResource: { energy: 300 },
    hits: 5000,
    hitsMax: 5000,
    spawning: null,
  }),
  extension: () => ({
    store: { energy: 0 },
    storeCapacityResource: { energy: 50 },
    hits: 1000,
    hitsMax: 1000,
  }),
  link: () => ({
    store: { energy: 0 },
    storeCapacityResource: { energy: 800 },
    cooldown: 0,
    hits: 1000,
    hitsMax: 1000,
  }),
  storage: () => ({ store: { energy: 0 }, storeCapacity: 1000000, hits: 10000, hitsMax: 10000 }),
  rampart: () => ({ hits: 1000, hitsMax: 300000, nextDecayTime: 1000000, isPublic: false }),
  road: () => ({ hits: 5000, hitsMax: 5000, nextDecayTime: 1000000 }),
  constructedWall: () => ({ hits: 1000, hitsMax: 300000000 }),
  tower: () => ({
    store: { energy: 0 },
    storeCapacityResource: { energy: 1000 },
    hits: 3000,
    hitsMax: 3000,
    actionLog: {},
  }),
  observer: () => ({ hits: 500, hitsMax: 500 }),
  extractor: () => ({ hits: 500, hitsMax: 500, cooldown: 0 }),
  lab: () => ({
    hits: 500,
    hitsMax: 500,
    mineralAmount: 0,
    cooldown: 0,
    store: { energy: 0 },
    storeCapacity: 5000,
    storeCapacityResource: { energy: 2000 },
    actionLog: {},
  }),
  powerSpawn: () => ({
    store: { energy: 0 },
    storeCapacityResource: { energy: 5000, power: 100 },
    hits: 5000,
    hitsMax: 5000,
  }),
  terminal: () => ({ store: { energy: 0 }, storeCapacity: 300000, hits: 3000, hitsMax: 3000 }),
  container: () => ({
    store: { energy: 0 },
    storeCapacity: 2000,
    hits: 250000,
    hitsMax: 250000,
    nextDecayTime: 1000000,
  }),
  nuker: () => ({
    store: { energy: 0 },
    storeCapacityResource: { energy: 300000, G: 5000 },
    hits: 1000,
    hitsMax: 1000,
    cooldownTime: 0,
  }),
  factory: () => ({
    store: { energy: 0 },
    storeCapacity: 50000,
    hits: 1000,
    hitsMax: 1000,
    cooldown: 0,
  }),
  keeperLair: () => ({ nextSpawnTime: null }),
};

/** Structure with build.js defaults; `extra` overrides (e.g. `store`, `hits`). */
export function structure(id, type, { room, x, y, user, ...extra }) {
  const defaults = STRUCTURES[type]({ name: extra.name });
  const doc = { _id: id, type, room, x, y, notifyWhenAttacked: true, ...defaults, ...extra };
  if (user !== undefined) doc.user = user;
  return doc;
}

export function constructionSite(
  id,
  { room, x, y, user, structureType, progress = 0, progressTotal, ...extra },
) {
  return {
    _id: id,
    type: 'constructionSite',
    room,
    x,
    y,
    user,
    structureType,
    progress,
    progressTotal,
    ...extra,
  };
}

/** Index documents by `_id`, preserving the given order (collection insertion order). */
export function byId(...docs) {
  const out = {};
  for (const doc of docs) out[doc._id] = doc;
  return out;
}
