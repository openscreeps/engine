import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { constants, createConstants, Engine, Simulation, worldConstants } from '../src/index.ts';
import { harvestingWorld } from './fixtures/world.ts';

/** The harvesting world with a creep that was just born (no `ageTime` yet). */
function newbornCreepWorld() {
  const world = harvestingWorld();
  const creep = world.roomObjects.creep1;
  assert.ok(creep);
  delete creep.ageTime;
  return world;
}

/** Upstream example mod `change-constant.js`, applied to one world's constants object. */
function changeConstantMod() {
  const config = { common: { constants: createConstants() } };
  // `config.common.constants.CREEP_LIFE_TIME = 300` (the typed defaults are literal types).
  Object.assign(config.common.constants, { CREEP_LIFE_TIME: 300 });
  Object.assign(config.common.constants.BODYPART_COST, { work: 150 });
  return config.common.constants;
}

const reportConstantsCode = {
  main: `
    module.exports.loop = function () {
      Memory.creepLifeTime = CREEP_LIFE_TIME;
      Memory.workCost = BODYPART_COST.work;
      Memory.ticksToLive = Game.creeps.Harvester1.ticksToLive;
    };
  `,
};

void describe('per-world constants', () => {
  void it('creates detached copies and keeps the exported defaults unchanged', () => {
    const modded = changeConstantMod();
    assert.equal(modded.CREEP_LIFE_TIME, 300);
    assert.equal(createConstants().CREEP_LIFE_TIME, 1500);
    assert.equal(createConstants().BODYPART_COST.work, 100);
    assert.equal(constants.CREEP_LIFE_TIME, 1500);
    assert.equal(constants.BODYPART_COST.work, 100);
  });

  void it('applies a mod constant to gameplay of its own world only', () => {
    const moddedConstants = changeConstantMod();
    const modded = new Simulation(newbornCreepWorld(), { constants: moddedConstants });
    const standard = new Simulation(newbornCreepWorld());
    assert.equal(modded.constants, moddedConstants);
    assert.equal(worldConstants(modded.state), moddedConstants);
    assert.equal(worldConstants(standard.state).CREEP_LIFE_TIME, 1500);
    modded.tick({});
    standard.tick({});
    assert.equal(modded.state.roomObjects.creep1?.ageTime, 1 + 300);
    assert.equal(standard.state.roomObjects.creep1?.ageTime, 1 + 1500);
  });

  void it('exposes mod constants to player code while an independent world keeps defaults', async () => {
    using modded = new Engine(newbornCreepWorld(), { constants: changeConstantMod() });
    using standard = new Engine(newbornCreepWorld());
    modded.setCode('u1', reportConstantsCode);
    standard.setCode('u1', reportConstantsCode);
    const [moddedTick, standardTick] = await Promise.all([modded.tick(), standard.tick()]);
    assert.equal(moddedTick.runtime.users.u1?.console.error, undefined);
    assert.equal(standardTick.runtime.users.u1?.console.error, undefined);
    assert.equal(modded.snapshot().world.roomObjects.creep1?.ageTime, 1 + 300);
    assert.equal(standard.snapshot().world.roomObjects.creep1?.ageTime, 1 + 1500);
    // The second run sees the age the first tick assigned (`ticksToLive = ageTime - time`).
    await Promise.all([modded.tick(), standard.tick()]);
    assert.deepEqual(JSON.parse(modded.getMemory('u1')), {
      creepLifeTime: 300,
      workCost: 150,
      ticksToLive: 301 - 2,
    });
    assert.deepEqual(JSON.parse(standard.getMemory('u1')), {
      creepLifeTime: 1500,
      workCost: 100,
      ticksToLive: 1501 - 2,
    });
  });

  void it('rejects changed persisted identifiers instead of reinterpreting world data', () => {
    const renamed = Object.assign(createConstants(), { STRUCTURE_ROAD: 'path' });
    assert.throws(
      () => new Simulation(harvestingWorld(), { constants: renamed }),
      /Constant STRUCTURE_ROAD is a persisted identifier/,
    );
    const remasked = Object.assign(createConstants(), { TERRAIN_MASK_WALL: 4 });
    assert.throws(
      () => new Engine(harvestingWorld(), { constants: remasked }),
      /Constant TERRAIN_MASK_WALL is a persisted identifier/,
    );
  });
});
