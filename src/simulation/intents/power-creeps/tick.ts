/*
 * Port of screeps/engine `processor/intents/power-creeps/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { getRoomNameFromXY, isAtEdge, roomNameToXY } from '../../../utils/index.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject, RoomPositionData } from '../../state.ts';
import { isEqual } from '../../support.ts';

export function tickPowerCreep(object: RoomObject, scope: RoomScope): void {
  const { roomObjects, bulk, eventLog } = scope;

  if (object.type != 'powerCreep') return;

  scope.movement.execute(object, scope);

  if (isAtEdge(object) && object.user != '2' && object.user != '3') {
    const [roomX, roomY] = roomNameToXY(object.room);
    let x = object.x;
    let y = object.y;
    let room = object.room;

    if (object.x == 0) {
      x = 49;
      room = getRoomNameFromXY(roomX - 1, roomY);
    } else if (object.y == 0) {
      y = 49;
      room = getRoomNameFromXY(roomX, roomY - 1);
    } else if (object.x == 49) {
      x = 0;
      room = getRoomNameFromXY(roomX + 1, roomY);
    } else if (object.y == 49) {
      y = 0;
      room = getRoomNameFromXY(roomX, roomY + 1);
    }

    bulk.update(object, { interRoom: { room, x, y } });

    eventLog.push({ event: C.EVENT_EXIT, objectId: object._id, data: { room, x, y } });
  }

  const portal = Object.values(roomObjects).find(
    (i) => i.type == 'portal' && i.x == object.x && i.y == object.y,
  );
  if (portal && !(portal.destination as RoomPositionData).shard) {
    bulk.update(object, { interRoom: portal.destination });
  }

  let hits = object.hits as number;

  if (object._damageToApply) {
    hits -= object._damageToApply;
    delete object._damageToApply;
  }

  if (object._healToApply) {
    hits += object._healToApply;
    delete object._healToApply;
  }

  if (hits > (object.hitsMax as number)) {
    hits = object.hitsMax as number;
  }

  if (hits != object.hits) {
    bulk.update(object, { hits });
  }

  if (!isEqual(object.actionLog, object._actionLog)) {
    bulk.update(object, { actionLog: object.actionLog });
  }
}
