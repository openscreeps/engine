/*
 * Port of screeps/engine `processor/intents/creeps/claimController.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcNeededGcl } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject, UserDoc } from '../../state.ts';

export function creepClaimController(
  object: RoomObject,
  intent: IntentArgs<'claimController'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, bulkUsers, users } = scope;

  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target || target.type !== 'controller') {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }
  if (target.bindUser && object.user !== target.bindUser) {
    return;
  }
  if ((target.level as number) > 0) {
    return;
  }
  if ((object.body ?? []).filter((i) => i.hits > 0 && i.type === C.CLAIM).length === 0) {
    return;
  }
  if (target.reservation && target.reservation.user !== object.user) {
    return;
  }
  const user = users[object.user as string] as UserDoc;
  const claimedRooms = user.rooms ? user.rooms.length : 0;

  if (user.shardAccess === false) {
    return;
  }

  if ((user.gcl as number) < calcNeededGcl(claimedRooms + 1)) {
    return;
  }

  const level = 1;

  bulk.update(target, {
    user: object.user,
    level,
    progress: 0,
    downgradeTime: null,
    reservation: null,
  });

  // driver.addRoomToUser
  if (!user.rooms || !user.rooms.includes(object.room)) {
    bulkUsers.addToSet(user, 'rooms', object.room);
  }
}
