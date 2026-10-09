/*
 * Ported from @screeps/engine src/utils.js.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import { toPropertyKey } from './js.ts';
import { collectionValues, isObject, shuffle, sum } from './lodash.ts';
import type { ResourceConstant } from '../types/index.ts';
import { getProp, ownValue, readProp } from './tables.ts';

type BoostTable = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>
>;
const boostTable: BoostTable = C.BOOSTS;

/** Body part entry as stored on creeps (`{type, hits, boost}`) or a bare part type. */
export interface BodyPartLike {
  readonly type: string;
  readonly hits?: number | undefined;
  readonly boost?: string | null | undefined;
  readonly _oldHits?: number | undefined;
}

/** Total spawn energy cost of a body; throws `Invalid body part X` for unknown parts. */
export function calcCreepCost(body: readonly (string | { readonly type: string })[]): number {
  let result = 0;
  for (const part of body) {
    const partType = isObject(part) ? part.type : part;
    const cost = ownValue(C.BODYPART_COST, partType);
    if (!cost) {
      throw new Error(`Invalid body part ${partType}`);
    }
    result += cost;
  }
  return result;
}

/**
 * Summed power of all active parts of `bodyPartType`, multiplied by their boost for `methodName`.
 * Parts with zero hits count while they still have `_oldHits` unless `withoutOldHits` is set.
 */
export function calcBodyEffectiveness(
  body: readonly BodyPartLike[],
  bodyPartType: string,
  methodName: string,
  basePower: number,
  withoutOldHits?: boolean,
): number {
  let power = 0;
  for (const part of body) {
    if (!(part.hits || (!withoutOldHits && part._oldHits)) || part.type !== bodyPartType) {
      continue;
    }
    let partPower = basePower;
    if (part.boost) {
      const partBoosts = ownValue(boostTable, bodyPartType);
      if (!partBoosts) {
        // Upstream dereferenced `BOOSTS[bodyPartType][boost]` unguarded.
        throw new TypeError(`Cannot read properties of undefined (reading '${part.boost}')`);
      }
      const boost = ownValue(partBoosts, part.boost);
      const multiplier = boost ? ownValue(boost, methodName) : undefined;
      if (multiplier) {
        partPower *= multiplier;
      }
    }
    power += partPower;
  }
  return power;
}

/** Total amount of all resources held by an object: its `store`, or (legacy) top-level resource amounts. */
export function calcResources(object: object): number {
  const store = readProp(object, 'store');
  if (store) {
    // lodash 3 `_.sum(store)`: array-likes by index (string code units included), objects by own values.
    return sum(collectionValues(store));
  }
  return sum(C.RESOURCES_ALL, (resource) => {
    const value = readProp(object, resource);
    if (typeof value === 'object') {
      if (value === null) {
        throw new TypeError(`Cannot read properties of null (reading 'amount')`);
      }
      return 'amount' in value ? value.amount : undefined;
    }
    return value || 0;
  });
}

export interface StoreCapacityLike {
  readonly storeCapacity?: number | null | undefined;
  readonly storeCapacityResource?:
    Readonly<Record<string, number | null | undefined>> | null | undefined;
}

/**
 * Capacity available for `resourceType`: its dedicated compartment when one exists, otherwise the
 * shared capacity minus all dedicated compartments.
 *
 * For a known resource constant the result is a number. For arbitrary player-supplied keys the
 * upstream expression `storeCapacityResource && storeCapacityResource[key] || ...` is reproduced
 * exactly, including inherited members (e.g. `'constructor'`), so the result is `unknown`.
 */
export function capacityForResource(
  object: StoreCapacityLike,
  resourceType: ResourceConstant,
): number;
export function capacityForResource(object: StoreCapacityLike, resourceType: unknown): unknown;
export function capacityForResource(object: StoreCapacityLike, resourceType: unknown): unknown {
  const compartments = object.storeCapacityResource;
  // Exactly `storeCapacityResource && storeCapacityResource[resourceType]`.
  const dedicated: unknown = compartments && getProp(compartments, toPropertyKey(resourceType));
  return (
    dedicated || Math.max(0, (object.storeCapacity || 0) - sum(collectionValues(compartments)))
  );
}

/** Terminal energy cost for sending `amount` over `range` rooms. */
export function calcTerminalEnergyCost(amount: number, range: number): number {
  return Math.ceil(amount * (1 - Math.exp(-range / 30)));
}

/** Total GCL progress needed to reach `gclLevel`. */
export function calcNeededGcl(gclLevel: number): number {
  return C.GCL_MULTIPLY * Math.pow(gclLevel - 1, C.GCL_POW);
}

/** product -> [reagent2, reagent1]; later REACTIONS entries overwrite earlier ones, as upstream's reduce. */
const reactionReagents: ReadonlyMap<string, readonly [string, string]> = (() => {
  const reagents = new Map<string, readonly [string, string]>();
  for (const [reagent1, products] of Object.entries(C.REACTIONS)) {
    for (const [reagent2, product] of Object.entries(products)) {
      reagents.set(product, [reagent2, reagent1]);
    }
  }
  return reagents;
})();

/** Total lab time to produce one batch of `mineral` from base minerals, summed over the reaction tree. */
export function calcTotalReactionsTime(mineral: string): number {
  const calcStep = (m: string): number => {
    const time = ownValue(C.REACTION_TIME, m);
    if (!time) {
      return 0;
    }
    const reagents = reactionReagents.get(m);
    if (!reagents) {
      // Upstream dereferenced `reagents[m][0]` unguarded.
      throw new TypeError(`Cannot read properties of undefined (reading '0')`);
    }
    return time + calcStep(reagents[0]) + calcStep(reagents[1]);
  };
  return calcStep(mineral);
}

/**
 * Randomly distributes `targetDensity` among resources weighted by their densities.
 * The last share intentionally divides by `densities[order.length - 1]` (upstream behaviour).
 */
export function calcReward(
  resourceDensities: Readonly<Record<string, number>>,
  targetDensity: number,
  itemsLimit?: number,
  random: () => number = Math.random,
): Record<string, number> {
  const resources: string[] = [];
  const densities: number[] = [];
  for (const [resource, density] of Object.entries(resourceDensities)) {
    resources.push(resource);
    densities.push(density);
  }

  let order = shuffle(
    resources.map((_resource, index) => index),
    random,
  );
  if (itemsLimit) {
    order = order.slice(0, itemsLimit);
  }
  const result: number[] = order.map((_index, i) => i);
  let currentDensity = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const density = densities[order[i] ?? -1] ?? NaN;
    const amount = Math.max(0, Math.round((random() * (targetDensity - currentDensity)) / density));
    result[i] = amount;
    currentDensity += amount * density;
  }
  if (order.length > 0) {
    result[order.length - 1] = Math.max(
      0,
      Math.round((targetDensity - currentDensity) / (densities[order.length - 1] ?? NaN)),
    );
  }

  const reward: Record<string, number> = {};
  order.forEach((resourceIndex, i) => {
    reward[resources[resourceIndex] ?? String(undefined)] = result[i] ?? NaN;
  });
  return reward;
}

/** All `[reagent1, reagent2]` pairs whose reaction yields `compound`. */
export function getReactionVariants(compound: string): [string, string][] {
  const result: [string, string][] = [];
  for (const [r1, products] of Object.entries(C.REACTIONS)) {
    for (const [r2, product] of Object.entries(products)) {
      if (product === compound) {
        result.push([r1, r2]);
      }
    }
  }
  return result;
}
