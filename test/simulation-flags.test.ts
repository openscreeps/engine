import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createWorldState,
  Simulation,
  type FlagDoc,
  type ManualIntents,
  type SimulationHooks,
  type RoomScope,
} from '../src/simulation/index.ts';
import { readRoomJob } from '../src/simulation/room-job.ts';
import { ProcessorPool } from '../src/workers/processor-pool.ts';

const TARGET = 'W1N1';
const SOURCE = 'W2N1';

function flag(id: string, room = TARGET, name = id): FlagDoc {
  return { _id: id, user: 'u1', room, data: `${name}~1~2~10~10` };
}

function flagWorld(flags: Record<string, FlagDoc> = {}) {
  return createWorldState({
    gameTime: 1,
    terrain: { [TARGET]: '0'.repeat(2500), [SOURCE]: '0'.repeat(2500) },
    rooms: {
      [TARGET]: { _id: TARGET, status: 'normal' },
      [SOURCE]: { _id: SOURCE, status: 'normal' },
    },
    activeRooms: [TARGET, SOURCE],
    flags,
  });
}

function createFlagIntents(name: string, roomName = TARGET): ManualIntents[string] {
  return {
    u1: {
      room: { createFlag: [{ name, roomName, color: 1, secondaryColor: 2, x: 10, y: 10 }] },
    },
  };
}

void describe('room flag reads', () => {
  void it('sees an earlier room insert into a later room during the same tick', () => {
    const simulation = new Simulation(flagWorld());
    const result = simulation.tick(
      {},
      {
        [SOURCE]: createFlagIntents('same'),
        [TARGET]: createFlagIntents('same'),
      },
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.processedRooms, [SOURCE, TARGET]);
    const flags = Object.values(simulation.state.flags);
    assert.equal(flags.length, 1);
    assert.equal(flags[0]?.room, TARGET);
    assert.equal(flags[0].data, 'same~1~2~10~10');
  });

  void it('keeps numeric-key Object.values order and sees live data updates on repeated room reads', () => {
    const world = flagWorld({
      tail: flag('tail'),
      '10': flag('10'),
      '2': flag('2'),
      '01': flag('01'),
    });
    world.activeRooms = [TARGET, TARGET];
    const simulation = new Simulation(world);
    const result = simulation.tick({}, { [TARGET]: createFlagIntents('new') });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.processedRooms, [TARGET, TARGET]);
    assert.equal(simulation.state.flags['2']?.data, '2~1~2~10~10|new~1~2~10~10');
    for (const id of ['10', 'tail', '01']) {
      assert.equal(simulation.state.flags[id]?.data, `${id}~1~2~10~10`);
    }
    // Parsing during intent processing must not leak back into the persisted documents.
    const stored = simulation.state.flags['2'];
    assert.ok(stored);
    assert.equal(Object.hasOwn(stored, '_parsed'), false);
    assert.equal(Object.hasOwn(stored, '_modified'), false);
  });

  void it('sees same-tick bulk moves, removals, and numeric and reinserted keys in order', () => {
    const world = flagWorld({
      tail: flag('tail'),
      '10': flag('10'),
      '2': flag('2'),
      '01': flag('01'),
      movingAway: flag('movingAway'),
      gone: flag('gone'),
      incoming: flag('incoming', SOURCE),
    });
    const seen: string[][] = [];
    const simulation = new Simulation(world, {
      hooks: {
        processRoom(scope) {
          if (scope.roomName === SOURCE) {
            scope.bulkFlags.update('incoming', { room: TARGET, data: 'moved~1~2~10~10' });
            scope.bulkFlags.update('movingAway', { room: SOURCE });
            scope.bulkFlags.remove('gone');
            scope.bulkFlags.insert(flag('1'), '1');
            scope.bulkFlags.remove('tail');
            scope.bulkFlags.insert(flag('tail', TARGET, 'reinserted'), 'tail');
          } else {
            seen.push(scope.flags.map((item) => item._id as string));
            assert.equal(
              scope.flags.find((item) => item._id === 'incoming')?.data,
              'moved~1~2~10~10',
            );
            assert.equal(
              scope.flags.find((item) => item._id === 'tail')?.data,
              'reinserted~1~2~10~10',
            );
            const first = scope.flags[0];
            assert.ok(first);
            first.data = 'private working copy';
          }
        },
      },
    });
    assert.deepEqual(simulation.tick({}).errors, []);
    assert.deepEqual(seen, [['1', '2', '10', '01', 'incoming', 'tail']]);
    assert.equal(simulation.state.flags['1']?.data, '1~1~2~10~10');
    assert.equal(simulation.state.flags.movingAway?.room, SOURCE);
    assert.equal(Object.hasOwn(simulation.state.flags, 'gone'), false);
  });

  void it('sees arbitrary direct world mutations from mod hooks, even a self-removing hook', () => {
    const world = flagWorld({ gone: flag('gone'), incoming: flag('incoming', SOURCE) });
    const hooks: SimulationHooks = {
      processRoom(scope) {
        if (scope.roomName !== SOURCE) return;
        const incoming = world.flags.incoming;
        assert.ok(incoming);
        incoming.room = TARGET;
        delete world.flags.gone;
        world.flags['1'] = flag('1', TARGET, 'already');
        delete hooks.processRoom;
      },
    };
    const simulation = new Simulation(world, { stateOwnership: 'shared', hooks });
    const result = simulation.tick({}, { [TARGET]: createFlagIntents('already') });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(Object.keys(world.flags), ['1', 'incoming']);
    assert.equal(world.flags['1']?.data, 'already~1~2~10~10');
    assert.equal(world.flags.incoming?.room, TARGET);
  });

  void it('sees direct writes from inherited mod hooks', () => {
    const world = flagWorld();
    class Hooks {
      processRoom(scope: RoomScope): void {
        if (scope.roomName === SOURCE) {
          world.flags.inserted = flag('inserted', TARGET, 'already');
        }
      }
    }
    const simulation = new Simulation(world, { stateOwnership: 'shared', hooks: new Hooks() });
    const result = simulation.tick({}, { [TARGET]: createFlagIntents('already') });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(Object.keys(world.flags), ['inserted']);
    assert.equal(world.flags.inserted?.data, 'already~1~2~10~10');
  });

  void it('refreshes flag membership and values after direct host changes between ticks', () => {
    const world = flagWorld({ first: flag('first'), removed: flag('removed', SOURCE) });
    const simulation = new Simulation(world, { stateOwnership: 'shared' });
    assert.deepEqual(simulation.tick({}, { [TARGET]: createFlagIntents('tick1') }).errors, []);
    const first = world.flags.first;
    assert.ok(first);
    first.room = SOURCE;
    delete world.flags.removed;
    world.flags['2'] = flag('2');
    world.flags['1'] = flag('1', TARGET, 'host');
    const result = simulation.tick({}, { [TARGET]: createFlagIntents('tick2') });
    assert.deepEqual(result.errors, []);
    assert.equal(world.flags['1'].data, 'host~1~2~10~10|tick2~1~2~10~10');
    assert.equal(world.flags['2'].data, '2~1~2~10~10');
    assert.equal(first.data, 'first~1~2~10~10|tick1~1~2~10~10');

    world.flags = { replacement: flag('replacement') };
    assert.deepEqual(simulation.tick({}, { [TARGET]: createFlagIntents('tick3') }).errors, []);
    assert.equal(world.flags.replacement?.data, 'replacement~1~2~10~10|tick3~1~2~10~10');
  });

  void it('returns detached JSON clones for both indexed and direct room reads', () => {
    const original = {
      ...flag('json'),
      extra: { values: [Number.NaN, undefined, { value: 1 }], missing: undefined },
    };
    const world = flagWorld({ json: original });
    for (const roomFlags of [undefined, [original]]) {
      const job = readRoomJob(world, TARGET, undefined, undefined, roomFlags);
      assert.notEqual(typeof job, 'string');
      if (typeof job === 'string') throw new Error(job);
      assert.deepEqual(job.flags, [JSON.parse(JSON.stringify(original))]);
      const copy = job.flags[0];
      assert.ok(copy && 'extra' in copy);
      assert.notEqual(copy, original);
      assert.notEqual(copy.extra, original.extra);
      copy.data = 'changed';
      assert.equal(original.data, 'json~1~2~10~10');
    }
  });

  void it('keeps concurrent room flags at stage-start rather than seeing earlier room inserts', async () => {
    const processors = new ProcessorPool({ processes: 1 });
    try {
      const simulation = new Simulation(flagWorld(), { processors });
      const result = await simulation.tickAsync(
        {},
        {
          [SOURCE]: createFlagIntents('same'),
          [TARGET]: createFlagIntents('same'),
        },
      );
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.processedRooms, [SOURCE, TARGET]);
      assert.equal(Object.values(simulation.state.flags).length, 2);
      for (const item of Object.values(simulation.state.flags)) {
        assert.equal(item.room, TARGET);
        assert.equal(item.data, 'same~1~2~10~10');
      }
    } finally {
      await processors.close();
    }
  });
});

void describe('room queue membership', () => {
  void it('preserves initial duplicates and last-added order while deduplicating requested rooms', () => {
    const world = flagWorld();
    const third = 'W3N1';
    const fourth = 'W4N1';
    for (const room of [third, fourth]) {
      world.terrain[room] = '0'.repeat(2500);
      world.rooms[room] = { _id: room, status: 'normal' };
    }
    world.activeRooms = [TARGET, SOURCE, TARGET];
    const simulation = new Simulation(world);
    const result = simulation.tick(
      {
        u1: { rooms: { [TARGET]: {}, [third]: {} } },
        u2: { rooms: { [third]: {}, [SOURCE]: {} } },
      },
      { [third]: {}, [fourth]: {}, [TARGET]: {} },
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.processedRooms, [fourth, third, TARGET, SOURCE, TARGET]);
  });
});
