import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import {
  createWorldState,
  Simulation,
  type RoomObject,
  type TickIntents,
} from '../src/simulation/index.ts';
import type { StoredUserIntents } from '../src/utils/system.ts';

const { values } = parseArgs({
  options: {
    rooms: { type: 'string', default: '2500' },
    active: { type: 'string', default: '1000' },
    ticks: { type: 'string', default: '8' },
    warmup: { type: 'string', default: '2' },
    history: { type: 'boolean', default: false },
  },
});
function count(value: string, minimum: number): number {
  const result = Number(value);
  assert.ok(Number.isSafeInteger(result) && result >= minimum, `Invalid count: ${value}`);
  return result;
}
const rooms = count(values.rooms, 1);
const active = count(values.active, 1);
const ticks = count(values.ticks, 1);
const warmup = count(values.warmup, 0);
assert.ok(active <= rooms, '--active must not exceed --rooms');

// Synthetic mature colonies, not a captured production world. World generation, terrain setup,
// assertions and the final state hash are outside the timed region; no player scripts are run.
const world = createWorldState({ gameTime: 1, rngState: 1729 });
const intents: Record<string, StoredUserIntents> = {};
const userCount = Math.max(1, Math.floor(active / 2));
for (let i = 0; i < userCount; i++) {
  const id = `u${String(i)}`;
  world.users[id] = {
    _id: id,
    username: id,
    cpu: 100,
    cpuAvailable: 10000,
    gcl: 1000000,
    power: 0,
    money: 100000,
    rooms: [],
    active: 10000,
  };
  intents[id] = { rooms: {} };
}
for (let r = 0; r < rooms; r++) {
  const room = `E${String(r % 50)}S${String(Math.floor(r / 50))}`;
  world.rooms[room] = { _id: room, status: 'normal' };
  world.terrain[room] = '0'.repeat(2500);
  const user = `u${String(r % userCount)}`;
  let sequence = 0;
  const add = (type: string, x: number, y: number, data: Partial<RoomObject> = {}): string => {
    const id = `${String(r)}:${String(sequence++)}`;
    world.roomObjects[id] = { _id: id, type, room, x, y, ...data };
    return id;
  };
  add(
    'controller',
    25,
    25,
    r < active
      ? {
          user,
          level: 8,
          progress: 0,
          downgradeTime: 100000,
          safeMode: null,
          safeModeAvailable: 1,
          safeModeCooldown: null,
          isPowerEnabled: false,
        }
      : { level: 0 },
  );
  const source = add('source', 10, 10, {
    energy: 3000,
    energyCapacity: 3000,
    nextRegenerationTime: null,
  });
  add('source', 40, 40, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: null });
  if (r >= active) continue;
  world.activeRooms.push(room);
  world.users[user]?.rooms?.push(room);
  const player = intents[user];
  assert.ok(player);
  const objects: StoredUserIntents['rooms'][string] = {};
  player.rooms[room] = objects;
  const structure = (
    type: string,
    x: number,
    y: number,
    store: Record<string, number>,
    capacity: number,
    extra: Partial<RoomObject> = {},
  ): void => {
    add(type, x, y, { user, hits: 1000, hitsMax: 1000, store, storeCapacity: capacity, ...extra });
  };
  structure('spawn', 20, 20, { energy: 300 }, 300, {
    name: `Spawn${String(r)}`,
    spawning: null,
    storeCapacityResource: { energy: 300 },
    hits: 5000,
    hitsMax: 5000,
  });
  for (let i = 0; i < 60; i++) {
    structure('extension', 15 + (i % 10), 30 + Math.floor(i / 10), { energy: 50 }, 50, {
      storeCapacityResource: { energy: 50 },
    });
  }
  for (let i = 0; i < 20; i++) {
    add('road', 5 + i, 15, { hits: 5000, hitsMax: 5000, nextDecayTime: 3 + i });
  }
  for (let i = 0; i < 6; i++) {
    structure('tower', 30 + i, 20, { energy: 1000 }, 1000, {
      storeCapacityResource: { energy: 1000 },
    });
  }
  for (let i = 0; i < 10; i++) {
    structure('lab', 30 + i, 30, { energy: 1000 }, 3000, {
      storeCapacityResource: { energy: 2000 },
      cooldownTime: 0,
    });
  }
  structure('storage', 21, 20, { energy: 100000 }, 1000000);
  structure('terminal', 22, 20, { energy: 50000 }, 300000, { cooldownTime: 0 });
  structure('container', 10, 11, { energy: 1000 }, 2000, { nextDecayTime: 10 });
  for (let i = 0; i < 50; i++) {
    const worker = i < 4;
    const id = add(
      'creep',
      worker ? 9 + (i % 3) : 2 + (i % 20),
      worker ? 9 + Math.floor(i / 3) : 2 + Math.floor(i / 20),
      {
        name: `C${String(r)}_${String(i)}`,
        user,
        body: (worker ? ['work', 'carry', 'move'] : ['carry', 'move']).map((type) => ({
          type,
          hits: 100,
        })),
        store: { energy: 0 },
        storeCapacity: 50,
        hits: worker ? 300 : 200,
        hitsMax: worker ? 300 : 200,
        fatigue: 0,
        ageTime: 1501,
        spawning: false,
        notifyWhenAttacked: true,
        actionLog: {},
      },
    );
    objects[id] = worker
      ? { harvest: { id: source }, drop: { resourceType: 'energy', amount: 2 } }
      : { move: { direction: i % 2 ? 3 : 7, id: '' } };
  }
  for (let i = 0; i < 4; i++) {
    const id = `f${String(r)}:${String(i)}`;
    world.flags[id] = {
      _id: id,
      user: `u${String((r + i) % userCount)}`,
      room,
      data: `F${String(r)}_${String(i)}~1~2~25~25`,
    };
  }
}
const initialObjects = Object.keys(world.roomObjects).length;
const simulation = new Simulation(world, {
  stateOwnership: 'shared',
  now: () => 1700000000000,
  recordHistory: values.history,
});
const input: TickIntents = intents;
for (let i = 0; i < warmup; i++) assert.deepEqual(simulation.tick(input).errors, []);
const times: number[] = [];
let processedRooms = 0;
for (let i = 0; i < ticks; i++) {
  const start = performance.now();
  const result = simulation.tick(input);
  times.push(performance.now() - start);
  assert.deepEqual(result.errors, []);
  processedRooms += result.processedRooms.length;
}
assert.equal(world.gameTime, 1 + warmup + ticks);
const sorted = [...times].sort((a, b) => a - b);
const lower = sorted[Math.floor((ticks - 1) / 2)];
const upper = sorted[Math.floor(ticks / 2)];
assert.ok(lower !== undefined && upper !== undefined);
console.log(
  JSON.stringify(
    {
      rooms,
      active,
      users: userCount,
      initialObjects,
      flagDocuments: Object.keys(world.flags).length,
      warmup,
      ticks,
      history: values.history,
      processedRooms,
      meanMs: times.reduce((sum, time) => sum + time, 0) / ticks,
      medianMs: (lower + upper) / 2,
      timesMs: times,
      stateHash: createHash('sha256').update(JSON.stringify(world)).digest('hex'),
    },
    null,
    2,
  ),
);
