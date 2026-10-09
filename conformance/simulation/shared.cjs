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

/** Storage collection -> WorldState field. */
const COLLECTIONS = [
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
function mulberry32Next(holder) {
  holder.state = (holder.state + 0x6d2b79f5) >>> 0;
  let t = holder.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function createResolver({ roomObjects, marketOrders, userPowerCreeps }) {
  function resolveString(value) {
    if (typeof value !== 'string' || value[0] !== '@') return value;
    const [kind, ...parts] = value.slice(1).split(':');
    let found;
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
    return found ? String(found._id) : `unresolved:${value}`;
  }
  function resolve(value) {
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[resolveString(key)] = resolve(value[key]);
      return out;
    }
    return resolveString(value);
  }
  return resolve;
}

/** Wall clock shared by both sides: constant within a tick, advancing with game time. */
function clockAt(scenario, gameTime) {
  return scenario.clock.start + (gameTime - scenario.world.gameTime) * scenario.clock.step;
}
module.exports = { COLLECTIONS, createResolver, clockAt, mulberry32Next };
