/*
 * Port of screeps/engine `processor/intents/structures/_destroy.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { effectList, lookup } from '../../support.ts';
import { destroyInvaderCore } from '../invader-core/destroy.ts';

/** Removes a structure, leaving a ruin with its store unless destroyed by a nuke. */
export function destroyStructure(object: RoomObject, scope: RoomScope, attackType?: number): void {
  const { gameTime, bulk, roomObjects } = scope;

  if (object.type === 'spawn' && object.spawning && typeof object.spawning === 'object') {
    const spawningName = object.spawning.name;
    const spawning = Object.values(roomObjects).find(
      (i) => i.user === object.user && i.name === spawningName,
    );
    if (spawning) {
      bulk.remove(spawning._id);
      Reflect.deleteProperty(roomObjects, spawning._id);
    }
  }

  if (object.type === 'invaderCore') {
    destroyInvaderCore(object, scope);
  }

  if (!attackType || attackType !== C.EVENT_ATTACK_TYPE_NUKE) {
    const ruin: RoomObject = {
      _id: '',
      type: 'ruin',
      room: object.room,
      x: object.x,
      y: object.y,
      structure: {
        id: object._id,
        type: object.type,
        hits: 0,
        hitsMax: object.hitsMax,
        user: object.user,
      },
      destroyTime: gameTime,
      decayTime: gameTime + (lookup<number>(C.RUIN_DECAY_STRUCTURES, object.type) || C.RUIN_DECAY),
    };
    if (object.user) {
      ruin.user = object.user;
    }
    ruin.store = object.store || {};

    if (object.effects) {
      const collapseEffect = effectList(object.effects).find(
        (e) => e.effect === C.EFFECT_COLLAPSE_TIMER,
      );
      if (collapseEffect) {
        ruin.decayTime = Math.max(ruin.decayTime as number, collapseEffect.endTime);
      }
    }

    bulk.insert(ruin);
  }

  bulk.remove(object._id);
  Reflect.deleteProperty(roomObjects, object._id);
}
