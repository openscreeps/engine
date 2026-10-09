/*
 * Port of screeps/engine `processor/intents/invader-core/create-creep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcBodyEffectiveness } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { BodyPart, RoomObject } from '../../state.ts';
import { contains, lookup } from '../../support.ts';

/** NPC-only `createCreep` payload: the core AI also passes `boosts`, which the player sanitizer drops. */
export type NpcCreateCreepArgs = IntentArgs<'createCreep'> & {
  boosts?: (string | undefined)[] | undefined;
};

export function invaderCoreCreateCreep(
  object: RoomObject | undefined,
  intent: NpcCreateCreepArgs,
  scope: RoomScope,
): void {
  if (!object || object.spawning || object.type !== 'invaderCore') return;

  if (!object.level || !lookup(C.INVADER_CORE_CREEP_SPAWN_TIME, object.level)) return;
  const spawnTime = lookup(C.INVADER_CORE_CREEP_SPAWN_TIME, object.level) as number;

  const { gameTime, bulk } = scope;

  const intentBody = (intent.body as string[]).slice(0, C.MAX_CREEP_SIZE);
  intent.body = intentBody as NonNullable<NpcCreateCreepArgs['body']>;
  const boosts = intent.boosts;

  const body: BodyPart[] = [];
  for (let i = 0; i < intentBody.length; i++) {
    const type = intentBody[i] as string;
    if (!contains(C.BODYPARTS_ALL, type)) {
      continue;
    }
    const boost = boosts?.[i];
    const partBoosts = lookup<Readonly<Record<string, unknown>>>(C.BOOSTS, type);
    if (boosts && boosts.length >= i && partBoosts && lookup(partBoosts, boost)) {
      body.push({
        type,
        hits: 100,
        boost: boost as string,
      });
    } else {
      body.push({
        type,
        hits: 100,
      });
    }
  }

  const storeCapacity = calcBodyEffectiveness(body, C.CARRY, 'capacity', C.CARRY_CAPACITY, true);

  const creep: Omit<RoomObject, '_id'> = {
    ...(object.strongholdId !== undefined ? { strongholdId: object.strongholdId } : {}),
    type: 'creep',
    name: intent.name as string,
    x: object.x,
    y: object.y,
    body,
    store: { energy: 0 },
    storeCapacity,
    room: object.room,
    user: object.user,
    hits: body.length * 100,
    hitsMax: body.length * 100,
    spawning: true,
    fatigue: 0,
    notifyWhenAttacked: false,
    ageTime: object.decayTime as number,
  };

  bulk.insert(creep);

  bulk.update(object, {
    spawning: {
      name: intent.name as string,
      needTime: spawnTime * body.length,
      spawnTime: gameTime + spawnTime * body.length,
    },
  });
}
