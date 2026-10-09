/*
 * Port of screeps/engine `processor/intents/extensions/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';

export function tickExtension(object: RoomObject, scope: RoomScope): void {
  const { bulk, roomController } = scope;

  if (object.type != 'extension') return;

  if (roomController) {
    const storeCapacity = lookup<number>(C.EXTENSION_ENERGY_CAPACITY, roomController.level) || 0;
    if (
      !object.storeCapacityResource ||
      !object.storeCapacityResource.energy ||
      storeCapacity != object.storeCapacityResource.energy
    ) {
      bulk.update(object, { storeCapacityResource: { energy: storeCapacity } });
    }
  }
}
