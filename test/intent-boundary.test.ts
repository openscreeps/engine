import assert from 'node:assert/strict';
import { it } from 'node:test';
import { storeIntents } from '../src/index.ts';

void it('stores hostile room and object keys as own data without changing host prototypes', () => {
  const prototypeRoom = Object.getOwnPropertyDescriptor(Object.prototype, 'room');
  const objectRoom = Object.getOwnPropertyDescriptor(Object, 'room');
  const intents = storeIntents(
    {
      room: {
        createFlag: [
          { roomName: '__proto__', name: 'flag', x: 1, y: 2, color: 1, secondaryColor: 2 },
        ],
      },
      ['__proto__']: { move: { direction: 3 } },
    },
    (id) => (id === '__proto__' ? 'constructor' : undefined),
  );

  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'room'), prototypeRoom);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object, 'room'), objectRoom);
  assert.equal(Object.getPrototypeOf(intents.rooms), Object.prototype);
  assert.ok(Object.hasOwn(intents.rooms, '__proto__'));
  assert.deepEqual(intents.rooms.__proto__?.room?.createFlag, [
    { roomName: '__proto__', name: 'flag', x: 1, y: 2, color: 1, secondaryColor: 2 },
  ]);
  const room = intents.rooms.constructor;
  assert.ok(room);
  assert.ok(Object.hasOwn(room, '__proto__'));
  assert.deepEqual(Reflect.get(room, '__proto__'), { move: { direction: 3, id: 'undefined' } });
});
