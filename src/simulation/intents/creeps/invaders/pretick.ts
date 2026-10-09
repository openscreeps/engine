/*
 * Port of screeps/engine `processor/intents/creeps/invaders/pretick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../../constants.ts';
import { hasActiveBodyparts, IntentList } from '../../../npc/fake-runtime.ts';
import type { ObjectIntentSet, RoomScope } from '../../../scope.ts';
import type { RoomObject } from '../../../state.ts';
import { findAttack } from './find-attack.ts';
import { healer } from './healer.ts';
import { shootAtWill } from './shoot-at-will.ts';

export interface InvaderContext {
  scope: RoomScope;
  intents: IntentList;
  roomObjects: Record<string, RoomObject>;
  creeps: RoomObject[];
  invaders: RoomObject[];
  healers: RoomObject[];
  hostiles: RoomObject[];
  defenders: RoomObject[];
  fortifications: RoomObject[];
}

/** Invader creep AI. */
export function invaderPretick(
  creep: RoomObject,
  scope: RoomScope,
): Record<string, ObjectIntentSet> {
  const { roomObjects } = scope;

  const intents = new IntentList();

  const creeps: RoomObject[] = [];
  const invaders: RoomObject[] = [];
  const healers: RoomObject[] = [];
  const hostiles: RoomObject[] = [];
  const defenders: RoomObject[] = [];
  const fortifications: RoomObject[] = [];
  for (const key of Object.keys(roomObjects)) {
    const object = roomObjects[key] as RoomObject;
    if ((!object.spawning && object.type === 'creep') || object.type === 'powerCreep') {
      creeps.push(object);
      if ((creep.user ?? null) === (object.user ?? null)) {
        invaders.push(object);
        if (hasActiveBodyparts(object, C.HEAL)) {
          healers.push(object);
        }
      } else if (object.user !== '3') {
        hostiles.push(object);
        if (
          (object.body ?? []).some(
            (i) => (i.hits > 0 && i.type === C.ATTACK) || i.type === C.RANGED_ATTACK,
          )
        ) {
          defenders.push(object);
        }
      }
    }
    if (object.type === C.STRUCTURE_RAMPART || object.type === C.STRUCTURE_WALL) {
      fortifications.push(object);
    }
  }

  const context: InvaderContext = {
    scope,
    intents,
    roomObjects,
    creeps,
    invaders,
    healers,
    hostiles,
    defenders,
    fortifications,
  };

  if ((creep.body ?? []).some((p) => p.type === C.HEAL)) {
    healer(creep, context);
  } else {
    findAttack(creep, context);
  }

  shootAtWill(creep, context);

  return intents.list;
}
