import assert from 'node:assert/strict';
import { it } from 'node:test';
import { PathFinder } from '../src/utils/pathfinder.ts';

void it('preserves native cross-room tie breaking and maxOps partial-path selection', () => {
  const rooms = [];
  for (const x of ['W0', 'E0', 'E1', 'E2']) {
    for (const y of ['N0', 'S0', 'S1']) {
      rooms.push({ room: x + y, terrain: '0'.repeat(2500) });
    }
  }
  const finder = new PathFinder(rooms);
  const origin = { x: 48, y: 25, roomName: 'E0S0' };
  const goal = { pos: { x: 2, y: 25, roomName: 'E1S0' }, range: 0 };
  const roomCallback = (room: string) => (room === 'E0S0' || room === 'E1S0' ? undefined : false);

  // Captured from driver cf63d8ad native PathFinder on Node 24.21.0.
  assert.deepEqual(finder.search(origin, goal, { maxRooms: 2, roomCallback }), {
    path: [
      { x: 49, y: 26, roomName: 'E0S0' },
      { x: 0, y: 26, roomName: 'E1S0' },
      { x: 1, y: 25, roomName: 'E1S0' },
      { x: 2, y: 25, roomName: 'E1S0' },
    ],
    ops: 4,
    cost: 4,
    incomplete: false,
  });
  assert.deepEqual(finder.search(origin, goal, { maxOps: 1, roomCallback }), {
    path: [{ x: 49, y: 26, roomName: 'E0S0' }],
    ops: 1,
    cost: 1,
    incomplete: true,
  });
});

void it('maps goal arrays like lodash 3 arrayMap, including holes', () => {
  const finder = new PathFinder([{ room: 'W1N0', terrain: '0'.repeat(2500) }]);
  const origin = { x: 25, y: 25, roomName: 'W1N0' };
  const target = { x: 30, y: 30, roomName: 'W1N0' };
  const reads: string[] = [];
  const goals = new Proxy([target, { pos: target, range: 1 }], {
    get(array, key, receiver) {
      reads.push(String(key));
      return Reflect.get(array, key, receiver) as unknown;
    },
    has(array, key) {
      reads.push(`has ${String(key)}`);
      return Reflect.has(array, key);
    },
  });

  // Captured from driver cf63d8ad lib/path-finder.js + native PathFinder on Node 24.21.0.
  finder.search(origin, goals);
  assert.deepEqual(reads, ['length', '0', '1']);
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => finder.search(origin, [, target]), {
    name: 'TypeError',
  });
});

void it('passes falsy non-function room callbacks through to the native call', () => {
  const finder = new PathFinder([{ room: 'W1N0', terrain: '0'.repeat(2500) }]);
  const origin = { x: 25, y: 25, roomName: 'W1N0' };
  const target = { x: 30, y: 30, roomName: 'W1N0' };

  // Captured from driver cf63d8ad native PathFinder on Node 24.21.0: only `undefined` disables the
  // callback natively, so other falsy values are called (V8 names upstream's `mod.search` call site).
  for (const roomCallback of [null, false, 0, '', NaN]) {
    assert.throws(() => finder.search(origin, target, { roomCallback }), {
      name: 'TypeError',
    });
    assert.deepEqual(finder.search(origin, origin, { roomCallback }), {
      path: [],
      ops: 0,
      cost: 0,
      incomplete: false,
    });
  }
  assert.equal(finder.search(origin, target, { roomCallback: 5 }).cost, 5);
});
