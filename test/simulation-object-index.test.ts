import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createWorldState,
  recordRoomObjectWrite,
  recordRoomObjectWrites,
  Simulation,
  syncRoomObjectWriteOrder,
  type RoomObject,
  type SimulationHooks,
  type WorldState,
} from '../src/simulation/index.ts';
import { ProcessorPool } from '../src/workers/processor-pool.ts';

const TARGET = 'W1N1';
const SOURCE = 'W2N1';

/** Mod-defined objects have no built-in tick writes, making the write order observable unchanged. */
function object(id: string, room = TARGET): RoomObject {
  return { _id: id, type: 'custom', room, x: 10, y: 10, user: 'u1' };
}

function objectWorld(roomObjects: Record<string, RoomObject>): WorldState {
  return createWorldState({
    terrain: { [TARGET]: '0'.repeat(2500), [SOURCE]: '0'.repeat(2500) },
    rooms: {
      [TARGET]: { _id: TARGET, status: 'normal' },
      [SOURCE]: { _id: SOURCE, status: 'normal' },
    },
    activeRooms: [TARGET, SOURCE],
    users: { u1: { _id: 'u1' } },
    roomObjects,
  });
}

function orderedSimulation(world: WorldState) {
  const seen = new Map<string, string[]>();
  const simulation = new Simulation(world, {
    stateOwnership: 'shared',
    now: () => 1700000000000,
    hooks: {
      processObject(doc) {
        let ids = seen.get(doc.room);
        if (!ids) {
          ids = [];
          seen.set(doc.room, ids);
        }
        ids.push(doc._id);
      },
    },
  });
  return { simulation, seen };
}

void describe('room object enumeration reuse', () => {
  for (const reuseKeys of [false, true]) {
    void it(`keeps own enumerable key order and sequence cleanup with reused keys=${String(reuseKeys)}`, () => {
      const world = objectWorld({
        tail: object('tail'),
        '10': object('10'),
        '2': object('2'),
        '01': object('01'),
        keep: object('keep'),
      });
      const seqs = { keep: 7, removed: 8 };
      world.roomObjectWriteSeq = seqs;
      world.writeSeq = 8;
      Object.setPrototypeOf(world.roomObjects, { inherited: object('inherited') });
      Object.setPrototypeOf(seqs, { inherited: 99 });
      Object.defineProperty(world.roomObjects, 'hidden', { value: object('hidden') });
      Object.defineProperty(seqs, 'hiddenSequence', { value: 100 });

      const result = reuseKeys
        ? syncRoomObjectWriteOrder(world, Object.keys(world.roomObjects))
        : syncRoomObjectWriteOrder(world);
      assert.equal(result, seqs);
      assert.deepEqual(Object.entries(result), [
        ['2', 9],
        ['10', 10],
        ['keep', 7],
        ['tail', 11],
        ['01', 12],
      ]);
      assert.equal(world.writeSeq, 12);
      assert.equal(Object.hasOwn(result, 'removed'), false);
      assert.equal(Object.hasOwn(result, 'inherited'), false);
      assert.equal(Object.hasOwn(result, 'hidden'), false);
      // The original reconciliation only enumerated sequence entries, too.
      assert.equal(Object.getOwnPropertyDescriptor(result, 'hiddenSequence')?.value, 100);
    });
  }

  void it('preserves partial batch failures and discovers new objects before the next single write', () => {
    const world = objectWorld({ a: object('a'), b: object('b') });
    world.roomObjectWriteSeq = { a: 5, removed: 4 };
    world.writeSeq = 5;
    assert.throws(() => {
      recordRoomObjectWrites(world, ['a', 'missing', 'b']);
    }, /room object missing does not exist/);
    assert.deepEqual(world.roomObjectWriteSeq, { a: 7, b: 6 });
    assert.equal(world.writeSeq, 7);

    delete world.roomObjects.a;
    world.roomObjects.c = object('c');
    recordRoomObjectWrite(world, 'b');
    assert.deepEqual(world.roomObjectWriteSeq, { b: 9, c: 8 });
    assert.equal(world.writeSeq, 9);
    assert.throws(() => {
      recordRoomObjectWrite(world, 'a');
    }, /room object a does not exist/);
    assert.equal(world.writeSeq, 9);
  });

  void it('rebuilds after host removals, insertions, room moves, collection replacement, and reset', () => {
    const world = objectWorld({
      tail: object('tail'),
      older: object('older'),
      newer: object('newer'),
      moving: object('moving', SOURCE),
      gone: object('gone'),
    });
    const live = orderedSimulation(world);
    assert.deepEqual(live.simulation.tick({}).errors, []);
    assert.deepEqual(live.seen.get(TARGET), ['gone', 'newer', 'older', 'tail']);

    delete world.roomObjects.gone;
    const moving = world.roomObjects.moving;
    assert.ok(moving);
    moving.room = TARGET;
    world.roomObjects.youngest = object('youngest');
    delete world.roomObjects.tail;
    world.roomObjects.tail = { ...object('tail'), x: 23 };
    recordRoomObjectWrites(world, ['moving', 'tail']);
    const restored = orderedSimulation(live.simulation.snapshot());
    for (const run of [live, restored]) {
      run.seen.clear();
      assert.deepEqual(run.simulation.tick({}).errors, []);
      assert.deepEqual(run.seen.get(TARGET), ['tail', 'moving', 'youngest', 'newer', 'older']);
      assert.equal(run.seen.has(SOURCE), false);
    }
    assert.deepEqual(live.simulation.snapshot(), restored.simulation.snapshot());

    world.roomObjects = { only: object('only', SOURCE) };
    world.activeRooms = [TARGET, SOURCE];
    live.seen.clear();
    assert.deepEqual(live.simulation.tick({}).errors, []);
    assert.deepEqual(live.seen.get(SOURCE), ['only']);
    assert.equal(live.seen.has(TARGET), false);
    assert.deepEqual(world.roomObjectWriteSeq, { only: 9 });

    world.roomObjects = { a: object('a'), b: object('b') };
    world.roomObjectWriteSeq = {};
    world.writeSeq = 0;
    world.activeRooms = [TARGET, SOURCE];
    live.seen.clear();
    assert.deepEqual(live.simulation.tick({}).errors, []);
    assert.deepEqual(live.seen.get(TARGET), ['b', 'a']);
    assert.deepEqual(world.roomObjectWriteSeq, { a: 1, b: 2 });
  });

  void it('keeps same-tick bulk insertions, removals, and room crossings visible to later rooms', () => {
    const world = objectWorld({
      tail: object('tail'),
      gone: object('gone'),
      away: object('away'),
      incoming: object('incoming', SOURCE),
    });
    const seen = new Map<string, string[]>();
    const simulation = new Simulation(world, {
      stateOwnership: 'shared',
      hooks: {
        processObject(doc) {
          seen.set(doc.room, [...(seen.get(doc.room) ?? []), doc.name ?? doc._id]);
        },
        processRoom(scope) {
          if (scope.roomName === SOURCE) {
            scope.bulk.remove('gone');
            scope.bulk.update('incoming', { room: TARGET });
            scope.bulk.update('away', { room: SOURCE });
            scope.bulk.insert({ ...object('new'), name: 'inserted' });
          }
        },
      },
    });
    const result = simulation.tick({});
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.processedRooms, [SOURCE, TARGET]);
    assert.deepEqual(seen.get(SOURCE), ['incoming']);
    assert.deepEqual(seen.get(TARGET), ['inserted', 'incoming', 'tail']);
    assert.equal(Object.hasOwn(world.roomObjectWriteSeq ?? {}, 'gone'), false);
    assert.equal(world.roomObjects.away?.room, SOURCE);
  });

  void it('still reads existing object edits and removals made by a sequential captured-world hook', () => {
    const world = objectWorld({
      target: object('target'),
      gone: object('gone'),
      source: object('source', SOURCE),
    });
    const targetReads: RoomObject[] = [];
    const hooks: SimulationHooks = {
      processObject(doc) {
        if (doc.room === TARGET) targetReads.push(doc);
      },
      processRoom(scope) {
        if (scope.roomName === SOURCE) {
          const target = world.roomObjects.target;
          assert.ok(target);
          target.x = 23;
          delete world.roomObjects.gone;
          delete hooks.processRoom;
        }
      },
    };
    const simulation = new Simulation(world, { stateOwnership: 'shared', hooks });
    assert.deepEqual(simulation.tick({}).errors, []);
    assert.deepEqual(
      targetReads.map((doc) => [doc._id, doc.x]),
      [['target', 23]],
    );
    assert.notEqual(targetReads[0], world.roomObjects.target);
  });

  void it('keeps global crossing enumeration and storage write order with integer-like ids', () => {
    const crossing = (id: string, destination: string): RoomObject => ({
      ...object(id),
      type: 'creep',
      interRoom: { room: destination, x: 20, y: 21 },
    });
    const world = objectWorld({
      tail: crossing('tail', TARGET),
      '10': crossing('10', SOURCE),
      '2': crossing('2', TARGET),
    });
    world.activeRooms = [];
    const simulation = new Simulation(world, { stateOwnership: 'shared' });
    const result = simulation.tick({});
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.processedRooms, []);
    assert.deepEqual(world.activeRooms, [TARGET, SOURCE]);
    assert.deepEqual(world.roomObjectWriteSeq, { '2': 4, '10': 5, tail: 6 });
    for (const id of ['2', '10', 'tail']) {
      assert.equal(world.roomObjects[id]?.interRoom, null);
      assert.equal(world.roomObjects[id].x, 20);
      assert.equal(world.roomObjects[id].y, 21);
    }
    assert.equal(world.roomObjects['10']?.room, SOURCE);
  });

  void it('shares concurrent read keys without committing temporary host-write order on rejection', async () => {
    const world = objectWorld({
      tail: object('tail'),
      '10': object('10'),
      '2': object('2', SOURCE),
    });
    world.roomObjectWriteSeq = { tail: 4, removed: 5 };
    world.writeSeq = 5;
    const reference = new Simulation(structuredClone(world), {
      recordHistory: true,
      now: () => 1700000000000,
    });
    const processors = new ProcessorPool({ processes: 1 });
    try {
      const simulation = new Simulation(world, {
        stateOwnership: 'shared',
        processors,
        recordHistory: true,
        now: () => 1700000000000,
      });
      assert.deepEqual(await simulation.tickAsync({}), reference.tick({}));
      assert.deepEqual(simulation.snapshot(), reference.snapshot());
      assert.deepEqual(world.roomObjectWriteSeq, { '2': 6, '10': 7, tail: 4 });

      world.roomObjects.newHostInsert = object('newHostInsert', SOURCE);
      const before = simulation.snapshot();
      await processors.close();
      await assert.rejects(simulation.tickAsync({}));
      assert.deepEqual(simulation.snapshot(), before);
      const recovered = simulation.tick({});
      assert.deepEqual(recovered.errors, []);
      assert.ok(recovered.history[SOURCE]?.newHostInsert);
    } finally {
      await processors.close();
    }
  });
});
