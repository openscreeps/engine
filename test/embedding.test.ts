import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Engine } from '../src/index.ts';
import { harvestingWorld } from './fixtures/world.ts';

const harvesterCode = {
  main: `
    module.exports.loop = function () {
      Memory.loops = (Memory.loops || 0) + 1;
      const creep = Game.creeps.Harvester1;
      const source = Game.getObjectById('src1');
      const before = creep.store.energy;
      const result = creep.harvest(source);
      if (result !== OK) throw new Error('harvest failed: ' + result);
      if (creep.store.energy !== before) throw new Error('intent mutated the tick snapshot');
    };
  `,
};

void describe('embedded player execution and simulation', () => {
  void it('collects a real bot intent, resolves harvesting, and persists memory between ticks', async () => {
    using engine = new Engine(harvestingWorld());
    engine.setCode('u1', harvesterCode);
    const first = await engine.tick();
    assert.equal(first.runtime.users.u1?.console.error, undefined);
    let state = engine.snapshot().world;
    assert.equal(state.gameTime, 2);
    assert.equal(state.roomObjects.creep1?.store?.energy, 2);
    assert.equal(state.roomObjects.src1?.energy, 2998);
    assert.deepEqual(JSON.parse(engine.getMemory('u1')), { loops: 1 });
    await engine.tick();
    state = engine.snapshot().world;
    assert.equal(state.roomObjects.creep1?.store?.energy, 4);
    assert.equal(state.roomObjects.src1?.energy, 2996);
    assert.deepEqual(JSON.parse(engine.getMemory('u1')), { loops: 2 });
  });

  void it('restores code and memory into an independent world without sharing mutable state', async () => {
    using original = new Engine(harvestingWorld());
    original.setCode('u1', harvesterCode);
    await original.tick();
    const saved = original.snapshot();
    using restored = Engine.restore(saved);
    await restored.tick();
    assert.equal(restored.snapshot().world.roomObjects.creep1?.store?.energy, 4);
    assert.equal(original.snapshot().world.roomObjects.creep1?.store?.energy, 2);
    assert.equal(saved.world.roomObjects.creep1?.store?.energy, 2);
    assert.deepEqual(JSON.parse(restored.getMemory('u1')), { loops: 2 });
    assert.deepEqual(JSON.parse(original.getMemory('u1')), { loops: 1 });
  });

  void it('rejects overlapping ticks so a player cannot execute twice against one world snapshot', async () => {
    using engine = new Engine(harvestingWorld());
    engine.setCode('u1', harvesterCode);
    const pending = engine.tick();
    await assert.rejects(engine.tick(), /already running/);
    assert.throws(() => engine.snapshot(), /already running/);
    await pending;
    assert.equal(engine.snapshot().world.gameTime, 2);
  });
});
