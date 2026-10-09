import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorldState, recordRoomObjectWrites, Simulation } from '../src/simulation/index.ts';
import type { WorldState } from '../src/simulation/index.ts';
import { storeIntents } from '../src/utils/system.ts';
import { harvestingWorld } from './fixtures/world.ts';

/** A simulation recording each tick's room order and per-room object order through the hook. */
function orderedSimulation(world: WorldState) {
  const order = new Map<string, string[]>();
  const simulation = new Simulation(world, {
    hooks: {
      processObject(object) {
        const room = object.room;
        order.set(room, [...(order.get(room) ?? []), object._id]);
      },
    },
  });
  return { simulation, order };
}

function twoRoomWorld(): WorldState {
  const world = harvestingWorld();
  const creep = world.roomObjects.creep1;
  assert.ok(creep);
  return createWorldState({
    gameTime: 1,
    terrain: { W1N1: '0'.repeat(2500), W2N1: '0'.repeat(2500) },
    rooms: { W1N1: { _id: 'W1N1', status: 'normal' }, W2N1: { _id: 'W2N1', status: 'normal' } },
    activeRooms: ['W1N1', 'W2N1'],
    users: world.users,
    roomObjects: {
      a: { ...structuredClone(creep), _id: 'a', name: 'A', x: 10 },
      b: { ...structuredClone(creep), _id: 'b', name: 'B', x: 20 },
      c: { ...structuredClone(creep), _id: 'c', name: 'C', room: 'W2N1' },
    },
  });
}

void describe('storage processing order', () => {
  void it('lets a newer rampart read the controller level before the same-tick downgrade', () => {
    const base = harvestingWorld();
    const controller = base.roomObjects.ctrl1;
    assert.ok(controller);
    const simulation = new Simulation(
      createWorldState({
        gameTime: 1000,
        terrain: { W4N4: '0'.repeat(2500) },
        rooms: { W4N4: { _id: 'W4N4', status: 'normal' } },
        activeRooms: ['W4N4'],
        users: base.users,
        roomObjects: {
          ctrl: { ...controller, _id: 'ctrl', room: 'W4N4', level: 2, downgradeTime: 1001 },
          wall: {
            _id: 'wall',
            type: 'rampart',
            room: 'W4N4',
            x: 10,
            y: 10,
            user: 'u1',
            hits: 50000,
            hitsMax: 300000,
            nextDecayTime: 1000000,
          },
        },
      }),
    );
    simulation.tick({});
    assert.equal(simulation.state.roomObjects.ctrl?.level, 1);
    assert.equal(simulation.state.roomObjects.wall?.hitsMax, 300000);
    simulation.tick({});
    assert.equal(simulation.state.roomObjects.wall.hitsMax, 0);
  });

  void it('pops rooms last-added first and keeps write order across snapshots and host edits', () => {
    const original = orderedSimulation(twoRoomWorld());
    original.simulation.tick({ u1: storeIntents({ a: { move: { direction: 3 } } }, () => 'W1N1') });
    assert.deepEqual([...original.order.keys()], ['W2N1', 'W1N1']);
    assert.deepEqual(original.order.get('W1N1'), ['b', 'a']);

    // Host edits between ticks: a removal, an unrecorded insert, then two recorded updates.
    const world = original.simulation.state as WorldState;
    delete world.roomObjects.c;
    const a = world.roomObjects.a;
    const b = world.roomObjects.b;
    assert.ok(a && b);
    world.roomObjects.d = { ...structuredClone(b), _id: 'd', name: 'D', x: 30 };
    b.x = 21;
    a.x = 12;
    recordRoomObjectWrites(world, ['b', 'a']);

    const restored = orderedSimulation(
      JSON.parse(JSON.stringify(original.simulation.snapshot())) as WorldState,
    );
    for (const run of [original, restored]) {
      run.order.clear();
      run.simulation.tick({});
    }
    assert.deepEqual(original.order.get('W1N1'), ['a', 'b', 'd']);
    assert.deepEqual(restored.order.get('W1N1'), original.order.get('W1N1'));
    assert.equal(original.order.has('W2N1'), false);
  });
});

void describe('world simulation', () => {
  void it('resolves simultaneous swaps rather than blocking both occupied destinations', () => {
    const world = harvestingWorld();
    const first = world.roomObjects.creep1;
    assert.ok(first);
    world.roomObjects.creep2 = {
      ...structuredClone(first),
      _id: 'creep2',
      name: 'Harvester2',
      y: 12,
    };
    const simulation = new Simulation(world);
    simulation.tick({
      u1: storeIntents(
        {
          creep1: { move: { direction: 5 } },
          creep2: { move: { direction: 1 } },
        },
        () => 'W1N1',
      ),
    });
    const result = simulation.snapshot();
    assert.equal(result.roomObjects.creep1?.y, 12);
    assert.equal(result.roomObjects.creep2?.y, 11);
    assert.equal(first.y, 11);
    assert.equal(world.roomObjects.creep2.y, 12);
  });

  void it('lets a fatigued creep recover without moving on that tick', () => {
    const world = harvestingWorld();
    const creep = world.roomObjects.creep1;
    assert.ok(creep);
    creep.fatigue = 1;
    const simulation = new Simulation(world);
    simulation.tick({ u1: storeIntents({ creep1: { move: { direction: 3 } } }, () => 'W1N1') });
    const result = simulation.snapshot().roomObjects.creep1;
    assert.ok(result);
    assert.equal(result.x, 11);
    assert.equal(result.y, 11);
    assert.equal(result.fatigue, 0);
  });
});
