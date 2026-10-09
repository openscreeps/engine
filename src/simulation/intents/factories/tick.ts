/*
 * Port of screeps/engine `processor/intents/factories/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { isEqual, lookup } from '../../support.ts';

export function tickFactory(object: RoomObject, scope: RoomScope): void {
  const { roomController, bulk } = scope;
  if (roomController) {
    const storeCapacity =
      (roomController.level as number) > 0 &&
      roomController.user == object.user &&
      lookup<number>(C.CONTROLLER_STRUCTURES.factory, roomController.level)
        ? C.FACTORY_CAPACITY
        : 0;
    if (storeCapacity != object.storeCapacity) {
      bulk.update(object, { storeCapacity });
    }
  }

  if (!isEqual(object._actionLog, object.actionLog)) {
    bulk.update(object, {
      actionLog: object.actionLog,
    });
  }
}
