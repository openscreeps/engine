/*
 * Port of screeps/engine `processor/intents/invader-core/stronghold/defence.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../../constants.ts';
import { dist } from '../../../../utils/index.ts';
import { CostMatrix, lodashMax } from '../../../npc/fake-runtime.ts';
import type { RoomObject } from '../../../state.ts';
import { contains } from '../../../support.ts';
import type { StrongholdContext } from './stronghold.ts';

/** Cost matrix callback allowing movement over own ramparts only; undefined when no hostiles. */
export function createSafeMatrixCallback(
  context: StrongholdContext,
): ((room: string) => CostMatrix) | undefined {
  const { hostiles, ramparts, roomObjects } = context;

  if (hostiles.length === 0) {
    return undefined;
  }

  return function safeMatrixCallback(): CostMatrix {
    const matrix = new CostMatrix();
    for (let i = 0; i < 50; i++) for (let j = 0; j < 50; j++) matrix.set(i, j, Infinity);

    for (const rampart of ramparts) {
      matrix.set(rampart.x, rampart.y, 1);
    }

    for (const key of Object.keys(roomObjects)) {
      const object = roomObjects[key] as RoomObject;
      if (object.type !== 'creep' && contains(C.OBSTACLE_OBJECT_TYPES, object.type)) {
        matrix.set(object.x, object.y, Infinity);
      }
    }

    return matrix;
  };
}

/** Spreads agents over positions; result maps `50*x+y` to the agent. */
export function distribute<T>(
  positions: readonly RoomObject[],
  agentsArg: readonly T[],
): Record<string, T> {
  if (agentsArg.length === 0) {
    return {};
  }
  let agents = agentsArg.slice();
  if (agents.length > positions.length) {
    agents = agents.slice(0, positions.length);
  }

  const result: Record<string, T> = {};
  const weights = positions.map((p) => ({ pos: p, weight: 100 }));
  while (agents.length > 0) {
    const creep = agents.shift() as T;
    const place = lodashMax(weights, (w) => w.weight) as { pos: RoomObject; weight: number };
    const index = weights.indexOf(place);
    if (index >= 0) {
      weights.splice(index, 1);
    }
    result[50 * place.pos.x + place.pos.y] = creep;
    for (const w of weights) {
      w.weight -= Math.max(0, weights.length - dist(w.pos, place.pos));
    }
  }
  return result;
}
