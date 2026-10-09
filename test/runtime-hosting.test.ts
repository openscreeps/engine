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
