import assert from 'node:assert/strict';
import { it } from 'node:test';
import { BotRuntime } from '../src/index.ts';
import { harvestingWorld } from './fixtures/world.ts';

void it('refreshes edited terrain without a global reset and removes retired player state', async () => {
  const world = harvestingWorld();
  using runtime = new BotRuntime();
  const code = {
    main: `module.exports.loop = () => {
      global.turns = (global.turns || 0) + 1;
      Memory.turns = global.turns;
      Memory.terrain = Game.map.getRoomTerrain('W1N1').get(5, 5);
    };`,
  };
  runtime.setCode('u1', code);
  runtime.setSegment('u1', 5, 'retired data');
  await runtime.runTick(world);
  assert.deepEqual(JSON.parse(runtime.getMemory('u1')), { turns: 1, terrain: 0 });
  const terrain = world.terrain.W1N1;
  assert.ok(terrain);
  world.terrain.W1N1 = `${terrain.slice(0, 255)}1${terrain.slice(256)}`;
  world.gameTime++;
  runtime.refreshTerrain();
  const changed = await runtime.runTick(world);
  assert.equal(changed.users.u1?.reset, false);
  assert.deepEqual(JSON.parse(runtime.getMemory('u1')), { turns: 2, terrain: 1 });

  runtime.removeUser('u1');
  assert.equal(runtime.snapshot().users.u1, undefined);
  runtime.setCode('u1', code);
  world.gameTime++;
  const replacement = await runtime.runTick(world);
  assert.equal(replacement.users.u1?.reset, true);
  assert.deepEqual(JSON.parse(runtime.getMemory('u1')), { turns: 1, terrain: 1 });
  assert.equal(runtime.getSegment('u1', 5), undefined);
});

void it('rebuilds player PathFinder, exit and removed-room terrain caches on terrain updates', async () => {
  const world = harvestingWorld();
  world.terrain.W2N1 = '0'.repeat(2500);
  using runtime = new BotRuntime();
  runtime.setCode('u1', {
    main: `module.exports.loop = () => {
      global.turns = (global.turns || 0) + 1;
      const attempt = (fn) => { try { return fn(); } catch (e) { return e.message; } };
      Memory.turns = global.turns;
      Memory.tile = Game.map.getRoomTerrain('W1N1').get(12, 11);
      Memory.incomplete = PathFinder.search(
        new RoomPosition(11, 11, 'W1N1'), new RoomPosition(14, 11, 'W1N1'), { maxRooms: 1 },
      ).incomplete;
      Memory.exits = Object.keys(Game.map.describeExits('W1N1')).join();
      Memory.removedTile = attempt(() => Game.map.getRoomTerrain('W2N1').get(12, 11));
      Memory.removedPath = attempt(() => PathFinder.search(
        new RoomPosition(11, 11, 'W2N1'), new RoomPosition(14, 11, 'W2N1'), { maxRooms: 1 },
      ).incomplete);
    };`,
  });
  await runtime.runTick(world);
  assert.deepEqual(JSON.parse(runtime.getMemory('u1')), {
    turns: 1,
    tile: 0,
    incomplete: false,
    exits: '1,3,5,7',
    removedTile: 0,
    removedPath: false,
  });

  // Wall the left border and column 12: (11,11) can no longer reach (14,11) inside W1N1.
  world.terrain.W1N1 = Array.from({ length: 2500 }, (_, i) =>
    i % 50 === 0 || i % 50 === 12 ? '1' : '0',
  ).join('');
  world.gameTime++;
  runtime.refreshTerrain();
  const edited = await runtime.runTick(world);
  assert.equal(edited.users.u1?.reset, false);
  assert.deepEqual(JSON.parse(runtime.getMemory('u1')), {
    turns: 2,
    tile: 1,
    incomplete: true,
    exits: '1,3,5',
    removedTile: 0,
    removedPath: false,
  });

  // A removed room changes the room set, which reloads terrain without `refreshTerrain`.
  Reflect.deleteProperty(world.terrain, 'W2N1');
  world.gameTime++;
  const removed = await runtime.runTick(world);
  assert.equal(removed.users.u1?.reset, false);
  assert.deepEqual(JSON.parse(runtime.getMemory('u1')), {
    turns: 3,
    tile: 1,
    incomplete: true,
    exits: '1,3,5',
    removedTile: 'Could not access room W2N1',
    removedPath: 'Could not load terrain data',
  });
});

function twoPlayerWorld() {
  const world = harvestingWorld();
  const user = world.users.u1;
  const spawn = world.roomObjects.spawn1;
  assert.ok(user);
  assert.ok(spawn);
  world.users.u2 = { ...user, _id: 'u2', username: 'bob', usernameLower: 'bob' };
  world.roomObjects.spawn2 = { ...spawn, _id: 'spawn2', user: 'u2', name: 'Spawn2' };
  return world;
}

const terrainCode = {
  main: `module.exports.loop = () => {
    global.turns = (global.turns || 0) + 1;
    Memory.turns = global.turns;
    Memory.tiles = ['W1N1', 'W2N1', 'W3N1'].map(room => {
      try { return Game.map.getRoomTerrain(room).get(5, 5); }
      catch (error) { return error.message; }
    });
    console.log(JSON.stringify(Memory));
  };`,
};

void it('updates shared terrain for every player after room additions, removals and refresh', async () => {
  const world = twoPlayerWorld();
  using runtime = new BotRuntime();
  runtime.setCode('u1', terrainCode);
  runtime.setCode('u2', terrainCode);
  const check = async (turns: number, tiles: (number | string)[]) => {
    const tick = await runtime.runTick(world);
    assert.deepEqual(Object.keys(tick.users), ['u1', 'u2']);
    for (const id of ['u1', 'u2']) {
      assert.equal(tick.users[id]?.console.error, undefined);
      assert.equal(tick.users[id]?.reset, turns === 1);
      assert.deepEqual(JSON.parse(runtime.getMemory(id)), { turns, tiles });
    }
    world.gameTime++;
  };
  await check(1, [0, 'Could not access room W2N1', 'Could not access room W3N1']);
  world.terrain.W2N1 = '2'.repeat(2500);
  await check(2, [0, 2, 'Could not access room W3N1']);
  Reflect.deleteProperty(world.terrain, 'W2N1');
  await check(3, [0, 'Could not access room W2N1', 'Could not access room W3N1']);
  world.terrain.W1N1 = '1'.repeat(2500);
  runtime.refreshTerrain();
  await check(4, [1, 'Could not access room W2N1', 'Could not access room W3N1']);
  const standalone = await runtime.runUser(world, 'u2');
  assert.equal(standalone?.console.error, undefined);
  assert.equal(standalone?.reset, false);
  assert.deepEqual(JSON.parse(runtime.getMemory('u2')), {
    turns: 5,
    tiles: [1, 'Could not access room W2N1', 'Could not access room W3N1'],
  });
});

void it('prepares a queued player against terrain edited during its preceding standalone run', async () => {
  const world = twoPlayerWorld();
  let edited = false;
  using runtime = new BotRuntime({
    playerSandbox: (_sandbox, id) => {
      if (id === 'u1' && !edited) {
        edited = true;
        world.terrain.W2N1 = '2'.repeat(2500);
      }
    },
  });
  runtime.setCode('u1', terrainCode);
  runtime.setCode('u2', terrainCode);
  const standalone = runtime.runUser(world, 'u1');
  const tick = runtime.runTick(world);
  const first = await standalone;
  const queued = await tick;
  assert.equal(first?.console.error, undefined);
  assert.equal(queued.users.u1?.console.error, undefined);
  assert.equal(queued.users.u1?.reset, false);
  assert.deepEqual(JSON.parse(runtime.getMemory('u1')), {
    turns: 2,
    tiles: [0, 2, 'Could not access room W3N1'],
  });
  assert.deepEqual(JSON.parse(runtime.getMemory('u2')), {
    turns: 1,
    tiles: [0, 'Could not access room W2N1', 'Could not access room W3N1'],
  });
});

void it('prepares terrain after an asynchronous getAllUsers hook, including terrain refresh', async () => {
  const world = twoPlayerWorld();
  const selection = Promise.withResolvers<readonly string[]>();
  let deferSelection = false;
  using runtime = new BotRuntime({
    getAllUsers: (eligible) =>
      deferSelection ? selection.promise : eligible.map((user) => user._id),
  });
  runtime.setCode('u1', terrainCode);
  runtime.setCode('u2', terrainCode);
  await runtime.runTick(world);
  deferSelection = true;
  const pending = runtime.runTick(world);
  world.terrain.W1N1 = '1'.repeat(2500);
  world.terrain.W2N1 = '2'.repeat(2500);
  runtime.refreshTerrain();
  selection.resolve(['u1', 'u2']);
  const tick = await pending;
  for (const id of ['u1', 'u2']) {
    assert.equal(tick.users[id]?.console.error, undefined);
    assert.equal(tick.users[id]?.reset, false);
    assert.deepEqual(JSON.parse(runtime.getMemory(id)), {
      turns: 2,
      tiles: [1, 2, 'Could not access room W3N1'],
    });
  }
});

void it('keeps terrain for concurrent ticks of different worlds isolated across user queues', async () => {
  const firstWorld = twoPlayerWorld();
  const nextWorld = twoPlayerWorld();
  nextWorld.terrain.W3N1 = '2'.repeat(2500);
  nextWorld.terrain.W2N1 = '1'.repeat(2500);
  using runtime = new BotRuntime();
  runtime.setCode('u1', terrainCode);
  runtime.setCode('u2', terrainCode);
  const first = runtime.runTick(firstWorld);
  const next = runtime.runTick(nextWorld);
  const firstTick = await first;
  const nextTick = await next;
  for (const id of ['u1', 'u2']) {
    assert.equal(firstTick.users[id]?.console.error, undefined);
    assert.equal(nextTick.users[id]?.console.error, undefined);
    assert.equal(firstTick.users[id]?.reset, true);
    assert.equal(nextTick.users[id]?.reset, false);
    const firstLog = firstTick.users[id].console.log[0];
    const nextLog = nextTick.users[id].console.log[0];
    assert.ok(firstLog);
    assert.ok(nextLog);
    assert.deepEqual(JSON.parse(firstLog.message), {
      turns: 1,
      tiles: [0, 'Could not access room W2N1', 'Could not access room W3N1'],
    });
    assert.deepEqual(JSON.parse(nextLog.message), { turns: 2, tiles: [0, 1, 2] });
    assert.deepEqual(JSON.parse(runtime.getMemory(id)), { turns: 2, tiles: [0, 1, 2] });
  }
});

void it('does not capture terrain for a tick whose getAllUsers hook excludes every player', async () => {
  const world = twoPlayerWorld();
  let excluded = true;
  using runtime = new BotRuntime({
    getAllUsers: (eligible) => (excluded ? [] : eligible.map((user) => user._id)),
  });
  runtime.setCode('u1', terrainCode);
  runtime.setCode('u2', terrainCode);
  assert.deepEqual(await runtime.runTick(world), { intents: {}, users: {} });
  world.terrain.W1N1 = '1'.repeat(2500);
  excluded = false;
  const tick = await runtime.runTick(world);
  for (const id of ['u1', 'u2']) {
    assert.equal(tick.users[id]?.console.error, undefined);
    assert.deepEqual(JSON.parse(runtime.getMemory(id)), {
      turns: 1,
      tiles: [1, 'Could not access room W2N1', 'Could not access room W3N1'],
    });
  }
});

void it('leaves terrain unprepared when every eligible player skips an empty CPU bucket', async () => {
  const world = twoPlayerWorld();
  for (const user of Object.values(world.users)) user.cpuAvailable = -100;
  using runtime = new BotRuntime();
  runtime.setCode('u1', terrainCode);
  runtime.setCode('u2', terrainCode);
  const skipped = await runtime.runTick(world);
  for (const id of ['u1', 'u2']) {
    assert.equal(
      skipped.users[id]?.console.error,
      'Script execution has been terminated: CPU bucket is empty',
    );
    assert.equal(runtime.getMemory(id), '');
  }
  world.terrain.W1N1 = '1'.repeat(2500);
  const tick = await runtime.runTick(world);
  for (const id of ['u1', 'u2']) {
    assert.equal(tick.users[id]?.console.error, undefined);
    assert.equal(tick.users[id]?.reset, true);
    assert.deepEqual(JSON.parse(runtime.getMemory(id)), {
      turns: 1,
      tiles: [1, 'Could not access room W2N1', 'Could not access room W3N1'],
    });
  }
});

void it('reports a terrain preparation failure per player and lets other real isolates run', async () => {
  const world = twoPlayerWorld();
  let unavailable = true;
  Object.defineProperty(world.terrain, 'W2N1', {
    enumerable: true,
    get() {
      if (unavailable) {
        unavailable = false;
        throw new Error('Terrain temporarily unavailable');
      }
      return '2'.repeat(2500);
    },
  });
  using runtime = new BotRuntime();
  runtime.setCode('u1', terrainCode);
  runtime.setCode('u2', terrainCode);
  const tick = await runtime.runTick(world);
  assert.match(tick.users.u1?.console.error ?? '', /Terrain temporarily unavailable/);
  assert.equal(tick.users.u2?.console.error, undefined);
  assert.deepEqual(JSON.parse(runtime.getMemory('u2')), {
    turns: 1,
    tiles: [0, 2, 'Could not access room W3N1'],
  });
  const recovered = await runtime.runUser(world, 'u1');
  assert.equal(recovered?.console.error, undefined);
  assert.equal(recovered?.reset, true);
  assert.deepEqual(JSON.parse(runtime.getMemory('u1')), {
    turns: 1,
    tiles: [0, 2, 'Could not access room W3N1'],
  });
});
