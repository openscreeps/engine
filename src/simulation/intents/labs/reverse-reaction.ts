/*
 * Port of screeps/engine `processor/intents/labs/reverse-reaction.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { getReactionVariants } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject, Store, StoreCapacityResource } from '../../state.ts';
import { lookup, powerEffect, effectList } from '../../support.ts';

function labMineralType(store: Store | undefined): string | undefined {
  if (!store) return undefined;
  return Object.keys(store).find((k) => k != C.RESOURCE_ENERGY && store[k]);
}

export function labReverseReaction(
  object: RoomObject,
  intent: IntentArgs<'reverseReaction'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, gameTime } = scope;

  if (object.type != 'lab' || (!!object.cooldownTime && object.cooldownTime > gameTime)) {
    return;
  }

  if (intent.lab1 == intent.lab2) {
    return;
  }

  let reactionAmount: number = C.LAB_REACTION_AMOUNT;
  const effect = effectList(object.effects).find((e) => e.power === C.PWR_OPERATE_LAB);
  if (effect && effect.endTime > gameTime) {
    reactionAmount += powerEffect(C.PWR_OPERATE_LAB, effect.level);
  }

  const store = object.store as Store;
  const mineralType = labMineralType(object.store) as string;
  if ((store[mineralType] || 0) < reactionAmount) {
    return;
  }

  // Upstream reads `lab1.store` before checking `lab1` exists (throws on a missing lab).
  const lab1 = roomObjects[String(intent.lab1)];
  const lab1MineralType = labMineralType((lab1 as RoomObject).store);
  if (
    !lab1 ||
    lab1.type != 'lab' ||
    (!!lab1MineralType &&
      ((lab1.store as Store)[lab1MineralType] as number) + reactionAmount >
        ((lab1.storeCapacityResource as StoreCapacityResource)[lab1MineralType] as number))
  ) {
    return;
  }

  const lab2 = roomObjects[String(intent.lab2)];
  const lab2MineralType = labMineralType((lab2 as RoomObject).store);
  if (
    !lab2 ||
    lab2.type != 'lab' ||
    (!!lab2MineralType &&
      ((lab2.store as Store)[lab2MineralType] as number) + reactionAmount >
        ((lab2.storeCapacityResource as StoreCapacityResource)[lab2MineralType] as number))
  ) {
    return;
  }

  const variants = getReactionVariants(mineralType);
  const variant = variants.find(
    (v) =>
      (!lab1MineralType || lab1MineralType == v[0]) &&
      (!lab2MineralType || lab2MineralType == v[1]),
  );
  if (!variant) {
    return;
  }

  const reactionTime = lookup<number>(C.REACTION_TIME, mineralType) as number;
  store[mineralType] = (store[mineralType] as number) - reactionAmount;
  if (store[mineralType]) {
    bulk.update(object, {
      store: { [mineralType]: store[mineralType] },
      cooldownTime: gameTime + reactionTime,
    });
  } else {
    bulk.update(object, {
      store: { [mineralType]: store[mineralType] },
      storeCapacityResource: { [mineralType]: null },
      storeCapacity: C.LAB_ENERGY_CAPACITY + C.LAB_MINERAL_CAPACITY,
      cooldownTime: gameTime + reactionTime,
    });
  }

  const [r1, r2] = variant;
  const lab1Store = lab1.store as Store;
  if ((lab1.storeCapacityResource as StoreCapacityResource)[r1]) {
    bulk.update(lab1, {
      store: { [r1]: (lab1Store[r1] || 0) + reactionAmount },
    });
  } else {
    bulk.update(lab1, {
      store: { [r1]: (lab1Store[r1] || 0) + reactionAmount },
      storeCapacityResource: { [r1]: C.LAB_MINERAL_CAPACITY },
      storeCapacity: null,
    });
  }

  const lab2Store = lab2.store as Store;
  if ((lab2.storeCapacityResource as StoreCapacityResource)[r2]) {
    bulk.update(lab2, {
      store: { [r2]: (lab2Store[r2] || 0) + reactionAmount },
    });
  } else {
    bulk.update(lab2, {
      store: { [r2]: (lab2Store[r2] || 0) + reactionAmount },
      storeCapacityResource: { [r2]: C.LAB_MINERAL_CAPACITY },
      storeCapacity: null,
    });
  }

  (object.actionLog as ActionLog).reverseReaction = {
    x1: lab1.x,
    y1: lab1.y,
    x2: lab2.x,
    y2: lab2.y,
  };
}
