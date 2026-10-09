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
