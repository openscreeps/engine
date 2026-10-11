/*
 * Port of screeps/engine `processor/intents/creeps/move.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { C } from '../../../constants.ts';
import { dist, getOffsetsByDirection } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { contains } from '../../support.ts';

export function creepMove(object: RoomObject, intent: IntentArgs<'move'>, scope: RoomScope): void {
  const { roomObjects, movement } = scope;

  if (object.spawning) {
    return;
  }

  object._oldFatigue = object.fatigue;

  let d: readonly [number, number] | undefined | null = null;
  if (intent.direction) {
    d = getOffsetsByDirection(intent.direction);
  }
  if (intent.id) {
    const creep = roomObjects[intent.id];
    if (creep && creep.type === 'creep' && dist(object, creep) === 1) {
      d = [creep.x - object.x, creep.y - object.y];
    }
  }

  if (!d) {
    return;
  }

  const [dx, dy] = d;

  if (object.x + dx < 0 || object.x + dx > 49 || object.y + dy < 0 || object.y + dy > 49) {
    return;
  }

  const x = object.x + dx;
  const y = object.y + dy;
  for (const id in roomObjects) {
    if (!Object.hasOwn(roomObjects, id)) continue;
    const target = roomObjects[id] as RoomObject;
    if (target.x !== x || target.y !== y) continue;
    if (
      (contains(C.OBSTACLE_OBJECT_TYPES, target.type) &&
        target.type !== 'creep' &&
        target.type !== 'powerCreep') ||
      (target.type === 'rampart' && !target.isPublic && object.user !== target.user) ||
      (object.type === 'powerCreep' && target.type === 'portal' && target.destination?.shard)
    ) {
      return;
    }
  }
  movement.add(object, dx, dy);
}
