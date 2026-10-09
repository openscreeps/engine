/*
 * Port of screeps/engine `processor/intents/nukers/launch-nuke.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { checkStructureAgainstController, roomNameToXY } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject, Store, StoreCapacityResource } from '../../state.ts';

export function launchNuke(
  object: RoomObject,
  intent: IntentArgs<'launchNuke'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, gameTime, roomInfo, env } = scope;

  if (!checkStructureAgainstController(object, roomObjects, roomController)) {
    return;
  }
  const store = object.store as Store;
  const capacity = object.storeCapacityResource as StoreCapacityResource;
  if (
    (store.G as number) < (capacity.G as number) ||
    (store.energy as number) < (capacity.energy as number)
  ) {
    return;
  }
  if ((object.cooldownTime as number) > gameTime) {
    return;
  }
  const x = intent.x as number;
  const y = intent.y as number;
  if (x < 0 || y < 0 || x > 49 || y > 49) {
    return;
  }
  if (
    (roomInfo.novice && roomInfo.novice > env.now()) ||
    (roomInfo.respawnArea && roomInfo.respawnArea > env.now())
  ) {
    return;
  }

  const roomName = intent.roomName;
  if (typeof roomName !== 'string' || !/^(W|E)\d+(S|N)\d+$/.test(roomName)) {
    return;
  }

  const [tx, ty] = roomNameToXY(roomName);
  const [ox, oy] = roomNameToXY(object.room);

  if (Math.abs(tx - ox) > C.NUKE_RANGE || Math.abs(ty - oy) > C.NUKE_RANGE) {
    return;
  }

  bulk.update(object, {
    store: { energy: 0, G: 0 },
    cooldownTime: gameTime + (env.config.ptr ? 100 : C.NUKER_COOLDOWN),
  });

  bulk.insert({
    type: 'nuke',
    room: roomName,
    x,
    y,
    landTime: gameTime + (env.config.ptr ? 100 : C.NUKE_LAND_TIME),
    launchRoomName: object.room,
  });
}
