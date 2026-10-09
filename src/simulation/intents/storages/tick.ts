/*
 * Port of screeps/engine `processor/intents/storages/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup, powerEffect } from '../../support.ts';

export function tickStorage(object: RoomObject, scope: RoomScope): void {
  const { bulk, roomController, gameTime } = scope;
  if (roomController) {
    let storeCapacity =
      (roomController.level as number) > 0 &&
      roomController.user == object.user &&
      (lookup<number>(C.CONTROLLER_STRUCTURES.storage, roomController.level) as number) > 0
        ? C.STORAGE_CAPACITY
        : 0;
    if (storeCapacity > 0) {
      const effect = object.effects?.find((e) => e.power === C.PWR_OPERATE_STORAGE);
      if (effect && effect.endTime > gameTime) {
        storeCapacity += powerEffect(C.PWR_OPERATE_STORAGE, effect.level);
      }
    }
    if (storeCapacity != object.storeCapacity) {
      bulk.update(object, { storeCapacity });
    }
  }
}
