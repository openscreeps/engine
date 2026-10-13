'use strict';
/*
 * Helpers shared by the oracle child process (CommonJS) and the local runner/comparator (ESM).
 *
 * Scenario intents are authored once and resolved independently on the oracle and local side
 * against that side's own current state, so they can address documents whose ids are generated
 * during the run (spawned creeps, built structures, created orders).
 *
 *   '@name:<name>'                    room object with that `name` (creep, power creep, spawn)
 *   '@at:<type>:<x>:<y>'              first room object of `type` at x,y
 *   '@order:<user>:<type>:<resource>' first market order matching user/type/resourceType
 *   '@powerCreep:<name>'              account power creep (users.power_creeps) with that name
 *
 * Unresolvable placeholders become 'unresolved:<placeholder>', an id no document has.
 */

import type { MarketOrder, PowerCreepDoc, RoomObject } from '../../src/simulation/state.ts';
import type { Scenario } from './types.ts';
import type { CollectionField } from './upstream.ts';

/** Storage collection -> WorldState field. */
const COLLECTIONS: ReadonlyArray<readonly [string, CollectionField]> = [
  ['rooms', 'rooms'],
  ['rooms.objects', 'roomObjects'],
  ['rooms.flags', 'flags'],
  ['users', 'users'],
  ['users.power_creeps', 'userPowerCreeps'],
  ['market.orders', 'marketOrders'],
  ['transactions', 'transactions'],
  ['users.money', 'usersMoney'],
  ['users.resources', 'usersResources'],
  ['users.notifications', 'notifications'],
  ['market.stats', 'marketStats'],
];

/**
 * mulberry32, the generator behind the local `SeededRandom` (src/simulation/support.ts),
 * reimplemented here so the oracle's `Math.random` replays the same stream from `world.rngState`.
 */
function mulberry32Next(holder: { state: number }): number {
  holder.state = (holder.state + 0x6d2b79f5) >>> 0;
  let t = holder.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function createResolver({
  roomObjects,
  marketOrders,
  userPowerCreeps,
}: {
  roomObjects: RoomObject[];
  marketOrders: MarketOrder[];
  userPowerCreeps: PowerCreepDoc[];
}) {
  function resolveString(value: string): string {
    if (typeof value !== 'string' || value[0] !== '@') return value;
    const [kind, ...parts] = value.slice(1).split(':');
    let found: RoomObject | MarketOrder | PowerCreepDoc | undefined;
    if (kind === 'name') {
      found = roomObjects.find((o) => o.name === parts[0]);
    } else if (kind === 'at') {
      const [type, x, y] = parts;
      found = roomObjects.find((o) => o.type === type && o.x === Number(x) && o.y === Number(y));
    } else if (kind === 'order') {
      const [user, type, resourceType] = parts;
      found = marketOrders.find(
        (o) => o.user === user && o.type === type && o.resourceType === resourceType,
      );
    } else if (kind === 'powerCreep') {
      found = userPowerCreeps.find((o) => o.name === parts[0]);
    } else {
      throw new Error(`unknown intent placeholder ${value}`);
    }
    return found ? found._id : `unresolved:${value}`;
  }
  function resolve(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[resolveString(key)] = resolve(item);
      return out;
    }
    return typeof value === 'string' ? resolveString(value) : value;
  }
  return resolve;
}

/** Wall clock shared by both sides: constant within a tick, advancing with game time. */
function clockAt(
  scenario: { clock: Scenario['clock']; world: { gameTime: number } },
  gameTime: number,
): number {
  return scenario.clock.start + (gameTime - scenario.world.gameTime) * scenario.clock.step;
}
module.exports = { COLLECTIONS, createResolver, clockAt, mulberry32Next };
export type Shared = {
  COLLECTIONS: typeof COLLECTIONS;
  createResolver: typeof createResolver;
  clockAt: typeof clockAt;
  mulberry32Next: typeof mulberry32Next;
};
