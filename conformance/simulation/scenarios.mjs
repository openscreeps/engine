/*
 * Multi-tick processor scenarios. Each scenario is a world fixture plus the raw player intents of
 * every tick (the runtime's `intents` list shape: object id -> {intent: args}, `room`, `global`,
 * `notify`). Both sides evolve independently from the fixture; every tick's resulting state is compared.
 */
import { createWorldState } from '../../src/simulation/index.ts';
import {
  byId,
  constructionSite,
  controller,
  creep,
  mineral,
  npcUsers,
  room,
  source,
  structure,
  terrain,
  user,
} from './fixtures.mjs';

const CLOCK = { start: 1_700_000_000_000, step: 3_000 };
const T0 = 1000;

function world(init) {
  return createWorldState({
    gameTime: T0,
    shardName: '',
    rngState: 0x2545f491,
    idCounter: 0,
    ...init,
  });
}

const DIR = {
  TOP: 1,
  TOP_RIGHT: 2,
  RIGHT: 3,
  BOTTOM_RIGHT: 4,
  BOTTOM: 5,
  BOTTOM_LEFT: 6,
  LEFT: 7,
  TOP_LEFT: 8,
};

function repeat(count, intents) {
  return Array.from({ length: count }, (_, index) => ({
    intents: typeof intents === 'function' ? intents(index) : intents,
  }));
}

/*
 * `checks` guard against vacuous matches: each must hold on the oracle's (and local) tick records,
 * proving the scenario actually exercised the transition it claims to cover.
 */
const final = (ticks) => ticks[ticks.length - 1].world;
const objectsOf = (world, predicate) => Object.values(world.roomObjects).filter(predicate);
const ever = (ticks, predicate) => ticks.some((tick) => predicate(tick.world, tick));

const movement = {
  name: 'movement-fatigue',
  description:
    'fatigue on plain/swamp/road, carried weight, swaps, contested tiles, pull chains, room exit transfer',
  coverage: ['movement', 'fatigue', 'pull', 'room-transition', 'global-interroom'],
  clock: CLOCK,
  world: world({
    rooms: { W1N1: room('W1N1'), W0N1: room('W0N1') },
    terrain: {
      W1N1: terrain({
        swamps: [
          [12, 20],
          [13, 20],
          [14, 20],
        ],
      }),
      W0N1: terrain(),
    },
    activeRooms: ['W1N1'],
    users: byId(user('u1', 'alice', { rooms: ['W1N1'] })),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W1N1',
        x: 2,
        y: 2,
        user: 'u1',
        level: 3,
        downgradeTime: T0 + 20000,
      }),
      creep('heavy', {
        room: 'W1N1',
        x: 10,
        y: 20,
        user: 'u1',
        body: ['work', 'work', 'carry', 'move'],
        store: { energy: 50 },
      }),
      creep('roader', { room: 'W1N1', x: 19, y: 25, user: 'u1', body: ['work', 'carry', 'move'] }),
      structure('road1', 'road', { room: 'W1N1', x: 20, y: 25 }),
      structure('road2', 'road', { room: 'W1N1', x: 21, y: 25 }),
      structure('road3', 'road', { room: 'W1N1', x: 22, y: 25 }),
      creep('swapA', { room: 'W1N1', x: 30, y: 30, user: 'u1', body: ['move'] }),
      creep('swapB', { room: 'W1N1', x: 31, y: 30, user: 'u1', body: ['move'] }),
      creep('contestA', { room: 'W1N1', x: 30, y: 35, user: 'u1', body: ['move', 'move'] }),
      creep('contestB', { room: 'W1N1', x: 32, y: 35, user: 'u1', body: ['move'] }),
      creep('blocker', { room: 'W1N1', x: 35, y: 35, user: 'u1', body: ['move'] }),
      creep('intoBlocker', { room: 'W1N1', x: 34, y: 35, user: 'u1', body: ['move'] }),
      creep('puller', { room: 'W1N1', x: 40, y: 10, user: 'u1', body: ['move', 'move'] }),
      creep('pulled', { room: 'W1N1', x: 40, y: 11, user: 'u1', body: ['work', 'work'] }),
      creep('exiter', { room: 'W1N1', x: 47, y: 40, user: 'u1', body: ['move'] }),
    ),
  }),
  ticks: [
    {
      intents: {
        u1: {
          heavy: { move: { direction: DIR.RIGHT } },
          roader: { move: { direction: DIR.RIGHT } },
          swapA: { move: { direction: DIR.RIGHT } },
          swapB: { move: { direction: DIR.LEFT } },
          contestA: { move: { direction: DIR.RIGHT } },
          contestB: { move: { direction: DIR.LEFT } },
          intoBlocker: { move: { direction: DIR.RIGHT } },
          puller: { move: { direction: DIR.TOP }, pull: { id: 'pulled' } },
          pulled: { move: { id: 'puller' } },
          exiter: { move: { direction: DIR.RIGHT } },
        },
      },
    },
    ...repeat(6, (index) => ({
      u1: {
        heavy: { move: { direction: DIR.RIGHT } },
        roader: { move: { direction: DIR.RIGHT } },
        contestB: { move: { direction: DIR.TOP } },
        blocker: index === 1 ? { move: { direction: DIR.BOTTOM } } : {},
        intoBlocker: { move: { direction: DIR.RIGHT } },
        puller: { move: { direction: DIR.TOP }, pull: { id: 'pulled' } },
        pulled: { move: { id: 'puller' } },
        exiter: { move: { direction: DIR.RIGHT } },
      },
    })),
  ],
  checks: {
    'heavy creep accumulated fatigue and still advanced': (ticks) =>
      ever(ticks, (w) => w.roomObjects.heavy.fatigue > 0) && final(ticks).roomObjects.heavy.x > 11,
    'swap completed': (ticks) =>
      ticks[0].world.roomObjects.swapA.x === 31 && ticks[0].world.roomObjects.swapB.x === 30,
    'one contender took the tile': (ticks) =>
      objectsOf(ticks[0].world, (o) => o.x === 31 && o.y === 35 && o.type === 'creep').length === 1,
    'pulled creep without MOVE moved': (ticks) => final(ticks).roomObjects.pulled.y < 10,
    'exiter transferred to W0N1 and kept moving': (ticks) =>
      final(ticks).roomObjects.exiter.room === 'W0N1' && final(ticks).roomObjects.exiter.x > 0,
  },
};

const economy = {
  name: 'economy-harvest-build-upgrade',
  restartLocalBefore: [2, 5],
  description:
    'harvest with source regeneration, transfer/withdraw, drop/pickup with decay, build to completion, new extension capacity, ' +
    'construction site placement, repair, controller upgrade and level-up with GCL, spawning to a new creep, notify',
  coverage: [
    'harvest',
    'source-regen',
    'transfer',
    'withdraw',
    'drop',
    'pickup',
    'energy-decay',
    'build',
    'structure-creation',
    'createConstructionSite',
    'repair',
    'upgradeController',
    'controller-level',
    'gcl',
    'spawning',
    'notify',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W1N1: room('W1N1') },
    terrain: { W1N1: terrain() },
    activeRooms: ['W1N1'],
    users: byId(user('u1', 'alice', { rooms: ['W1N1'], gcl: 1000 })),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W1N1',
        x: 25,
        y: 25,
        user: 'u1',
        level: 1,
        progress: 197,
        downgradeTime: T0 + 20000,
      }),
      structure('spawn1', 'spawn', { room: 'W1N1', x: 20, y: 20, user: 'u1', name: 'Spawn1' }),
      structure('ext1', 'extension', { room: 'W1N1', x: 21, y: 21, user: 'u1' }),
      structure('cont1', 'container', { room: 'W1N1', x: 12, y: 12, store: { energy: 500 } }),
      structure('road1', 'road', { room: 'W1N1', x: 14, y: 14, hits: 4000 }),
      source('src1', { room: 'W1N1', x: 10, y: 10, energy: 6, nextRegenerationTime: T0 + 4 }),
      creep('harvester', {
        room: 'W1N1',
        x: 11,
        y: 11,
        user: 'u1',
        body: ['work', 'work', 'carry', 'move'],
        store: { energy: 0 },
      }),
      creep('carrier', {
        room: 'W1N1',
        x: 11,
        y: 12,
        user: 'u1',
        body: ['carry', 'carry', 'move'],
        store: { energy: 100 },
      }),
      creep('builder', {
        room: 'W1N1',
        x: 30,
        y: 30,
        user: 'u1',
        body: ['work', 'work', 'carry', 'move'],
        store: { energy: 50 },
      }),
      constructionSite('site1', {
        room: 'W1N1',
        x: 31,
        y: 30,
        user: 'u1',
        structureType: 'extension',
        progress: 2995,
        progressTotal: 3000,
      }),
      creep('upgrader', {
        room: 'W1N1',
        x: 24,
        y: 24,
        user: 'u1',
        body: ['work', 'carry', 'move'],
        store: { energy: 50 },
      }),
      creep('dropper', {
        room: 'W1N1',
        x: 15,
        y: 15,
        user: 'u1',
        body: ['carry', 'move'],
        store: { energy: 40 },
      }),
      creep('picker', {
        room: 'W1N1',
        x: 16,
        y: 16,
        user: 'u1',
        body: ['carry', 'move'],
        store: {},
      }),
      creep('repairer', {
        room: 'W1N1',
        x: 14,
        y: 15,
        user: 'u1',
        body: ['work', 'carry', 'move'],
        store: { energy: 50 },
      }),
    ),
  }),
  ticks: [
    {
      intents: {
        u1: {
          spawn1: { createCreep: { name: 'Fresh', body: ['work', 'carry', 'move'] } },
          harvester: { harvest: { id: 'src1' } },
          carrier: { transfer: { id: 'cont1', resourceType: 'energy', amount: 30 } },
          builder: { build: { id: 'site1', x: 31, y: 30 } },
          upgrader: { upgradeController: { id: 'ctrl' } },
          dropper: { drop: { resourceType: 'energy', amount: 25 } },
          repairer: { repair: { id: 'road1', x: 14, y: 14 } },
          notify: [{ message: 'economy started', groupInterval: 0 }],
        },
      },
    },
    {
      intents: {
        u1: {
          harvester: { harvest: { id: 'src1' } },
          carrier: { withdraw: { id: 'cont1', resourceType: 'energy', amount: 50 } },
          builder: { transfer: { id: '@at:extension:31:30', resourceType: 'energy', amount: 20 } },
          upgrader: { upgradeController: { id: 'ctrl' } },
          picker: { pickup: { id: '@at:energy:15:15' } },
          repairer: { repair: { id: 'road1', x: 14, y: 14 } },
          room: {
            createConstructionSite: [{ roomName: 'W1N1', x: 32, y: 31, structureType: 'road' }],
          },
        },
      },
    },
    {
      intents: {
        u1: {
          harvester: { harvest: { id: 'src1' } },
          builder: { build: { id: '@at:constructionSite:32:31', x: 32, y: 31 } },
          upgrader: { upgradeController: { id: 'ctrl' } },
          carrier: { move: { direction: DIR.BOTTOM } },
        },
      },
    },
    ...repeat(8, (index) => ({
      u1: {
        harvester:
          index < 4
            ? { harvest: { id: 'src1' } }
            : { transfer: { id: 'cont1', resourceType: 'energy' } },
        builder:
          index === 1
            ? { transfer: { id: '@at:extension:31:30', resourceType: 'energy', amount: 10 } }
            : { build: { id: '@at:constructionSite:32:31', x: 32, y: 31 } },
        '@name:Fresh': { move: { direction: DIR.TOP } },
      },
    })),
  ],
  checks: {
    'spawned creep exists and moved': (ticks) => {
      const positions = ticks.flatMap((t) =>
        objectsOf(t.world, (o) => o.name === 'Fresh' && !o.spawning).map((o) => `${o.x},${o.y}`),
      );
      return positions.length > 1 && new Set(positions).size > 1;
    },
    'site completed into an extension that received energy': (ticks) =>
      objectsOf(final(ticks), (o) => o.type === 'extension' && o.x === 31 && o.store.energy > 0)
        .length === 1,
    'controller reached level 2 and GCL grew': (ticks) =>
      final(ticks).roomObjects.ctrl.level === 2 && final(ticks).users.u1.gcl > 1000,
    'source regenerated': (ticks) => ever(ticks, (w) => w.roomObjects.src1.energy === 3000),
    'dropped energy was picked up': (ticks) => final(ticks).roomObjects.picker.store.energy > 0,
    'road repaired': (ticks) => final(ticks).roomObjects.road1.hits > 4000,
    'placed road site progressed': (ticks) =>
      objectsOf(final(ticks), (o) => o.type === 'constructionSite' && o.progress > 0).length === 1,
    'notify and level-up notification persisted': (ticks) =>
      Object.keys(final(ticks).notifications).length === 2,
  },
};

const combat = {
  name: 'combat-heal-death',
  restartLocalBefore: [3],
  description:
    'melee/ranged/mass attacks, rampart cover, self-heal and ranged heal, tower attack, dismantle, structure destruction to ruins, ' +
    'death by damage, age and suicide into tombstones, attack notifications, say',
  coverage: [
    'attack',
    'rangedAttack',
    'rangedMassAttack',
    'heal',
    'rangedHeal',
    'tower-attack',
    'rampart-cover',
    'dismantle',
    'creep-death',
    'old-age',
    'suicide',
    'tombstone',
    'ruin',
    'attack-notification',
    'say',
    'body-damage',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W2N2: room('W2N2') },
    terrain: { W2N2: terrain() },
    activeRooms: ['W2N2'],
    users: byId(user('u1', 'attacker'), user('u2', 'defender', { rooms: ['W2N2'] })),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W2N2',
        x: 45,
        y: 45,
        user: 'u2',
        level: 3,
        downgradeTime: T0 + 20000,
      }),
      structure('tower', 'tower', {
        room: 'W2N2',
        x: 25,
        y: 25,
        user: 'u2',
        store: { energy: 1000 },
      }),
      structure('rampart', 'rampart', { room: 'W2N2', x: 30, y: 30, user: 'u2', hits: 2000 }),
      creep('covered', { room: 'W2N2', x: 30, y: 30, user: 'u2', body: ['tough', 'move'] }),
      structure('ext', 'extension', {
        room: 'W2N2',
        x: 20,
        y: 30,
        user: 'u2',
        hits: 25,
        store: { energy: 30 },
      }),
      structure('box', 'container', {
        room: 'W2N2',
        x: 23,
        y: 31,
        hits: 300,
        store: { energy: 120 },
      }),
      creep('defender', {
        room: 'W2N2',
        x: 21,
        y: 21,
        user: 'u2',
        body: ['tough', 'tough', 'heal', 'move'],
        store: {},
      }),
      creep('melee', {
        room: 'W2N2',
        x: 22,
        y: 22,
        user: 'u1',
        body: [...Array(10).fill('tough'), 'attack', 'attack', 'attack', 'move', 'move', 'move'],
      }),
      creep('ranged', {
        room: 'W2N2',
        x: 29,
        y: 27,
        user: 'u1',
        body: ['ranged_attack', 'ranged_attack', 'move'],
      }),
      creep('medic', { room: 'W2N2', x: 24, y: 23, user: 'u1', body: ['heal', 'heal', 'move'] }),
      creep('massive', { room: 'W2N2', x: 19, y: 31, user: 'u1', body: ['ranged_attack', 'move'] }),
      creep('wrecker', { room: 'W2N2', x: 22, y: 31, user: 'u1', body: ['work', 'work', 'move'] }),
      creep('elder', {
        room: 'W2N2',
        x: 40,
        y: 10,
        user: 'u1',
        body: ['carry', 'move'],
        store: { energy: 30 },
        ageTime: T0 + 2,
      }),
      creep('quitter', { room: 'W2N2', x: 41, y: 12, user: 'u1', body: ['move'] }),
    ),
  }),
  ticks: repeat(8, (index) => ({
    u1: {
      melee: {
        attack: { id: 'defender', x: 21, y: 21 },
        ...(index === 0 ? { say: { message: 'charge', isPublic: true } } : {}),
      },
      ranged: { rangedAttack: { id: 'covered' } },
      medic: { rangedHeal: { id: 'melee' } },
      massive: { rangedMassAttack: {} },
      wrecker: { dismantle: { id: 'box' } },
      ...(index === 1 ? { quitter: { suicide: {} } } : {}),
    },
    u2: {
      tower: index === 0 ? { attack: { id: 'melee' } } : { repair: { id: 'rampart' } },
      defender: { heal: { id: 'defender', x: 21, y: 21 } },
    },
  })),
  checks: {
    'defender died into a tombstone': (ticks) =>
      !final(ticks).roomObjects.defender &&
      objectsOf(final(ticks), (o) => o.type === 'tombstone' && o.creepId === 'defender').length ===
        1,
    'rampart absorbed ranged damage, covered creep untouched': (ticks) =>
      ever(ticks, (w) => w.roomObjects.rampart.hits < 2000) &&
      ticks.every((t) => t.world.roomObjects.covered.hits === 200),
    'melee took tower damage and lost a body part': (ticks) =>
      ever(ticks, (w) => w.roomObjects.melee?.body.some((p) => p.hits === 0)),
    'extension and container destroyed into ruins': (ticks) =>
      !final(ticks).roomObjects.ext &&
      !final(ticks).roomObjects.box &&
      objectsOf(final(ticks), (o) => o.type === 'ruin').length === 2,
    'elder and quitter left tombstones': (ticks) =>
      ['elder', 'quitter'].every((id) =>
        ever(
          ticks,
          (w) => objectsOf(w, (o) => o.type === 'tombstone' && o.creepId === id).length === 1,
        ),
      ),
    'attack notifications sent to the defender': (ticks) =>
      Object.values(final(ticks).notifications).some(
        (n) => n.user === 'u2' && /under attack/.test(n.message),
      ),
  },
};

function lab(id, x, y, mineralType, amount, energy = 0, labRoom = 'W3N3') {
  const doc = structure(id, 'lab', { room: labRoom, x, y, user: 'u1', store: { energy } });
  if (mineralType) {
    doc.store[mineralType] = amount;
    doc.storeCapacityResource = { energy: 2000, [mineralType]: 3000 };
    doc.storeCapacity = null;
  }
  return doc;
}

const structures = {
  name: 'structures-production-cooldowns',
  description:
    'lab reaction cooldown and boosting, link transfer cooldown and loss, factory production cooldown, power processing until empty, ' +
    'extractor cooldown, spawn renew/recycle, tower repair, observer, nuke launch, rampart setPublic, destroyStructure, notifyWhenAttacked',
  coverage: [
    'lab-reaction',
    'lab-cooldown',
    'boostCreep',
    'link-transfer',
    'link-cooldown',
    'factory-produce',
    'factory-cooldown',
    'processPower',
    'mineral-harvest',
    'extractor-cooldown',
    'renewCreep',
    'recycleCreep',
    'tower-repair',
    'observeRoom',
    'launchNuke',
    'setPublic',
    'destroyStructure',
    'notifyWhenAttacked',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W3N3: room('W3N3'), W3N4: room('W3N4') },
    terrain: { W3N3: terrain(), W3N4: terrain() },
    activeRooms: ['W3N3'],
    users: byId(user('u1', 'industrialist', { rooms: ['W3N3'], power: 0 })),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W3N3',
        x: 2,
        y: 2,
        user: 'u1',
        level: 8,
        downgradeTime: T0 + 200000,
      }),
      lab('lab1', 10, 10, 'O', 100),
      lab('lab2', 11, 10, 'H', 100),
      lab('lab3', 12, 11),
      lab('lab4', 14, 10, 'UH', 60, 100),
      creep('boostee', {
        room: 'W3N3',
        x: 15,
        y: 11,
        user: 'u1',
        body: ['attack', 'attack', 'move'],
      }),
      structure('link1', 'link', {
        room: 'W3N3',
        x: 20,
        y: 20,
        user: 'u1',
        store: { energy: 800 },
      }),
      structure('link2', 'link', { room: 'W3N3', x: 25, y: 20, user: 'u1' }),
      structure('factory', 'factory', {
        room: 'W3N3',
        x: 30,
        y: 30,
        user: 'u1',
        store: { energy: 1200 },
      }),
      structure('pspawn', 'powerSpawn', {
        room: 'W3N3',
        x: 35,
        y: 35,
        user: 'u1',
        store: { energy: 200, power: 3 },
      }),
      mineral('mineral', { room: 'W3N3', x: 40, y: 40, mineralType: 'H', mineralAmount: 1000 }),
      structure('extractor', 'extractor', { room: 'W3N3', x: 40, y: 40, user: 'u1' }),
      creep('miner', {
        room: 'W3N3',
        x: 41,
        y: 41,
        user: 'u1',
        body: ['work', 'work', 'work', 'carry', 'carry', 'move'],
      }),
      structure('spawn1', 'spawn', { room: 'W3N3', x: 20, y: 25, user: 'u1', name: 'Spawn1' }),
      creep('aged', {
        room: 'W3N3',
        x: 21,
        y: 26,
        user: 'u1',
        body: ['work', 'move'],
        ageTime: T0 + 100,
      }),
      creep('scrap', {
        room: 'W3N3',
        x: 19,
        y: 26,
        user: 'u1',
        body: ['work', 'carry', 'move'],
        store: { energy: 20 },
      }),
      structure('tower', 'tower', {
        room: 'W3N3',
        x: 25,
        y: 25,
        user: 'u1',
        store: { energy: 500 },
      }),
      structure('wall', 'constructedWall', { room: 'W3N3', x: 26, y: 26, hits: 1000 }),
      structure('observer', 'observer', { room: 'W3N3', x: 5, y: 5, user: 'u1' }),
      structure('nuker', 'nuker', {
        room: 'W3N3',
        x: 45,
        y: 45,
        user: 'u1',
        store: { energy: 300000, G: 5000 },
      }),
      structure('gate', 'rampart', { room: 'W3N3', x: 8, y: 8, user: 'u1' }),
      structure('oldRoad', 'road', { room: 'W3N3', x: 9, y: 9 }),
    ),
  }),
  ticks: repeat(6, (index) => ({
    u1: {
      lab3: { runReaction: { lab1: 'lab1', lab2: 'lab2' } },
      ...(index === 0 ? { lab4: { boostCreep: { id: 'boostee' } } } : {}),
      link1: { transfer: { id: 'link2', amount: 400, resourceType: 'energy' } },
      factory: { produce: { resourceType: 'battery' } },
      pspawn: { processPower: {} },
      miner: { harvest: { id: 'mineral' } },
      spawn1:
        index === 0
          ? { renewCreep: { id: 'aged' } }
          : index === 1
            ? { recycleCreep: { id: 'scrap' } }
            : {},
      tower: { repair: { id: 'wall' } },
      observer: { observeRoom: { roomName: 'W3N4' } },
      ...(index === 0 ? { nuker: { launchNuke: { roomName: 'W3N4', x: 25, y: 25 } } } : {}),
      ...(index === 2 ? { nuker: { launchNuke: { roomName: 'W3N4', x: 20, y: 20 } } } : {}),
      ...(index === 0
        ? {
            gate: { setPublic: { isPublic: true } },
            wall: { notifyWhenAttacked: { enabled: false } },
          }
        : {}),
      ...(index === 1 ? { room: { destroyStructure: [{ roomName: 'W3N3', id: 'oldRoad' }] } } : {}),
    },
  })),
  checks: {
    'one reaction then cooldown': (ticks) =>
      final(ticks).roomObjects.lab3.store.OH === 5 &&
      final(ticks).roomObjects.lab3.cooldownTime > T0,
    'creep boosted': (ticks) => final(ticks).roomObjects.boostee.body.some((p) => p.boost === 'UH'),
    'link transfer blocked during cooldown, resumed after': (ticks) =>
      ticks[1].world.roomObjects.link1.store.energy === 400 &&
      ticks[1].world.roomObjects.link1.cooldown > 0 &&
      final(ticks).roomObjects.link1.store.energy === 0 &&
      final(ticks).roomObjects.link2.store.energy > 400,
    'factory produced battery once': (ticks) =>
      final(ticks).roomObjects.factory.store.battery === 50,
    'power processed until empty': (ticks) =>
      final(ticks).roomObjects.pspawn.store.power === 0 && final(ticks).users.u1.power === 3,
    'mineral harvested under extractor cooldown': (ticks) =>
      final(ticks).roomObjects.mineral.mineralAmount < 1000 &&
      ever(ticks, (w) => w.roomObjects.extractor.cooldown > 0),
    'renewed and recycled': (ticks) =>
      final(ticks).roomObjects.aged.ageTime > T0 + 100 && !final(ticks).roomObjects.scrap,
    'wall repaired by tower': (ticks) => final(ticks).roomObjects.wall.hits > 1000,
    'nuke launched once into W3N4': (ticks) =>
      objectsOf(final(ticks), (o) => o.type === 'nuke' && o.room === 'W3N4').length === 1,
    'rampart public, road destroyed': (ticks) =>
      final(ticks).roomObjects.gate.isPublic === true && !final(ticks).roomObjects.oldRoad,
  },
};

const MARKET_ROOMS = {
  rooms: { W1N1: room('W1N1'), W5N5: room('W5N5') },
  terrain: { W1N1: terrain(), W5N5: terrain() },
  activeRooms: ['W1N1', 'W5N5'],
};

const market = {
  name: 'market-terminal-orders',
  restartLocalBefore: [1, 8],
  description:
    'two same-tick deals (shuffled order), order creation fees, price change, extension, cancel, deal against a created order, ' +
    'terminal send with cooldown and transfer cost, money/resource logs, transactions',
  coverage: [
    'market-deal',
    'market-createOrder',
    'market-changeOrderPrice',
    'market-extendOrder',
    'market-cancelOrder',
    'market-fees',
    'terminal-send',
    'terminal-cooldown',
    'transactions',
    'money-log',
    'deal-shuffle',
  ],
  clock: CLOCK,
  world: world({
    ...MARKET_ROOMS,
    users: byId(
      user('u1', 'buyer', { rooms: ['W1N1'], money: 1_000_000_000 }),
      user('u2', 'seller', { rooms: ['W5N5'], money: 1_000_000_000 }),
    ),
    roomObjects: byId(
      controller('ctrlA', {
        room: 'W1N1',
        x: 2,
        y: 2,
        user: 'u1',
        level: 6,
        downgradeTime: T0 + 200000,
      }),
      controller('ctrlB', {
        room: 'W5N5',
        x: 2,
        y: 2,
        user: 'u2',
        level: 6,
        downgradeTime: T0 + 200000,
      }),
      structure('termA', 'terminal', {
        room: 'W1N1',
        x: 10,
        y: 10,
        user: 'u1',
        store: { energy: 20000 },
      }),
      structure('termB', 'terminal', {
        room: 'W5N5',
        x: 10,
        y: 10,
        user: 'u2',
        store: { energy: 20000, H: 1000 },
      }),
    ),
    marketOrders: byId(
      {
        _id: 'o1',
        created: 1,
        createdTimestamp: CLOCK.start - 1000,
        user: 'u2',
        active: true,
        type: 'sell',
        amount: 500,
        remainingAmount: 500,
        totalAmount: 500,
        resourceType: 'H',
        price: 1000,
        roomName: 'W5N5',
      },
      {
        _id: 'o2',
        created: 1,
        createdTimestamp: CLOCK.start - 1000,
        user: 'u2',
        active: true,
        type: 'buy',
        amount: 1000,
        remainingAmount: 1000,
        totalAmount: 1000,
        resourceType: 'energy',
        price: 500,
        roomName: 'W5N5',
      },
    ),
  }),
  ticks: [
    {
      intents: {
        // Same terminal twice in one tick: the shuffled order decides which deal wins the terminal cooldown.
        u1: {
          global: {
            deal: [
              { orderId: 'o1', amount: 100, targetRoomName: 'W1N1' },
              { orderId: 'o2', amount: 200, targetRoomName: 'W1N1' },
            ],
          },
        },
        u2: {
          global: {
            createOrder: [
              {
                type: 'sell',
                resourceType: 'energy',
                price: 2,
                totalAmount: 1000,
                roomName: 'W5N5',
              },
            ],
          },
        },
      },
    },
    {
      intents: {
        u1: {
          global: {
            deal: [{ orderId: '@order:u2:sell:energy', amount: 50, targetRoomName: 'W1N1' }],
          },
        },
        u2: {
          global: {
            changeOrderPrice: [{ orderId: 'o1', newPrice: 1.5 }],
            extendOrder: [{ orderId: 'o2', addAmount: 100 }],
          },
        },
      },
    },
    { intents: { u2: { global: { cancelOrder: [{ orderId: 'o2' }] } } } },
    {
      intents: {
        u2: {
          termB: {
            send: {
              targetRoomName: 'W1N1',
              resourceType: 'energy',
              amount: 1000,
              description: 'gift <b>',
            },
          },
        },
      },
    },
    {
      intents: {
        u2: { termB: { send: { targetRoomName: 'W1N1', resourceType: 'energy', amount: 10 } } },
      },
    },
    ...repeat(6, {}),
    {
      intents: {
        u1: {
          global: {
            deal: [{ orderId: '@order:u2:sell:energy', amount: 50, targetRoomName: 'W1N1' }],
          },
        },
      },
    },
    {
      intents: {
        u1: { global: { deal: [{ orderId: 'o1', amount: 1000, targetRoomName: 'W1N1' }] } },
      },
    },
  ],
  checks: {
    'one of two same-terminal deals executed': (ticks) =>
      Object.values(ticks[0].world.transactions).length === 1,
    'deal refused during terminal cooldown, created order dealt after it': (ticks) =>
      Object.values(ticks[1].world.marketOrders).some(
        (o) => o.resourceType === 'energy' && o.type === 'sell' && o.remainingAmount === 1000,
      ) &&
      Object.values(final(ticks).marketOrders).some(
        (o) => o.resourceType === 'energy' && o.type === 'sell' && o.remainingAmount === 950,
      ),
    'price changed, order extended then cancelled': (ticks) =>
      final(ticks).marketOrders.o1.price === 1500 &&
      ticks[1].world.marketOrders.o2.totalAmount === 1100 &&
      !final(ticks).marketOrders.o2,
    'terminal send once, second blocked by cooldown': (ticks) =>
      Object.values(final(ticks).transactions).filter((t) => t.from === 'W5N5' && !t.order)
        .length === 1,
    'money logs written': (ticks) => Object.keys(final(ticks).usersMoney).length >= 4,
  },
};

const intershard = {
  name: 'market-intershard-resource-deal',
  description:
    'deal on an intershard resource (pixel) order: account resources move through `resources.<type>` increments',
  coverage: ['market-intershard', 'users-resources-log'],
  clock: CLOCK,
  world: world({
    rooms: { W1N1: room('W1N1') },
    terrain: { W1N1: terrain() },
    activeRooms: ['W1N1'],
    users: byId(
      user('u1', 'buyer', { rooms: ['W1N1'], money: 1_000_000, resources: {} }),
      user('u2', 'seller', { money: 0, resources: { pixel: 10 } }),
    ),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W1N1',
        x: 2,
        y: 2,
        user: 'u1',
        level: 2,
        downgradeTime: T0 + 20000,
      }),
    ),
    marketOrders: byId({
      _id: 'o1',
      created: 1,
      createdTimestamp: CLOCK.start - 1000,
      user: 'u2',
      active: true,
      type: 'sell',
      amount: 10,
      remainingAmount: 10,
      totalAmount: 10,
      resourceType: 'pixel',
      price: 2000,
    }),
  }),
  ticks: [
    { intents: { u1: { global: { deal: [{ orderId: 'o1', amount: 3, targetRoomName: '' }] } } } },
    { intents: { u1: { global: { deal: [{ orderId: 'o1', amount: 2, targetRoomName: '' }] } } } },
  ],
  checks: {
    'two deals executed': (ticks) =>
      final(ticks).marketOrders.o1.remainingAmount === 5 && final(ticks).users.u2.money === 10000,
  },
  divergences: [
    {
      name: 'storage-dotted-inc',
      kind: 'safety',
      reason:
        'engine processor/global-intents/market.js:435,465 increments account resources with bulkUsers.inc(user, ' +
        "'resources.' + type, n). Pinned screeps/storage lib/db.js updateDocument applies $inc to a literal top-level key " +
        '"resources.pixel", so persisted resources.pixel never changes: the seller keeps sold pixels and the buyer never ' +
        'receives them (account resource duplication). Local applies the dotted path to the nested balance (MongoDB ' +
        'semantics of the official server); preserved to keep account resources conserved.',
      paths: [
        /^users\.u[12]\["resources\.pixel"\]$/,
        /^users\.u[12]\.resources\.pixel$/,
        /^usersResources\.[\w-]+\.balance$/,
      ],
      oracle: (ticks) => {
        const users = final(ticks).users;
        return (
          users.u2.resources.pixel === 10 &&
          users.u2['resources.pixel'] === -5 &&
          users.u1.resources.pixel === undefined &&
          users.u1['resources.pixel'] === 5
        );
      },
      local: (ticks) => {
        const users = final(ticks).users;
        return (
          users.u2.resources.pixel === 5 &&
          users.u1.resources.pixel === 5 &&
          !('resources.pixel' in users.u1) &&
          !('resources.pixel' in users.u2)
        );
      },
    },
  ],
};

const power = {
  name: 'power-creep-lifecycle',
  description:
    'power creep creation, upgrade and spawn, enableRoom, GENERATE_OPS with cooldown, renew at a power spawn, suicide into a tombstone ' +
    'with wall-clock respawn cooldown, refused respawn, delete with cooldown',
  coverage: [
    'createPowerCreep',
    'upgradePowerCreep',
    'spawnPowerCreep',
    'enableRoom',
    'usePower',
    'power-cooldown',
    'power-creep-renew',
    'suicidePowerCreep',
    'power-creep-tombstone',
    'deletePowerCreep',
    'wall-clock-cooldown',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W1N1: room('W1N1') },
    terrain: { W1N1: terrain() },
    activeRooms: ['W1N1'],
    users: byId(user('u1', 'operator', { rooms: ['W1N1'], power: 10000 })),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W1N1',
        x: 21,
        y: 21,
        user: 'u1',
        level: 8,
        downgradeTime: T0 + 200000,
      }),
      structure('pspawn', 'powerSpawn', {
        room: 'W1N1',
        x: 20,
        y: 20,
        user: 'u1',
        store: { energy: 5000, power: 100 },
      }),
    ),
  }),
  ticks: [
    { intents: { u1: { global: { createPowerCreep: [{ name: 'PC1', className: 'operator' }] } } } },
    {
      intents: {
        u1: {
          // Spawn runs before upgrade in the power processor: the room copy is spawned at level 0.
          global: {
            upgradePowerCreep: [{ id: '@powerCreep:PC1', power: 1 }],
            spawnPowerCreep: [{ id: 'pspawn', name: 'PC1' }],
          },
        },
      },
    },
    { intents: { u1: { global: { upgradePowerCreep: [{ id: '@powerCreep:PC1', power: 2 }] } } } },
    { intents: { u1: { '@name:PC1': { enableRoom: { id: 'ctrl' } } } } },
    { intents: { u1: { '@name:PC1': { usePower: { power: 1 } } } } },
    { intents: { u1: { '@name:PC1': { usePower: { power: 1 } } } } },
    { intents: { u1: { '@name:PC1': { move: { direction: DIR.LEFT } } } } },
    { intents: { u1: { '@name:PC1': { renew: { id: 'pspawn' } } } } },
    { intents: { u1: { global: { suicidePowerCreep: [{ id: '@powerCreep:PC1' }] } } } },
    { intents: { u1: { global: { spawnPowerCreep: [{ id: 'pspawn', name: 'PC1' }] } } } },
    { intents: { u1: { global: { deletePowerCreep: [{ id: '@powerCreep:PC1' }] } } } },
  ],
  checks: {
    'same-tick spawn copied level 0, next upgrade synced the room copy': (ticks) =>
      objectsOf(ticks[1].world, (o) => o.type === 'powerCreep' && o.level === 0).length === 1 &&
      Object.values(ticks[1].world.userPowerCreeps)[0].level === 1 &&
      objectsOf(ticks[2].world, (o) => o.type === 'powerCreep' && o.level === 2).length === 1,
    'room enabled for powers': (ticks) => final(ticks).roomObjects.ctrl.isPowerEnabled === true,
    'ops generated once under cooldown': (ticks) =>
      objectsOf(ticks[5].world, (o) => o.type === 'powerCreep' && o.store.ops > 0).length === 1 &&
      JSON.stringify(objectsOf(ticks[4].world, (o) => o.type === 'powerCreep')[0].store) ===
        JSON.stringify(objectsOf(ticks[5].world, (o) => o.type === 'powerCreep')[0].store),
    'suicide left a power creep tombstone, respawn refused, delete scheduled': (ticks) => {
      const doc = Object.values(final(ticks).userPowerCreeps)[0];
      return (
        objectsOf(final(ticks), (o) => o.type === 'tombstone' && o.powerCreepName === 'PC1')
          .length === 1 &&
        !objectsOf(final(ticks), (o) => o.type === 'powerCreep').length &&
        doc.spawnCooldownTime > CLOCK.start &&
        doc.deleteTime > CLOCK.start
      );
    },
  },
};

const npc = {
  name: 'npc-keeper-mineral-regen',
  description:
    'keeper lair spawning a keeper next to its source, keeper melee/ranged AI against a hostile until death, mineral regeneration ' +
    'with random density re-roll (controlled random stream)',
  coverage: [
    'keeper-lair',
    'keeper-ai',
    'npc-intents',
    'mineral-regen',
    'mineral-density-random',
    'random-stream',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W5N4: room('W5N4') },
    terrain: { W5N4: terrain() },
    activeRooms: ['W5N4'],
    users: byId(user('u1', 'intruder'), ...Object.values(npcUsers())),
    roomObjects: byId(
      source('src', { room: 'W5N4', x: 10, y: 10, energy: 4000, energyCapacity: 4000 }),
      structure('lair', 'keeperLair', { room: 'W5N4', x: 11, y: 11, nextSpawnTime: T0 + 2 }),
      creep('victim', {
        room: 'W5N4',
        x: 12,
        y: 12,
        user: 'u1',
        body: ['tough', 'tough', 'tough', 'tough', 'tough', 'move'],
      }),
      creep('watcher', { room: 'W5N4', x: 30, y: 30, user: 'u1', body: ['move'] }),
      mineral('min', {
        room: 'W5N4',
        x: 40,
        y: 40,
        mineralType: 'X',
        mineralAmount: 0,
        density: 1,
        nextRegenerationTime: T0 + 3,
      }),
    ),
  }),
  ticks: repeat(8, {}),
  checks: {
    'keeper spawned and adopted its source': (ticks) =>
      objectsOf(
        final(ticks),
        (o) => o.user === '3' && o.name === 'Keeperlair' && o.memory_sourceId === 'src',
      ).length === 1,
    'victim killed by the keeper': (ticks) => !final(ticks).roomObjects.victim,
    'mineral regenerated with re-rolled density': (ticks) =>
      final(ticks).roomObjects.min.mineralAmount > 0 && final(ticks).roomObjects.min.density !== 1,
    'random stream advanced': (ticks) => final(ticks).rngState !== 0x2545f491,
  },
};

const decay = {
  name: 'decay-and-downgrade',
  description:
    'road/rampart/container decay to destruction, dropped energy decay, tombstone and ruin expiry dropping resources, controller ' +
    'downgrade, portal destabilisation by wall clock, power bank expiry',
  coverage: [
    'road-decay',
    'rampart-decay',
    'container-decay',
    'energy-decay',
    'tombstone-decay',
    'ruin-decay',
    'controller-downgrade',
    'portal-unstable',
    'power-bank-decay',
    'wall-clock',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W6N6: room('W6N6'), W7N7: room('W7N7') },
    terrain: { W6N6: terrain(), W7N7: terrain() },
    activeRooms: ['W6N6'],
    users: byId(user('u1', 'neglect', { rooms: ['W6N6'] })),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W6N6',
        x: 2,
        y: 2,
        user: 'u1',
        level: 2,
        progress: 10,
        downgradeTime: T0 + 2,
      }),
      structure('road', 'road', { room: 'W6N6', x: 10, y: 10, hits: 100, nextDecayTime: T0 + 1 }),
      structure('rampart', 'rampart', {
        room: 'W6N6',
        x: 11,
        y: 10,
        user: 'u1',
        hits: 300,
        nextDecayTime: T0 + 2,
      }),
      structure('container', 'container', {
        room: 'W6N6',
        x: 12,
        y: 10,
        hits: 5000,
        nextDecayTime: T0 + 1,
        store: { energy: 40 },
      }),
      {
        _id: 'drop',
        type: 'energy',
        room: 'W6N6',
        x: 13,
        y: 10,
        resourceType: 'energy',
        energy: 1500,
      },
      {
        _id: 'grave',
        type: 'tombstone',
        room: 'W6N6',
        x: 14,
        y: 10,
        user: 'u1',
        deathTime: T0 - 10,
        decayTime: T0 + 2,
        creepId: 'gone',
        creepName: 'Gone',
        creepTicksToLive: 5,
        creepBody: ['move'],
        store: { energy: 25 },
      },
      {
        _id: 'remains',
        type: 'ruin',
        room: 'W6N6',
        x: 15,
        y: 10,
        user: 'u1',
        destroyTime: T0 - 10,
        decayTime: T0 + 3,
        structure: { id: 'oldspawn', type: 'spawn', hits: 0, hitsMax: 5000, user: 'u1' },
        store: { energy: 60 },
      },
      {
        _id: 'portal',
        type: 'portal',
        room: 'W6N6',
        x: 30,
        y: 30,
        destination: { room: 'W7N7', x: 25, y: 25 },
        unstableDate: CLOCK.start + CLOCK.step,
        decayTime: null,
      },
      {
        _id: 'bank',
        type: 'powerBank',
        room: 'W6N6',
        x: 35,
        y: 35,
        hits: 2000000,
        hitsMax: 2000000,
        store: { power: 500 },
        decayTime: T0 + 3,
      },
    ),
  }),
  ticks: repeat(6, {}),
  checks: {
    'road, rampart and container decayed away': (ticks) =>
      ['road', 'rampart', 'container'].every((id) => !final(ticks).roomObjects[id]),
    'dropped energy decayed': (ticks) =>
      ever(ticks, (w) => w.roomObjects.drop && w.roomObjects.drop.energy < 1500),
    'tombstone and ruin expired': (ticks) =>
      !final(ticks).roomObjects.grave && !final(ticks).roomObjects.remains,
    'controller downgraded': (ticks) => final(ticks).roomObjects.ctrl.level === 1,
    'portal destabilised': (ticks) =>
      final(ticks).roomObjects.portal.unstableDate === null &&
      final(ticks).roomObjects.portal.decayTime > T0,
    'power bank expired': (ticks) => !final(ticks).roomObjects.bank,
  },
};

const controllers = {
  name: 'controller-claim-reserve-attack',
  description:
    'claim with GCL room count, reservation growth, attackController blocking upgrades and safe mode, signing with wall-clock datetime, ' +
    'generateSafeMode, unclaim with user room bookkeeping',
  coverage: [
    'claimController',
    'reserveController',
    'attackController',
    'signController',
    'activateSafeMode',
    'generateSafeMode',
    'unclaim',
    'user-rooms',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W7N7: room('W7N7'), W8N7: room('W8N7'), W9N7: room('W9N7'), W6N7: room('W6N7') },
    terrain: { W7N7: terrain(), W8N7: terrain(), W9N7: terrain(), W6N7: terrain() },
    activeRooms: ['W7N7', 'W8N7', 'W9N7', 'W6N7'],
    users: byId(
      user('u1', 'expander', { rooms: ['W7N7', 'W6N7'], gcl: 20_000_000 }),
      user('u2', 'rival', { rooms: [], gcl: 0 }),
    ),
    roomObjects: byId(
      controller('home', {
        room: 'W7N7',
        x: 25,
        y: 25,
        user: 'u1',
        level: 4,
        downgradeTime: T0 + 50000,
      }),
      controller('neutral', { room: 'W8N7', x: 25, y: 25, user: undefined, level: 0 }),
      controller('remote', { room: 'W9N7', x: 25, y: 25, user: undefined, level: 0 }),
      controller('outpost', {
        room: 'W6N7',
        x: 25,
        y: 25,
        user: 'u1',
        level: 1,
        downgradeTime: T0 + 20000,
      }),
      creep('claimer', { room: 'W8N7', x: 24, y: 24, user: 'u1', body: ['claim', 'move'] }),
      creep('reserver', {
        room: 'W9N7',
        x: 24,
        y: 24,
        user: 'u2',
        body: ['claim', 'claim', 'move'],
      }),
      creep('raider', {
        room: 'W7N7',
        x: 24,
        y: 24,
        user: 'u2',
        body: ['claim', 'claim', 'claim', 'claim', 'claim', 'move'],
      }),
      creep('engineer', {
        room: 'W7N7',
        x: 26,
        y: 26,
        user: 'u1',
        body: ['carry', 'carry', 'move'],
        store: { G: 1000 },
      }),
    ),
  }),
  ticks: [
    {
      intents: {
        u1: {
          claimer: { claimController: { id: 'neutral' } },
          engineer: { generateSafeMode: { id: 'home' } },
        },
        u2: {
          reserver: { reserveController: { id: 'remote' } },
          raider: { attackController: { id: 'home' } },
        },
      },
    },
    {
      intents: {
        u1: {
          claimer: { signController: { id: 'neutral', sign: 'mine now' } },
          home: { activateSafeMode: {} },
        },
        u2: { reserver: { reserveController: { id: 'remote' } } },
      },
    },
    {
      intents: {
        u1: { outpost: { unclaim: {} } },
        u2: { reserver: { reserveController: { id: 'remote' } } },
      },
    },
    ...repeat(2, { u2: { reserver: { reserveController: { id: 'remote' } } } }),
  ],
  checks: {
    'neutral claimed and signed': (ticks) =>
      final(ticks).roomObjects.neutral.user === 'u1' &&
      final(ticks).roomObjects.neutral.sign?.text === 'mine now',
    'remote reserved and growing': (ticks) =>
      final(ticks).roomObjects.remote.reservation?.user === 'u2',
    'home attacked: upgrade blocked': (ticks) => final(ticks).roomObjects.home.upgradeBlocked > T0,
    'safe mode generated': (ticks) =>
      ever(ticks, (w) => w.roomObjects.home.safeModeAvailable === 2),
    'outpost unclaimed and rooms list updated': (ticks) =>
      !final(ticks).roomObjects.outpost.user &&
      !final(ticks).users.u1.rooms.includes('W6N7') &&
      final(ticks).users.u1.rooms.includes('W8N7'),
  },
};

const flags = {
  name: 'room-intents-flags',
  description:
    'flag creation/removal through room intents, a second user creating flags in a room without flag documents in the same tick ' +
    '(upstream aborts that room), construction site placement and removal',
  coverage: [
    'createFlag',
    'removeFlag',
    'flag-docs',
    'room-processing-error',
    'removeConstructionSite',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W1N1: room('W1N1'), W2N1: room('W2N1') },
    terrain: { W1N1: terrain(), W2N1: terrain() },
    activeRooms: ['W1N1', 'W2N1'],
    users: byId(user('u1', 'flagger', { rooms: ['W1N1'] }), user('u2', 'other')),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W1N1',
        x: 2,
        y: 2,
        user: 'u1',
        level: 3,
        downgradeTime: T0 + 20000,
      }),
      creep('scout', { room: 'W2N1', x: 20, y: 20, user: 'u2', body: ['move'] }),
      creep('scout1', { room: 'W2N1', x: 22, y: 20, user: 'u1', body: ['move'] }),
    ),
  }),
  ticks: [
    {
      intents: {
        u1: {
          room: {
            createFlag: [
              { roomName: 'W1N1', x: 10, y: 10, name: 'Home', color: 1, secondaryColor: 2 },
              { roomName: 'W1N1', x: 11, y: 10, name: 'Tmp|x', color: 3, secondaryColor: 3 },
            ],
            createConstructionSite: [{ roomName: 'W1N1', x: 15, y: 15, structureType: 'tower' }],
          },
        },
      },
    },
    {
      intents: {
        u1: {
          room: {
            removeFlag: [{ roomName: 'W1N1', name: 'Tmp|x' }],
            createFlag: [
              { roomName: 'W2N1', x: 5, y: 5, name: 'Far', color: 2, secondaryColor: 2 },
            ],
            removeConstructionSite: [{ roomName: 'W1N1', id: '@at:constructionSite:15:15' }],
          },
          scout1: { move: { direction: DIR.RIGHT } },
        },
        u2: {
          room: {
            createFlag: [
              { roomName: 'W2N1', x: 6, y: 5, name: 'Mine', color: 4, secondaryColor: 4 },
            ],
          },
          scout: { move: { direction: DIR.LEFT } },
        },
      },
    },
    {
      intents: {
        u1: {
          room: {
            createFlag: [
              { roomName: 'W2N1', x: 7, y: 5, name: 'Later', color: 5, secondaryColor: 5 },
            ],
          },
        },
      },
    },
  ],
  checks: {
    'flags created with escaped name': (ticks) =>
      Object.values(ticks[0].world.flags).some((f) => f.user === 'u1' && /Home/.test(f.data)),
    'construction site placed then removed': (ticks) =>
      objectsOf(ticks[0].world, (o) => o.type === 'constructionSite').length === 1 &&
      objectsOf(final(ticks), (o) => o.type === 'constructionSite').length === 0,
    'concurrent first flags aborted the room that tick': (ticks) =>
      ticks[1].roomErrors.some((e) => e.room === 'W2N1'),
  },
};

/*
 * Processing-order reproductions. Upstream processing order is defined by storage and scheduling, not
 * by the engine: room objects come from a LokiJS binary-index query (equal-room documents most
 * recently inserted/updated first), rooms are popped LIFO from the storage queue. The local Simulation
 * iterates world insertion order and queues rooms FIFO. These scenarios show the observable effect in
 * the default (independent) mode; `--controlled-order` replays the oracle's order and must match.
 */
const orderObjects = {
  name: 'order-same-tick-downgrade-rampart',
  description:
    'controller downgrades in the same tick a rampart reads the controller level for its hitsMax: the result depends on which ' +
    'of the two objects the room loop visits first',
  coverage: ['processing-order', 'controller-downgrade', 'rampart-hitsMax'],
  clock: CLOCK,
  world: world({
    rooms: { W4N4: room('W4N4') },
    terrain: { W4N4: terrain() },
    activeRooms: ['W4N4'],
    users: byId(user('u1', 'keeper', { rooms: ['W4N4'] })),
    roomObjects: byId(
      controller('ctrl', { room: 'W4N4', x: 2, y: 2, user: 'u1', level: 2, downgradeTime: T0 + 1 }),
      structure('wall', 'rampart', {
        room: 'W4N4',
        x: 10,
        y: 10,
        user: 'u1',
        hits: 50000,
        hitsMax: 300000,
      }),
    ),
  }),
  ticks: repeat(3, {}),
  checks: {
    'controller downgraded on the first tick': (ticks) =>
      ticks[0].world.roomObjects.ctrl.level === 1,
    'rampart hitsMax follows the level-1 controller by the end': (ticks) =>
      final(ticks).roomObjects.wall.hitsMax === 0,
  },
};

const orderRooms = {
  name: 'order-rooms-random-draws',
  description:
    'two rooms regenerate low-density minerals in the same tick; each re-roll draws from the shared random stream, so the ' +
    'densities depend on which room is processed first',
  coverage: ['processing-order', 'room-order', 'mineral-density-random', 'random-stream'],
  clock: CLOCK,
  world: world({
    rooms: { W1N8: room('W1N8'), W2N8: room('W2N8') },
    terrain: { W1N8: terrain(), W2N8: terrain() },
    activeRooms: ['W1N8', 'W2N8'],
    users: byId(user('u1', 'prospector')),
    // mulberry32 from 8: the first two re-roll draws select densities 2 and 3, so the room order is visible.
    rngState: 8,
    roomObjects: byId(
      creep('scoutA', { room: 'W1N8', x: 20, y: 20, user: 'u1', body: ['move'] }),
      mineral('mineralA', {
        room: 'W1N8',
        x: 40,
        y: 40,
        mineralType: 'O',
        mineralAmount: 0,
        density: 1,
        nextRegenerationTime: T0 + 1,
      }),
      creep('scoutB', { room: 'W2N8', x: 20, y: 20, user: 'u1', body: ['move'] }),
      mineral('mineralB', {
        room: 'W2N8',
        x: 40,
        y: 40,
        mineralType: 'H',
        mineralAmount: 0,
        density: 1,
        nextRegenerationTime: T0 + 1,
      }),
    ),
  }),
  ticks: repeat(2, {}),
  checks: {
    'both minerals re-rolled their density on the first tick': (ticks) =>
      ticks[0].world.roomObjects.mineralA.density !== 1 &&
      ticks[0].world.roomObjects.mineralB.density !== 1,
  },
};
const construction = {
  name: 'construction-placement-rules',
  description:
    'createConstructionSite acceptance: controller structure limits counting sites, terrain walls, room edges and exit ' +
    'neighbourhood, duplicates in one tick, sites under creeps and over structures, foreign rooms, extractor rules; ' +
    'removal and building a placed rampart',
  coverage: [
    'createConstructionSite',
    'construction-limits',
    'construction-terrain',
    'construction-edges',
    'removeConstructionSite',
    'construction-foreign-room',
    'build',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W1N1: room('W1N1') },
    terrain: {
      W1N1: terrain({
        walls: [
          [10, 10],
          [11, 10],
        ],
      }),
    },
    activeRooms: ['W1N1'],
    users: byId(user('u1', 'planner', { rooms: ['W1N1'] }), user('u2', 'intruder')),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W1N1',
        x: 25,
        y: 25,
        user: 'u1',
        level: 2,
        downgradeTime: T0 + 20000,
      }),
      structure('spawn1', 'spawn', { room: 'W1N1', x: 20, y: 20, user: 'u1', name: 'Spawn1' }),
      ...[0, 1, 2, 3].map((i) =>
        structure(`ext${i}`, 'extension', { room: 'W1N1', x: 30 + i, y: 20, user: 'u1' }),
      ),
      constructionSite('extSite', {
        room: 'W1N1',
        x: 34,
        y: 20,
        user: 'u1',
        structureType: 'extension',
        progressTotal: 3000,
      }),
      mineral('mineral', { room: 'W1N1', x: 40, y: 40 }),
      creep('builder', {
        room: 'W1N1',
        x: 21,
        y: 21,
        user: 'u1',
        body: ['work', 'work', 'carry', 'move'],
        store: { energy: 50 },
      }),
      creep('visitor', { room: 'W1N1', x: 15, y: 15, user: 'u2', body: ['move'] }),
    ),
  }),
  ticks: [
    {
      intents: {
        u1: {
          room: {
            createConstructionSite: [
              { roomName: 'W1N1', x: 30, y: 30, structureType: 'extension' },
              { roomName: 'W1N1', x: 10, y: 10, structureType: 'road' },
              { roomName: 'W1N1', x: 11, y: 10, structureType: 'container' },
              { roomName: 'W1N1', x: 31, y: 31, structureType: 'tower' },
              { roomName: 'W1N1', x: 20, y: 20, structureType: 'rampart' },
              { roomName: 'W1N1', x: 25, y: 30, structureType: 'spawn', name: 'Spawn2' },
              { roomName: 'W1N1', x: 0, y: 25, structureType: 'road' },
              { roomName: 'W1N1', x: 1, y: 25, structureType: 'constructedWall' },
              { roomName: 'W1N1', x: 2, y: 25, structureType: 'constructedWall' },
              { roomName: 'W1N1', x: 12, y: 12, structureType: 'road' },
              { roomName: 'W1N1', x: 12, y: 12, structureType: 'container' },
              { roomName: 'W1N1', x: 15, y: 15, structureType: 'road' },
              { roomName: 'W1N1', x: 35, y: 35, structureType: 'constructedWall' },
              { roomName: 'W1N1', x: 40, y: 40, structureType: 'extractor' },
              { roomName: 'W1N1', x: 36, y: 36, structureType: 'nuker' },
              { roomName: 'W1N1', x: 37, y: 37, structureType: 'bogus' },
            ],
          },
        },
        u2: {
          room: {
            createConstructionSite: [{ roomName: 'W1N1', x: 16, y: 16, structureType: 'road' }],
          },
        },
      },
    },
    {
      intents: {
        u1: {
          room: {
            removeConstructionSite: [{ roomName: 'W1N1', id: '@at:constructionSite:35:35' }],
          },
          builder: { build: { id: '@at:constructionSite:20:20', x: 20, y: 20 } },
        },
      },
    },
    { intents: { u1: { builder: { build: { id: '@at:constructionSite:20:20', x: 20, y: 20 } } } } },
  ],
  checks: {
    'some sites accepted and some refused': (ticks) => {
      const sites = objectsOf(ticks[0].world, (o) => o.type === 'constructionSite').length;
      return sites > 2 && sites < 17;
    },
    'rampart over the spawn was built to completion': (ticks) =>
      objectsOf(final(ticks), (o) => o.type === 'rampart' && o.x === 20 && o.y === 20).length === 1,
    'removed site is gone': (ticks) =>
      objectsOf(final(ticks), (o) => o.type === 'constructionSite' && o.x === 35).length === 0,
  },
};

const spawning = {
  name: 'spawning-energy-directions-blocking',
  restartLocalBefore: [4, 12],
  description:
    'createCreep drawing from explicit energyStructures, spawn directions and their change while spawning, a spawn whose ' +
    'exits are blocked until a creep moves away, cancelSpawning, duplicate names',
  coverage: [
    'createCreep',
    'energyStructures',
    'spawn-directions',
    'setSpawnDirections',
    'spawn-blocked',
    'cancelSpawning',
    'creep-name-collision',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W2N3: room('W2N3') },
    terrain: {
      W2N3: terrain({
        walls: [
          [39, 9],
          [40, 9],
          [41, 9],
          [39, 10],
          [41, 10],
          [39, 11],
          [40, 11],
        ],
      }),
    },
    activeRooms: ['W2N3'],
    users: byId(user('u1', 'breeder', { rooms: ['W2N3'] })),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W2N3',
        x: 2,
        y: 2,
        user: 'u1',
        level: 7,
        downgradeTime: T0 + 50000,
      }),
      structure('spawnA', 'spawn', { room: 'W2N3', x: 20, y: 20, user: 'u1', name: 'SpawnA' }),
      structure('spawnB', 'spawn', { room: 'W2N3', x: 40, y: 10, user: 'u1', name: 'SpawnB' }),
      structure('ext1', 'extension', {
        room: 'W2N3',
        x: 22,
        y: 22,
        user: 'u1',
        store: { energy: 50 },
      }),
      structure('ext2', 'extension', {
        room: 'W2N3',
        x: 23,
        y: 22,
        user: 'u1',
        store: { energy: 50 },
      }),
      creep('plug', { room: 'W2N3', x: 41, y: 11, user: 'u1', body: ['move'], name: 'Plug' }),
    ),
  }),
  ticks: [
    {
      intents: {
        u1: {
          spawnA: {
            createCreep: {
              name: 'Big',
              body: ['work', 'carry', 'move', 'move'],
              energyStructures: ['ext2', 'spawnA'],
              directions: [3],
            },
          },
          spawnB: { createCreep: { name: 'Tiny', body: ['move'] } },
        },
      },
    },
    { intents: { u1: { spawnA: { setSpawnDirections: { directions: [5, 6] } } } } },
    { intents: { u1: { spawnB: { createCreep: { name: 'Plug', body: ['move'] } } } } },
    ...repeat(3, {}),
    { intents: { u1: { plug: { move: { direction: DIR.BOTTOM } } } } },
    ...repeat(5, {}),
    { intents: { u1: { spawnB: { createCreep: { name: 'Doomed', body: ['work', 'move'] } } } } },
    { intents: { u1: { spawnB: { cancelSpawning: {} } } } },
    ...repeat(2, {}),
  ],
  checks: {
    'energy drawn from the listed extension first': (ticks) =>
      ticks[0].world.roomObjects.ext2.store.energy === 0 &&
      ticks[0].world.roomObjects.ext1.store.energy === 50,
    'Big spawned below the spawn after the direction change': (ticks) =>
      objectsOf(final(ticks), (o) => o.name === 'Big' && !o.spawning && o.y === 21).length === 1,
    'Tiny waited for the blocked exit': (ticks) =>
      ever(
        ticks,
        (w) =>
          objectsOf(w, (o) => o.name === 'Tiny' && o.spawning).length === 1 && w.gameTime > T0 + 4,
      ) && objectsOf(final(ticks), (o) => o.name === 'Tiny' && !o.spawning).length === 1,
    'cancelled creep never appeared': (ticks) =>
      objectsOf(final(ticks), (o) => o.name === 'Doomed').length === 0,
  },
};

const nuke = {
  name: 'nuke-landing',
  description:
    'a nuke landing next tick cancels spawning intents, kills every creep without tombstones, damages structures in range ' +
    'through ramparts, clears sites, drops and tombstones, cancels safe mode',
  coverage: ['nuke-pretick', 'nuke-landing', 'nuke-damage', 'rampart-absorb', 'safe-mode-cancel'],
  clock: CLOCK,
  world: world({
    rooms: { W5N6: room('W5N6') },
    terrain: { W5N6: terrain() },
    activeRooms: ['W5N6'],
    users: byId(user('u1', 'target', { rooms: ['W5N6'] }), user('u2', 'launcher')),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W5N6',
        x: 2,
        y: 2,
        user: 'u1',
        level: 6,
        downgradeTime: T0 + 100000,
        safeMode: T0 + 5000,
      }),
      {
        _id: 'nuke',
        type: 'nuke',
        room: 'W5N6',
        x: 25,
        y: 25,
        landTime: T0 + 1,
        launchRoomName: 'W5N8',
      },
      structure('spawn1', 'spawn', {
        room: 'W5N6',
        x: 26,
        y: 26,
        user: 'u1',
        name: 'Spawn1',
        hits: 5000,
      }),
      structure('shield', 'rampart', { room: 'W5N6', x: 27, y: 25, user: 'u1', hits: 6000000 }),
      structure('tower', 'tower', {
        room: 'W5N6',
        x: 27,
        y: 25,
        user: 'u1',
        store: { energy: 100 },
      }),
      structure('storage', 'storage', {
        room: 'W5N6',
        x: 30,
        y: 30,
        user: 'u1',
        store: { energy: 1000 },
      }),
      creep('victim', { room: 'W5N6', x: 40, y: 40, user: 'u1', body: ['move'], store: {} }),
      creep('bystander', {
        room: 'W5N6',
        x: 10,
        y: 10,
        user: 'u2',
        body: ['carry', 'move'],
        store: { energy: 50 },
      }),
      constructionSite('site', {
        room: 'W5N6',
        x: 5,
        y: 5,
        user: 'u1',
        structureType: 'road',
        progressTotal: 300,
      }),
      {
        _id: 'drop',
        type: 'energy',
        room: 'W5N6',
        x: 6,
        y: 6,
        resourceType: 'energy',
        energy: 100,
      },
    ),
  }),
  ticks: [
    { intents: { u1: { spawn1: { createCreep: { name: 'Late', body: ['move'] } } } } },
    ...repeat(2, {}),
  ],
  checks: {
    'creeps gone without tombstones': (ticks) =>
      !final(ticks).roomObjects.victim &&
      !final(ticks).roomObjects.bystander &&
      objectsOf(final(ticks), (o) => o.type === 'tombstone').length === 0,
    'spawn in range destroyed, rampart absorbed for the tower': (ticks) =>
      !final(ticks).roomObjects.spawn1 &&
      final(ticks).roomObjects.tower &&
      final(ticks).roomObjects.shield.hits < 6000000,
    'sites and drops cleared, safe mode cancelled': (ticks) =>
      !final(ticks).roomObjects.site &&
      !final(ticks).roomObjects.drop &&
      !(final(ticks).roomObjects.ctrl.safeMode > T0 + 3),
    'nuke removed': (ticks) => !final(ticks).roomObjects.nuke,
  },
};

const highway = {
  name: 'highway-power-bank-deposit',
  description:
    'attacking a power bank with hit-back until it breaks into power, deposit harvesting with growing cooldown',
  coverage: [
    'power-bank-attack',
    'power-bank-hit-back',
    'power-drop',
    'deposit-harvest',
    'deposit-cooldown',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W10N10: room('W10N10') },
    terrain: { W10N10: terrain() },
    activeRooms: ['W10N10'],
    users: byId(user('u1', 'raider')),
    roomObjects: byId(
      {
        _id: 'bank',
        type: 'powerBank',
        room: 'W10N10',
        x: 25,
        y: 25,
        hits: 1000,
        hitsMax: 2000000,
        store: { power: 300 },
        decayTime: T0 + 5000,
      },
      creep('hitter', {
        room: 'W10N10',
        x: 24,
        y: 24,
        user: 'u1',
        body: [...Array(10).fill('attack'), ...Array(10).fill('move')],
      }),
      creep('healer', { room: 'W10N10', x: 23, y: 23, user: 'u1', body: ['heal', 'heal', 'move'] }),
      {
        _id: 'deposit',
        type: 'deposit',
        room: 'W10N10',
        x: 40,
        y: 40,
        depositType: 'metal',
        harvested: 100,
        cooldown: 0,
        decayTime: T0 + 50000,
      },
      creep('digger', {
        room: 'W10N10',
        x: 41,
        y: 41,
        user: 'u1',
        body: [...Array(5).fill('work'), 'carry', 'carry', 'move'],
      }),
    ),
  }),
  ticks: repeat(8, () => ({
    u1: {
      hitter: { attack: { id: 'bank', x: 25, y: 25 } },
      healer: { rangedHeal: { id: 'hitter' } },
      digger: { harvest: { id: 'deposit' } },
    },
  })),
  checks: {
    'bank broke and power dropped': (ticks) =>
      !final(ticks).roomObjects.bank &&
      objectsOf(
        final(ticks),
        (o) =>
          (o.type === 'energy' && o.resourceType === 'power') ||
          (o.type === 'ruin' && o.store?.power),
      ).length >= 1,
    'hit-back damaged the attacker': (ticks) =>
      ever(ticks, (w) => w.roomObjects.hitter && w.roomObjects.hitter.hits < 2000),
    'deposit harvested repeatedly': (ticks) =>
      final(ticks).roomObjects.deposit.harvested === 140 &&
      final(ticks).roomObjects.digger.store.metal === 40,
  },
};

const safeModeBoosts = {
  name: 'safe-mode-boosts-labs',
  description:
    'hostile actions blocked during safe mode while the owner acts, boosted harvest/upgrade/attack, unboost into the lab ' +
    'with cooldown, reverse reaction',
  coverage: [
    'safe-mode',
    'boosted-harvest',
    'boosted-upgrade',
    'boosted-attack',
    'unboostCreep',
    'reverseReaction',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W3N5: room('W3N5') },
    terrain: { W3N5: terrain() },
    activeRooms: ['W3N5'],
    users: byId(user('u1', 'owner', { rooms: ['W3N5'] }), user('u2', 'raider')),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W3N5',
        x: 25,
        y: 25,
        user: 'u1',
        level: 7,
        progress: 1000,
        downgradeTime: T0 + 100000,
        safeMode: T0 + 3,
      }),
      source('src', { room: 'W3N5', x: 10, y: 10 }),
      creep('miner', {
        room: 'W3N5',
        x: 11,
        y: 11,
        user: 'u1',
        body: [{ type: 'work', boost: 'UO' }, 'work', 'carry', 'move'],
      }),
      creep('upgrader', {
        room: 'W3N5',
        x: 24,
        y: 24,
        user: 'u1',
        body: [{ type: 'work', boost: 'GH' }, 'carry', 'move'],
        store: { energy: 50 },
      }),
      creep('guard', {
        room: 'W3N5',
        x: 30,
        y: 30,
        user: 'u1',
        body: [{ type: 'attack', boost: 'UH' }, 'attack', 'move'],
      }),
      creep('raider', {
        room: 'W3N5',
        x: 31,
        y: 31,
        user: 'u2',
        body: ['attack', 'attack', 'tough', 'tough', 'tough', 'move'],
      }),
      lab('labX', 14, 10, null, 0, 0, 'W3N5'),
      creep('boosted', {
        room: 'W3N5',
        x: 15,
        y: 11,
        user: 'u1',
        body: [{ type: 'carry', boost: 'KH' }, { type: 'carry', boost: 'KH' }, 'move'],
      }),
      lab('labR', 16, 14, 'OH', 100, 0, 'W3N5'),
      lab('labO', 17, 14, null, 0, 0, 'W3N5'),
      lab('labH', 18, 14, null, 0, 0, 'W3N5'),
    ),
  }),
  ticks: [
    {
      intents: {
        u1: {
          miner: { harvest: { id: 'src' } },
          upgrader: { upgradeController: { id: 'ctrl' } },
          guard: { attack: { id: 'raider', x: 31, y: 31 } },
          labX: { unboostCreep: { id: 'boosted' } },
          labR: { reverseReaction: { lab1: 'labO', lab2: 'labH' } },
        },
        u2: { raider: { attack: { id: 'guard', x: 30, y: 30 } } },
      },
    },
    ...repeat(4, (index) => ({
      u1: { miner: { harvest: { id: 'src' } }, guard: { attack: { id: 'raider', x: 31, y: 31 } } },
      u2: { raider: { attack: { id: 'guard', x: 30, y: 30 } } },
    })),
  ],
  checks: {
    'raider blocked during safe mode, boosted guard hits harder': (ticks) =>
      ticks.slice(0, 3).every((t) => t.world.roomObjects.guard.hits === 300) &&
      ticks[0].world.roomObjects.raider.hits === 510,
    'boosted harvest yields more than plain parts': (ticks) =>
      ticks[0].world.roomObjects.miner.store.energy === 8,
    'unboost cleared boosts and put the lab on cooldown': (ticks) =>
      final(ticks).roomObjects.boosted.body.every((p) => !p.boost) &&
      ticks[0].world.roomObjects.labX.cooldownTime > T0,
    'reverse reaction moved components out of the OH lab': (ticks) =>
      ticks[0].world.roomObjects.labR.store.OH === 95 &&
      Object.keys(ticks[0].world.roomObjects.labO.store).some((k) => k !== 'energy'),
  },
};

const logistics = {
  name: 'logistics-edge-cases',
  description:
    'withdraw from tombstones, ruins and a hostile storage under a rampart, transfer to another player creep, over-capacity ' +
    'transfers, drop onto a container tile, partial pickup, resource types outside the store',
  coverage: [
    'withdraw-tombstone',
    'withdraw-ruin',
    'withdraw-protected',
    'transfer-creep',
    'transfer-capacity',
    'drop-container',
    'pickup-partial',
    'invalid-resource',
  ],
  clock: CLOCK,
  world: world({
    rooms: { W4N1: room('W4N1') },
    terrain: { W4N1: terrain() },
    activeRooms: ['W4N1'],
    users: byId(user('u1', 'hauler'), user('u2', 'owner', { rooms: ['W4N1'] })),
    roomObjects: byId(
      controller('ctrl', {
        room: 'W4N1',
        x: 2,
        y: 2,
        user: 'u2',
        level: 5,
        downgradeTime: T0 + 100000,
      }),
      structure('vault', 'storage', {
        room: 'W4N1',
        x: 20,
        y: 20,
        user: 'u2',
        store: { energy: 5000 },
      }),
      structure('vaultGuard', 'rampart', { room: 'W4N1', x: 20, y: 20, user: 'u2', hits: 10000 }),
      {
        _id: 'grave',
        type: 'tombstone',
        room: 'W4N1',
        x: 30,
        y: 30,
        user: 'u2',
        deathTime: T0 - 1,
        decayTime: T0 + 100,
        creepId: 'old',
        creepName: 'Old',
        creepTicksToLive: 1,
        creepBody: ['carry'],
        store: { energy: 40, H: 10 },
      },
      {
        _id: 'remains',
        type: 'ruin',
        room: 'W4N1',
        x: 32,
        y: 30,
        user: 'u2',
        destroyTime: T0 - 1,
        decayTime: T0 + 100,
        structure: { id: 'x', type: 'storage', hits: 0, hitsMax: 10000, user: 'u2' },
        store: { energy: 500 },
      },
      structure('box', 'container', { room: 'W4N1', x: 25, y: 25, store: { energy: 1990 } }),
      {
        _id: 'pile',
        type: 'energy',
        room: 'W4N1',
        x: 35,
        y: 35,
        resourceType: 'energy',
        energy: 300,
      },
      creep('thief', { room: 'W4N1', x: 21, y: 21, user: 'u1', body: ['carry', 'carry', 'move'] }),
      creep('looter', { room: 'W4N1', x: 31, y: 31, user: 'u1', body: ['carry', 'carry', 'move'] }),
      creep('giver', {
        room: 'W4N1',
        x: 26,
        y: 26,
        user: 'u1',
        body: ['carry', 'carry', 'move'],
        store: { energy: 100 },
      }),
      creep('receiver', {
        room: 'W4N1',
        x: 27,
        y: 27,
        user: 'u2',
        body: ['carry', 'move'],
        store: { energy: 20 },
      }),
      creep('dropper', {
        room: 'W4N1',
        x: 25,
        y: 25,
        user: 'u1',
        body: ['carry', 'move'],
        store: { energy: 50 },
      }),
      creep('gleaner', { room: 'W4N1', x: 36, y: 36, user: 'u1', body: ['carry', 'move'] }),
    ),
  }),
  ticks: [
    {
      intents: {
        u1: {
          thief: { withdraw: { id: 'vault', resourceType: 'energy', amount: 50 } },
          looter: { withdraw: { id: 'grave', resourceType: 'H', amount: 10 } },
          giver: { transfer: { id: 'receiver', resourceType: 'energy', amount: 100 } },
          dropper: { drop: { resourceType: 'energy', amount: 50 } },
          gleaner: { pickup: { id: 'pile' } },
        },
      },
    },
    {
      intents: {
        u1: {
          looter: { withdraw: { id: 'remains', resourceType: 'energy', amount: 100 } },
          giver: { transfer: { id: 'receiver', resourceType: 'energy', amount: 30 } },
          thief: { withdraw: { id: 'vault', resourceType: 'power', amount: 1 } },
        },
      },
    },
    ...repeat(2, {}),
  ],
  checks: {
    'protected storage withheld energy': (ticks) =>
      final(ticks).roomObjects.vault.store.energy === 5000,
    'looted tombstone and ruin': (ticks) =>
      final(ticks).roomObjects.looter.store.H === 10 &&
      final(ticks).roomObjects.looter.store.energy > 0,
    'transfer to another player creep capped by capacity': (ticks) =>
      ticks[0].world.roomObjects.receiver.store.energy === 50,
    'drop on a full container overflowed to the floor': (ticks) =>
      final(ticks).roomObjects.box.store.energy === 2000 &&
      objectsOf(ticks[0].world, (o) => o.type === 'energy' && o.x === 25).length === 1,
    'partial pickup': (ticks) => ticks[0].world.roomObjects.gleaner.store.energy === 50,
  },
};

const borders = {
  name: 'portals-and-borders',
  description:
    'stepping onto an intra-shard portal, an exit into a closed (out of borders) room, moving onto a novice-area exit',
  coverage: ['portal-transfer', 'closed-room-exit', 'global-interroom'],
  clock: CLOCK,
  world: world({
    rooms: {
      W6N1: room('W6N1'),
      W7N1: room('W7N1', { status: 'out of borders' }),
      W9N9: room('W9N9'),
    },
    terrain: { W6N1: terrain(), W7N1: terrain(), W9N9: terrain() },
    activeRooms: ['W6N1'],
    users: byId(user('u1', 'traveler')),
    roomObjects: byId(
      {
        _id: 'portal',
        type: 'portal',
        room: 'W6N1',
        x: 25,
        y: 25,
        destination: { room: 'W9N9', x: 10, y: 10 },
        decayTime: null,
      },
      creep('jumper', { room: 'W6N1', x: 24, y: 25, user: 'u1', body: ['move'] }),
      creep('walker', { room: 'W6N1', x: 1, y: 30, user: 'u1', body: ['move'] }),
    ),
  }),
  ticks: repeat(4, () => ({
    u1: { jumper: { move: { direction: DIR.RIGHT } }, walker: { move: { direction: DIR.LEFT } } },
  })),
  checks: {
    'portal moved the creep to its destination': (ticks) =>
      ever(ticks, (w) => w.roomObjects.jumper.room === 'W9N9'),
    'walker never entered the closed room': (ticks) =>
      ticks.every((t) => t.world.roomObjects.walker.room === 'W6N1'),
  },
};

const invaderCore = {
  name: 'invader-core-reservation',
  description:
    'a level-0 invader core reserving a neutral controller each tick, then attacking another reservation',
  coverage: ['invader-core', 'npc-reserve', 'npc-attackController', 'random-stream'],
  clock: CLOCK,
  world: world({
    rooms: { W8N2: room('W8N2'), W8N3: room('W8N3') },
    terrain: { W8N2: terrain(), W8N3: terrain() },
    activeRooms: ['W8N2', 'W8N3'],
    users: byId(user('u1', 'neighbour'), ...Object.values(npcUsers())),
    roomObjects: byId(
      controller('free', { room: 'W8N2', x: 25, y: 25, user: undefined, level: 0 }),
      {
        _id: 'core',
        type: 'invaderCore',
        room: 'W8N2',
        x: 30,
        y: 30,
        user: '2',
        level: 0,
        hits: 100000,
        hitsMax: 100000,
        depositType: 'metal',
        templateName: '',
        actionLog: {},
      },
      controller('taken', {
        room: 'W8N3',
        x: 25,
        y: 25,
        user: undefined,
        level: 0,
        reservation: { user: 'u1', endTime: T0 + 1000 },
      }),
      {
        _id: 'core2',
        type: 'invaderCore',
        room: 'W8N3',
        x: 30,
        y: 30,
        user: '2',
        level: 0,
        hits: 100000,
        hitsMax: 100000,
        depositType: 'metal',
        templateName: '',
        actionLog: {},
      },
      creep('witness', { room: 'W8N2', x: 5, y: 5, user: 'u1', body: ['move'] }),
    ),
  }),
  ticks: repeat(4, {}),
  checks: {
    'core reserved the free controller': (ticks) =>
      final(ticks).roomObjects.free.reservation?.user === '2',
    'core attacked the foreign reservation': (ticks) =>
      final(ticks).roomObjects.taken.reservation?.endTime < T0 + 1000 ||
      final(ticks).roomObjects.taken.reservation?.user === '2',
  },
};

export const scenarios = [
  movement,
  economy,
  combat,
  structures,
  market,
  intershard,
  power,
  npc,
  decay,
  controllers,
  flags,
  construction,
  spawning,
  nuke,
  highway,
  safeModeBoosts,
  logistics,
  borders,
  invaderCore,
  orderObjects,
  orderRooms,
];
