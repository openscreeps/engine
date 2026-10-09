import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Simulation } from '../src/simulation/index.ts';
import { harvestingWorld } from './fixtures/world.ts';

void describe('world simulation', () => {
  void it('resolves simultaneous swaps rather than blocking both occupied destinations', () => {
    const world = harvestingWorld();
    const first = world.roomObjects.creep1;
    assert.ok(first);
    world.roomObjects.creep2 = {
      ...structuredClone(first), _id: 'creep2', name: 'Harvester2', y: 12,
    };
    const simulation = new Simulation(world);
    simulation.tick({
      u1: { rooms: { W1N1: {
        creep1: { move: { direction: 5 } },
        creep2: { move: { direction: 1 } },
      } } },
    });
    const result = simulation.snapshot();
    assert.equal(result.roomObjects.creep1?.y, 12);
    assert.equal(result.roomObjects.creep2?.y, 11);
    assert.equal(world.roomObjects.creep1.y, 11);
    assert.equal(world.roomObjects.creep2.y, 12);
  });

  void it('lets a fatigued creep recover without moving on that tick', () => {
    const world = harvestingWorld();
    const creep = world.roomObjects.creep1;
    assert.ok(creep);
    creep.fatigue = 1;
    const simulation = new Simulation(world);
    simulation.tick({ u1: { rooms: { W1N1: { creep1: { move: { direction: 3 } } } } } });
    const result = simulation.snapshot().roomObjects.creep1;
    assert.ok(result);
    assert.equal(result.x, 11);
    assert.equal(result.y, 11);
    assert.equal(result.fatigue, 0);
  });
});
