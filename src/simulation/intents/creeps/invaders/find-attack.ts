/*
 * Port of screeps/engine `processor/intents/creeps/invaders/findAttack.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../../constants.ts';
import { dist } from '../../../../utils/index.ts';
import {
  type CostMatrix,
  findClosestByPath,
  findPath,
  hasActiveBodyparts,
  moveTo,
  RoomPosition,
} from '../../../npc/fake-runtime.ts';
import type { RoomScope } from '../../../scope.ts';
import type { MemoryMove, RoomObject } from '../../../state.ts';
import { lookup } from '../../../support.ts';
import { flee } from './flee.ts';
import type { InvaderContext } from './pretick.ts';

function checkPath(pos1: RoomObject, pos2: RoomPosition, scope: RoomScope): boolean {
  const path = findPath(pos1, pos2, {}, scope).path;
  const last = path[path.length - 1];
  if (!last) {
    return false;
  }
  return last.x === pos2.x && last.y === pos2.y;
}

export function findAttack(creep: RoomObject, context: InvaderContext): void {
  const { scope, intents, healers, hostiles, fortifications } = context;
  const { roomObjects, roomController } = scope;

  const costCallbackIgnoreRamparts = (_roomName: string, cm: CostMatrix): void => {
    fortifications.forEach((i) => {
      cm.set(i.x, i.y, 0);
    });
  };

  const haveAttack = hasActiveBodyparts(creep, C.ATTACK);
  if (!haveAttack && hasActiveBodyparts(creep, C.RANGED_ATTACK) && flee(creep, 3, context)) {
    return;
  }

  let target: RoomObject | null | undefined = undefined;
  if ((creep.hits as number) < (creep.hitsMax as number) / 2 && healers.length > 0 && !haveAttack) {
    target = findClosestByPath(creep, healers, { ignoreRoads: true }, scope);
    if (target) {
      const direction = moveTo(creep, target, { maxRooms: 1, ignoreRoads: true }, scope);
      if (direction) {
        intents.set(creep._id, 'move', { direction });
      } else {
        target = null;
      }
    } else {
      target = null;
    }
  }

  if (haveAttack) {
    const nearCreep = hostiles.find((c) => dist(creep, c) <= 1);
    if (nearCreep) {
      intents.set(creep._id, 'attack', { id: nearCreep._id, x: nearCreep.x, y: nearCreep.y });
    }
  }

  if (!target) {
    target = findClosestByPath(creep, hostiles, { ignoreRoads: true, ignoreCreeps: true }, scope);
    if (target && (haveAttack || dist(creep, target) > 3)) {
      const direction = moveTo(
        creep,
        target,
        { maxRooms: 1, ignoreRoads: true, ignoreCreeps: true },
        scope,
      );
      if (direction) {
        intents.set(creep._id, 'move', { direction });
      }
    }
  }

  if (!target) {
    target = findClosestByPath(
      creep,
      hostiles,
      { maxRooms: 1, ignoreRoads: true, costCallback: costCallbackIgnoreRamparts },
      scope,
    );
    if (target && (haveAttack || dist(creep, target) > 3)) {
      const direction = moveTo(
        creep,
        target,
        { maxRooms: 1, ignoreRoads: true, costCallback: costCallbackIgnoreRamparts },
        scope,
      );
      if (direction) {
        intents.set(creep._id, 'move', { direction });
      }
    }
  }

  if (!target) {
    target = findClosestByPath(
      creep,
      hostiles,
      { ignoreDestructibleStructures: true, maxRooms: 1, ignoreRoads: true },
      scope,
    );
    if (target && (haveAttack || dist(creep, target) > 3)) {
      const direction = moveTo(
        creep,
        target,
        { ignoreDestructibleStructures: true, maxRooms: 1, ignoreRoads: true },
        scope,
      );
      if (direction) {
        intents.set(creep._id, 'move', { direction });
      }
    }
  }

  if (!target) {
    const unreachableSpawns = Object.values(roomObjects).filter(
      (o) => o.type === 'spawn' && !checkPath(creep, new RoomPosition(o.x, o.y, o.room), scope),
    );
    if (!unreachableSpawns.length && roomController && roomController.user) {
      intents.set(creep._id, 'suicide', {});
      return;
    }

    target = unreachableSpawns[0];
    if (target) {
      const direction = moveTo(
        creep,
        target,
        { ignoreDestructibleStructures: true, maxRooms: 1, ignoreRoads: true },
        scope,
      );
      if (direction) {
        intents.set(creep._id, 'move', { direction });
      }
    }
    return;
  }

  intents.set(creep._id, 'attack', { id: target._id, x: target.x, y: target.y });
  const move = creep.memory_move;
  if ((haveAttack || hasActiveBodyparts(creep, C.WORK)) && !!move && !!move.path) {
    const path = (move as MemoryMove & { path: string }).path;
    if (!path.length) {
      return;
    }

    const pos = RoomPosition.sUnpackLocal(path[0] as string, creep.room);
    const structures = Object.values(roomObjects).filter(
      (o) =>
        !!lookup(C.CONTROLLER_STRUCTURES, o.type) &&
        o.type !== 'spawn' &&
        o.x === pos.x &&
        o.y === pos.y,
    );
    const structure = structures[0];
    if (structure) {
      if (hasActiveBodyparts(creep, C.RANGED_ATTACK)) {
        intents.set(creep._id, 'rangedAttack', { id: structure._id });
      }
      if (hasActiveBodyparts(creep, C.WORK)) {
        intents.set(creep._id, 'dismantle', { id: structure._id });
      } else {
        intents.set(creep._id, 'attack', { id: structure._id, x: structure.x, y: structure.y });
      }
    }
  }
}
