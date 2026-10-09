/*
 * Port of screeps/engine `processor/intents/factories/produce.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcResources, checkStructureAgainstController } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { lookup, sumValues, effectList } from '../../support.ts';

interface Commodity {
  readonly amount?: number;
  readonly cooldown: number;
  readonly level?: number;
  readonly components: Readonly<Record<string, number>>;
}

export function factoryProduce(
  object: RoomObject,
  intent: IntentArgs<'produce'>,
  scope: RoomScope,
): void {
  const { gameTime, roomObjects, roomController, bulk } = scope;
  const resourceType = intent.resourceType as string;
  const commodity = lookup<Commodity>(C.COMMODITIES, resourceType);

  if (!object.store || !commodity || (!!commodity.level && object.level != commodity.level)) {
    return;
  }
  const store = object.store;

  if (!!object.cooldownTime && object.cooldownTime > gameTime) {
    return;
  }

  if (!checkStructureAgainstController(object, roomObjects, roomController)) {
    return;
  }

  if (
    !!commodity.level &&
    (object.level as number) > 0 &&
    !effectList(object.effects).some(
      (e) =>
        e.power == C.PWR_OPERATE_FACTORY && e.level == commodity.level && e.endTime >= gameTime,
    )
  ) {
    return;
  }

  if (
    Object.keys(commodity.components).some(
      (p) => (store[p] || 0) < (commodity.components[p] as number),
    )
  ) {
    return;
  }

  const targetTotal = calcResources(object);
  const componentsTotal = sumValues(commodity.components);
  if (targetTotal - componentsTotal + (commodity.amount || 1) > (object.storeCapacity as number)) {
    return;
  }

  for (const part of Object.keys(commodity.components)) {
    store[part] = (store[part] as number) - (commodity.components[part] as number);
  }
  store[resourceType] = (store[resourceType] || 0) + (commodity.amount || 1);
  bulk.update(object, { store });

  (object.actionLog as ActionLog).produce = { x: object.x, y: object.y, resourceType };

  bulk.update(object, { cooldownTime: commodity.cooldown + gameTime });
}
