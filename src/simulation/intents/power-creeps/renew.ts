/*
 * Port of screeps/engine `processor/intents/power-creeps/renew.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { checkStructureAgainstController, dist } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';

export function renew(object: RoomObject, intent: IntentArgs<'renew'>, scope: RoomScope): void {
  const { roomObjects, roomController, bulk, gameTime } = scope;
  const target = roomObjects[intent.id as string];
  if (!target || (target.type != 'powerBank' && target.type != 'powerSpawn')) {
    return;
  }
  if (dist(object, target) > 1) {
    return;
  }
  if (
    target.type == 'powerSpawn' &&
    !checkStructureAgainstController(target, roomObjects, roomController)
  ) {
    return;
  }
  bulk.update(object, { ageTime: gameTime + C.POWER_CREEP_LIFE_TIME });
  (object.actionLog as ActionLog).healed = { x: object.x, y: object.y };
}
