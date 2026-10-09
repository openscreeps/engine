import { createWorldState } from '../../src/simulation/state.ts';

export const NOW = 1700000000000;
export function fixture() {
  const world = createWorldState({
    gameTime: 101,
    shardName: 'conformance',
    terrain: { W1N1: '0'.repeat(2500), W2N1: '0'.repeat(2500) },
    rooms: { W1N1: { _id: 'W1N1', status: 'normal' }, W2N1: { _id: 'W2N1', status: 'normal' } },
    users: {
      u1: {
        _id: 'u1',
        username: 'alice',
        cpu: 0,
        gcl: 10000000,
        power: 10000,
        money: 100000,
        rooms: ['W1N1'],
        resources: { pixel: 3 },
      },
      u2: { _id: 'u2', username: 'bob', cpu: 0, gcl: 0, power: 0, money: 0, rooms: ['W2N1'] },
    },
    flags: { f1: { _id: 'f1', user: 'u1', room: 'W1N1', data: 'Flag1~1~2~12~12' } },
    roomEventLogs: {
      W1N1: [
        { event: 1, objectId: 'worker', data: { targetId: 'hostile', damage: 30, attackType: 1 } },
      ],
    },
  });
  function object(id, type, x, y, extra = {}) {
    world.roomObjects[id] = { _id: id, type, room: 'W1N1', x, y, ...extra };
  }
  object('controller', 'controller', 13, 12, {
    user: 'u1',
    level: 8,
    progress: 0,
    downgradeTime: 50000,
    safeMode: null,
    safeModeAvailable: 1,
    safeModeCooldown: null,
    isPowerEnabled: true,
  });
  object('spawn', 'spawn', 12, 13, {
    name: 'Spawn1',
    user: 'u1',
    store: { energy: 300 },
    storeCapacityResource: { energy: 300 },
    hits: 5000,
    hitsMax: 5000,
    spawning: null,
  });
  const body = ['work', 'carry', 'move', 'attack', 'ranged_attack', 'heal', 'claim'].map(
    (type) => ({ type, hits: 100 }),
  );
  for (const [id, extra] of Object.entries({
    worker: {},
    hostile: { user: 'u2' },
    tired: { fatigue: 5 },
    spawning: { spawning: true },
    noMove: { body: [{ type: 'carry', hits: 100 }] },
    empty: { store: { energy: 0 } },
    broken: { body: body.map((part) => ({ ...part, hits: 0 })) },
  })) {
    object(id, 'creep', 11, 11, {
      name: id,
      user: 'u1',
      body: structuredClone(body),
      store: { energy: 20, H: 5 },
      storeCapacity: 50,
      hits: 650,
      hitsMax: 700,
      fatigue: 0,
      ageTime: 1601,
      spawning: false,
      notifyWhenAttacked: true,
      actionLog: {},
      ...extra,
    });
  }
  object('source', 'source', 10, 10, {
    energy: 3000,
    energyCapacity: 3000,
    nextRegenerationTime: null,
  });
  object('drySource', 'source', 40, 40, {
    energy: 0,
    energyCapacity: 3000,
    nextRegenerationTime: 140,
  });
  object('mineral', 'mineral', 10, 11, { mineralType: 'H', mineralAmount: 1000, density: 2 });
  object('deposit', 'deposit', 10, 12, {
    depositType: 'metal',
    harvested: 10,
    cooldownTime: 120,
    decayTime: 10000,
  });
  object('drop', 'energy', 11, 10, { resourceType: 'energy', energy: 40 });
  object('container', 'container', 12, 11, {
    store: { energy: 100, H: 10 },
    storeCapacity: 2000,
    hits: 200000,
    hitsMax: 250000,
    nextDecayTime: 200,
  });
  object('tower', 'tower', 12, 12, {
    user: 'u1',
    store: { energy: 700 },
    storeCapacityResource: { energy: 1000 },
    hits: 3000,
    hitsMax: 3000,
  });
  object('link', 'link', 13, 11, {
    user: 'u1',
    store: { energy: 300 },
    storeCapacityResource: { energy: 800 },
    hits: 1000,
    hitsMax: 1000,
    cooldown: 0,
  });
  object('link2', 'link', 14, 11, {
    user: 'u1',
    store: { energy: 0 },
    storeCapacityResource: { energy: 800 },
    hits: 1000,
    hitsMax: 1000,
    cooldown: 0,
  });
  object('lab', 'lab', 13, 13, {
    user: 'u1',
    store: { energy: 1000, H: 200 },
    storeCapacityResource: { energy: 2000, H: 3000 },
    hits: 500,
    hitsMax: 500,
    cooldown: 0,
  });
  object('terminal', 'terminal', 14, 13, {
    user: 'u1',
    store: { energy: 10000, H: 200 },
    storeCapacity: 300000,
    hits: 3000,
    hitsMax: 3000,
    cooldownTime: 0,
  });
  object('site', 'constructionSite', 11, 12, {
    user: 'u1',
    structureType: 'road',
    progress: 10,
    progressTotal: 300,
  });
  object('road', 'road', 12, 10, { hits: 4000, hitsMax: 5000, nextDecayTime: 150 });
  object('tombstone', 'tombstone', 9, 11, {
    user: 'u2',
    store: { energy: 12 },
    deathTime: 90,
    decayTime: 200,
    creepId: 'dead',
    creepName: 'dead',
    creepBody: ['carry'],
    creepTicksToLive: 15,
  });
  object('ruin', 'ruin', 9, 12, {
    store: { energy: 15 },
    destroyTime: 95,
    decayTime: 300,
    structure: { id: 'old', type: 'spawn', hits: 0, user: 'u2' },
  });
  object('u2controller', 'controller', 25, 25, {
    user: 'u2',
    level: 1,
    downgradeTime: 50000,
    safeMode: null,
  });
  world.roomObjects.u2controller.room = 'W2N1';
  world.userPowerCreeps.pc = {
    _id: 'pc',
    user: 'u1',
    name: 'Operator',
    className: 'operator',
    level: 1,
    hitsMax: 1000,
    store: {},
    storeCapacity: 100,
    spawnCooldownTime: null,
    shard: null,
    powers: { 1: { level: 1 } },
  };
  world.marketOrders.order = {
    _id: 'order',
    user: 'u2',
    active: true,
    type: 'sell',
    amount: 100,
    remainingAmount: 100,
    totalAmount: 100,
    resourceType: 'H',
    price: 2000,
    roomName: 'W2N1',
    created: 1,
  };
  world.marketStats.stat = {
    _id: 'stat',
    resourceType: 'H',
    date: '2023-11-14',
    transactions: 1,
    volume: 100,
    avgPrice: 2,
    stddevPrice: 0,
  };
  world.transactions.tx = {
    _id: 'tx',
    time: 100,
    sender: 'u2',
    recipient: 'u1',
    resourceType: 'H',
    amount: 5,
    from: 'W2N1',
    to: 'W1N1',
    description: 'fixture',
  };
  return world;
}
