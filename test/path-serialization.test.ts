import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deserializePath, roomNameToXY, serializePath } from '../src/utils/index.ts';

void describe('room coordinate boundary', () => {
  void it('keeps west/north zero adjacent to east/south zero rather than overlapping them', () => {
    assert.deepEqual(roomNameToXY('W0N0'), [-1, -1]);
    assert.deepEqual(roomNameToXY('E0S0'), [0, 0]);
    assert.deepEqual(roomNameToXY('W127S100'), [-128, 100]);
  });
});

void describe('serialized room paths', () => {
  void it('anchors the first destination without applying its direction twice', () => {
    const steps = [
      { x: 9, y: 8, dx: 1, dy: 0, direction: 3 },
      { x: 10, y: 7, dx: 1, dy: -1, direction: 2 },
      { x: 10, y: 6, dx: 0, dy: -1, direction: 1 },
    ];
    assert.equal(serializePath(steps), '0908321');
    assert.deepEqual(deserializePath('0908321'), steps);
  });

  void it('rejects an invalid movement direction instead of creating corrupted coordinates', () => {
    assert.throws(() => deserializePath('090839'));
  });

  void it('accepts String objects like lodash isString and rejects other non-strings', () => {
    assert.deepEqual(deserializePath(new String('0908321')), deserializePath('0908321'));
    assert.throws(() => deserializePath(['0908321']), /`path` is not a string/);
  });
});
