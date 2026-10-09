/*
 * Port of screeps/engine `processor/intents/roads/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { checkTerrain } from '../../../utils/index.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

export function tickRoad(object: RoomObject, scope: RoomScope): void {
  const { roomObjects, roomTerrain, bulk, gameTime } = scope;

  if (object.type != 'road') return;

  if (!object.nextDecayTime || gameTime >= object.nextDecayTime - 1) {
    let decayAmount: number = C.ROAD_DECAY_AMOUNT;
    if (
      Object.values(roomObjects).some(
        (i) => i.x == object.x && i.y == object.y && i.type == 'swamp',
      ) ||
      checkTerrain(roomTerrain, object.x, object.y, C.TERRAIN_MASK_SWAMP)
    ) {
      decayAmount *= C.CONSTRUCTION_COST_ROAD_SWAMP_RATIO;
    }
    if (
      Object.values(roomObjects).some(
        (i) => i.x == object.x && i.y == object.y && i.type == 'wall',
      ) ||
      checkTerrain(roomTerrain, object.x, object.y, C.TERRAIN_MASK_WALL)
    ) {
      decayAmount *= C.CONSTRUCTION_COST_ROAD_WALL_RATIO;
    }
    object.hits = (object.hits as number) - decayAmount;
    if (object.hits <= 0) {
      bulk.remove(object._id);
      Reflect.deleteProperty(roomObjects, object._id);
    } else {
      object.nextDecayTime = gameTime + C.ROAD_DECAY_TIME;
      bulk.update(object, {
        hits: object.hits,
        nextDecayTime: object.nextDecayTime,
      });
    }
  }
}
