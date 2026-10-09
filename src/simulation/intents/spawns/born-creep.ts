/*
 * Port of screeps/engine `processor/intents/spawns/_born-creep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { checkTerrain, getOffsetsByDirection } from '../../../utils/index.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { contains } from '../../support.ts';
import { creepDie } from '../creeps/die.ts';

const ALL_DIRECTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Places a finished creep next to its spawn (or invader core); spawn-stomps a hostile when boxed in. */
export function bornCreep(
  spawn: RoomObject,
  creep: RoomObject | undefined,
  scope: RoomScope,
): boolean {
  const { roomObjects, roomTerrain, bulk, movement } = scope;

  // left undefined when no direction is tried (empty `directions`), like upstream
  let newX: number | undefined;
  let newY: number | undefined;
  let isOccupied = false;
  let hostileOccupied: RoomObject | undefined;
  const isObstacle = (i: RoomObject): boolean =>
    i.x === newX &&
    i.y === newY &&
    (contains(C.OBSTACLE_OBJECT_TYPES, i.type) ||
      (i.type === 'constructionSite' && contains(C.OBSTACLE_OBJECT_TYPES, i.structureType)));
  const objects = (): RoomObject[] => Object.values(roomObjects);

  let directions = ALL_DIRECTIONS;
  if (spawn.spawning && typeof spawn.spawning === 'object' && spawn.spawning.directions) {
    directions = spawn.spawning.directions;
  }
  const otherDirections = ALL_DIRECTIONS.filter((d) => !directions.includes(d));

  for (const direction of directions) {
    const [dx, dy] = getOffsetsByDirection(direction) as readonly [number, number];
    newX = spawn.x + dx;
    newY = spawn.y + dy;
    isOccupied =
      objects().some(isObstacle) ||
      movement.isTileBusy(newX, newY) ||
      (checkTerrain(roomTerrain, newX, newY, C.TERRAIN_MASK_WALL) &&
        !objects().some((i) => i.type === 'road' && i.x === newX && i.y === newY));

    if (!isOccupied) {
      break;
    }

    if (!hostileOccupied) {
      hostileOccupied = objects().find(
        (i) => i.x === newX && i.y === newY && i.type === 'creep' && i.user !== spawn.user,
      );
    }
  }

  if (!isOccupied) {
    bulk.update(creep, { x: newX, y: newY, spawning: false });
    return true;
  }

  if (hostileOccupied) {
    for (const direction of otherDirections) {
      const [dx, dy] = getOffsetsByDirection(direction) as readonly [number, number];
      newX = spawn.x + dx;
      newY = spawn.y + dy;
      isOccupied =
        objects().some(isObstacle) ||
        checkTerrain(roomTerrain, newX, newY, C.TERRAIN_MASK_WALL) ||
        movement.isTileBusy(newX, newY);
      if (!isOccupied) {
        return false;
      }
    }

    creepDie(hostileOccupied, undefined, true, scope);
    bulk.update(creep, { x: hostileOccupied.x, y: hostileOccupied.y, spawning: false });
    return true;
  }

  return false;
}
