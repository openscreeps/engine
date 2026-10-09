/*
 * Port of screeps/engine `processor/intents/_calc_spawns.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { comparatorDistance } from '../../utils/index.ts';
import type { RoomScope } from '../scope.ts';
import type { RoomObject } from '../state.ts';
import { lookup } from '../support.ts';

function updateOff(
  objects: RoomObject[],
  table: Readonly<Record<string, number>>,
  scope: RoomScope,
): void {
  const roomController = scope.roomController as RoomObject;
  const allowed = lookup<number>(table, (roomController.level as number) | 0) as number;
  let enabled = objects;

  if (enabled.length > allowed) {
    enabled.sort(comparatorDistance(roomController));
    enabled = enabled.slice(0, allowed);
    objects.forEach((i) => {
      i._off = !enabled.includes(i);
    });
  } else {
    objects.forEach((i) => {
      i._off = false;
    });
  }

  objects.forEach((i) => {
    if (i._off !== i.off) {
      scope.bulk.update(i._id, { off: i._off });
    }
  });
}

export function calcSpawns(
  roomSpawns: RoomObject[],
  roomExtensions: RoomObject[],
  scope: RoomScope,
): void {
  updateOff(roomSpawns, C.CONTROLLER_STRUCTURES.spawn, scope);
  updateOff(roomExtensions, C.CONTROLLER_STRUCTURES.extension, scope);
}
