/*
 * Port of screeps/engine `processor/intents/room/create-construction-site.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import {
  checkConstructionSite,
  checkControllerAvailability,
  checkTerrain,
} from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';

/** Per-room-objects counter replacing upstream's module-global `createdConstructionSiteCounter`. */
const createdCounters = new WeakMap<Record<string, RoomObject>, number>();

export function createConstructionSite(
  userId: string,
  intent: IntentArgs<'createConstructionSite'>,
  scope: RoomScope,
): void {
  const { roomObjects, roomTerrain, bulk, roomController, env } = scope;
  const x = intent.x as number;
  const y = intent.y as number;
  const structureType = intent.structureType as string;

  if (x <= 0 || x >= 49 || y <= 0 || y >= 49) {
    return;
  }

  let progressTotal = lookup<number>(C.CONSTRUCTION_COST, structureType);
  if (!progressTotal) {
    return;
  }

  if (/^(W|E)/.test(intent.roomName as string)) {
    if (
      roomController &&
      ((roomController.user && roomController.user != userId) ||
        (roomController.reservation && roomController.reservation.user != userId))
    ) {
      return;
    }

    if (!checkControllerAvailability(structureType, roomObjects, roomController)) {
      return;
    }
  }

  if (
    !checkConstructionSite(roomObjects, structureType, x, y) ||
    !checkConstructionSite(roomTerrain, structureType, x, y)
  ) {
    return;
  }

  if (structureType == 'road') {
    if (
      Object.values(roomObjects).some((i) => i.x === x && i.y === y && i.type === 'swamp') ||
      checkTerrain(roomTerrain, x, y, C.TERRAIN_MASK_SWAMP)
    ) {
      progressTotal *= C.CONSTRUCTION_COST_ROAD_SWAMP_RATIO;
    }
    if (
      Object.values(roomObjects).some((i) => i.x === x && i.y === y && i.type === 'wall') ||
      checkTerrain(roomTerrain, x, y, C.TERRAIN_MASK_WALL)
    ) {
      progressTotal *= C.CONSTRUCTION_COST_ROAD_WALL_RATIO;
    }
  }

  if (env.config.ptr) {
    progressTotal = 1;
  }

  if (intent.roomName == 'sim' && structureType == 'tower') {
    progressTotal = 100;
  }

  const obj: Omit<RoomObject, '_id'> = {
    structureType,
    x,
    y,
    type: 'constructionSite',
    room: intent.roomName as string,
    user: userId,
    progress: 0,
    progressTotal,
  };

  if (structureType == 'spawn') {
    obj.name = intent.name as string;
  }

  bulk.insert(obj);

  const counter = createdCounters.get(roomObjects) ?? 0;
  // Upstream keeps this placeholder without an `_id` (the inserted copy gets one on persist).
  roomObjects['_createdConstructionSite' + String(counter)] = obj as RoomObject;
  createdCounters.set(roomObjects, counter + 1);
}
