/*
 * Port of screeps/engine `processor/intents/room/gen-energy.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { checkTerrain } from '../../../utils/index.ts';
import type { GenEnergyIntent, RoomScope } from '../../scope.ts';
import { contains } from '../../support.ts';

export function genEnergy(userId: string, intent: GenEnergyIntent, scope: RoomScope): void {
  const { roomObjects, roomTerrain, bulk, env } = scope;

  if (userId != '3') {
    return;
  }

  let x: number;
  let y: number;

  do {
    x = Math.floor(env.random() * 48) + 1;
    y = Math.floor(env.random() * 48) + 1;
  } while (
    Object.values(roomObjects).some(
      (i) => contains(C.OBSTACLE_OBJECT_TYPES, i.type) && i.x == x && i.y == y,
    ) ||
    checkTerrain(roomTerrain, x, y, C.TERRAIN_MASK_WALL)
  );

  bulk.insert({
    x,
    y,
    type: 'energy',
    energy: 300,
    room: intent.roomName as string,
  });
}
