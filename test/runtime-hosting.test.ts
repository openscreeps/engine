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
