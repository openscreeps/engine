/*
 * PowerCreep (screeps/engine `src/game/power-creeps.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { checkStructureAgainstController } from '../../utils/index.ts';
import { jsGt, jsLt, jsString, jsSub, looseEquals } from '../../utils/js.ts';
import { collectionValues, isObject, isString, sum } from '../../utils/lodash.ts';
import { getProp } from '../../utils/tables.ts';
import { isArray, isBoolean, isUndefined, jsSetSloppy, sloppyThis } from './compat.ts';
import { Creep } from './creeps.ts';
import {
  defineGameObjectProperties,
  exposeGlobal,
  gameConstructor,
  type GameConstructor,
} from './define.ts';
import { RoomObject } from './room-object.ts';
import type { PowerCreepDoc, RawRoomObject } from './runtime-data.ts';
import { scope, username } from './scope.ts';
import type { SandboxGlobals } from './scope.ts';
import { Store } from './store.ts';
import { Structure, StructurePowerBank, StructurePowerSpawn } from './structures.ts';

/** Upstream `Object.assign({}, userPowerCreeps[id], roomObjects[id])`. */
export type PowerCreepData = Partial<RawRoomObject> & Partial<PowerCreepDoc>;

/*
 * Player-supplied keys (`power`, target ids) and player objects are read with `getProp` (JS `obj[key]`:
 * ToPropertyKey, inherited members, native TypeErrors), compared with the `utils/js.ts` operators and
 * Memory is written with sloppy-mode assignments, reproducing the untyped upstream expressions.
 */

function calcFreePowerLevels(): number {
  const { runtimeData } = scope();
  const level = Math.floor(
    Math.pow((runtimeData.user.power || 0) / C.POWER_LEVEL_MULTIPLY, 1 / C.POWER_LEVEL_POW),
  );
  const used =
    Object.keys(runtimeData.userPowerCreeps).length +
    sum(collectionValues(runtimeData.userPowerCreeps), (creep) => creep.level);
  return level - used;
}

function data(id: unknown): PowerCreepData {
  const { runtimeData } = scope();
  // The merged copy of the account document and the room object (both optional).
  return Object.assign(
    {},
    getProp(runtimeData.userPowerCreeps, id as PropertyKey),
    getProp(runtimeData.roomObjects, id as PropertyKey),
  );
}

/**
 * Upstream `utils.checkStructureAgainstController(data(s.id), register.objectsByRoom[data(s.id).room],
 * data(s.room.controller.id))` — the merged copies are passed, so identity checks never match.
 */
function structureActive(structure: Structure): boolean {
  const object = data(structure.id);
  const roomObjects = getProp(
    scope().register.objectsByRoom,
    data(structure.id).room as PropertyKey,
  );
  const controller = data(getProp(getProp(structure.room, 'controller'), 'id'));
  // Boundary: the helpers read the raw-object fields present on the merged copies.
  return checkStructureAgainstController(
    object as RawRoomObject,
    (roomObjects ?? {}) as Record<string, RawRoomObject>,
    controller as RawRoomObject,
  );
}

/** The power creep as the receiver of a borrowed `Creep.prototype` method. */
function asCreep(powerCreep: PowerCreep): Creep {
  // Boundary: upstream invokes Creep methods with a PowerCreep receiver (`.call(this, ...)`).
  return powerCreep as unknown as Creep;
}

/** `if(_.isUndefined(Memory.powerCreeps) || Memory.powerCreeps === 'undefined') Memory.powerCreeps = {}` */
function resetPowerCreepsMemory(globals: SandboxGlobals): void {
  if (
    isUndefined(getProp(globals.Memory, 'powerCreeps')) ||
    getProp(globals.Memory, 'powerCreeps') === 'undefined'
  ) {
    jsSetSloppy(globals.Memory, 'powerCreeps', {});
  }
}

const MAX_SAFE_INTEGER = 9007199254740991;

/** lodash 3 `isLength` */
function isLength(value: unknown): value is number {
  return typeof value == 'number' && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
}

/** lodash 3 `getLength` */
function getLength(value: unknown): unknown {
  return value === null || value === undefined ? undefined : getProp(value, 'length');
}

/** lodash 3 `isArrayLike` */
function isArrayLike(value: unknown): boolean {
  return value !== null && value !== undefined && isLength(getLength(value));
}

function hasOwn(value: unknown, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** lodash 3 `isArguments` */
function isArguments(value: unknown): boolean {
  return (
    !!value &&
    typeof value == 'object' &&
    isArrayLike(value) &&
    hasOwn(value, 'callee') &&
    !Object.prototype.propertyIsEnumerable.call(value, 'callee')
  );
}

/** lodash 3 `isIndex` for string keys */
function isIndex(key: string, length: number): boolean {
  const index = /^\d+$/.test(key) ? +key : -1;
  return index > -1 && index % 1 == 0 && index < length;
}

/** lodash 3 `toObject` */
function toObject(value: unknown): object {
  return isObject(value) ? value : (Object(value) as object);
}

/** lodash 3 `keysIn` */
function keysIn(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const object = toObject(value);
  const rawLength = getProp(object, 'length');
  const length =
    rawLength && isLength(rawLength) && (Array.isArray(object) || isArguments(object))
      ? rawLength
      : 0;
  const ctor = getProp(object, 'constructor');
  const isProto = typeof ctor == 'function' && getProp(ctor, 'prototype') === object;
  const skipIndexes = length > 0;
  const result: string[] = [];
  for (let index = 0; index < length; index++) {
    result.push(String(index));
  }
  for (const key in object) {
    if (
      !(skipIndexes && isIndex(key, length)) &&
      !(key == 'constructor' && (isProto || !hasOwn(object, key)))
    ) {
      result.push(key);
    }
  }
  return result;
}

/** lodash 3 `shimKeys` */
function shimKeys(object: unknown): string[] {
  const props = keysIn(object);
  const length: unknown = props.length ? getProp(object, 'length') : props.length;
  const allowIndexes =
    !!length && isLength(length) && (Array.isArray(object) || isArguments(object));
  return props.filter((key) => (allowIndexes && isIndex(key, length)) || hasOwn(object, key));
}

/** lodash 3 `keys` (native `Object.keys` available) */
function lodashKeys(object: unknown): string[] {
  const ctor = object === null || object === undefined ? undefined : getProp(object, 'constructor');
  if (
    (typeof ctor == 'function' && getProp(ctor, 'prototype') === object) ||
    (typeof object != 'function' && isArrayLike(object))
  ) {
    return shimKeys(object);
  }
  return isObject(object) ? Object.keys(object) : [];
}

/** lodash 3 `_.find(collection, predicate)` over any value (arrays, array-likes, objects, primitives). */
function lodashFind(collection: unknown, predicate: (value: unknown) => unknown): unknown {
  if (Array.isArray(collection)) {
    // Boundary: a (possibly proxied) array's `length`, compared like upstream's loop.
    const length = getProp(collection, 'length') as number;
    for (let index = 0; index < length; index++) {
      if (predicate(getProp(collection, index))) {
        return getProp(collection, index);
      }
    }
    return undefined;
  }
  const length = collection ? getLength(collection) : 0;
  const iterable = toObject(collection);
  if (!isLength(length)) {
    for (const key of lodashKeys(collection)) {
      const value = getProp(iterable, key);
      if (predicate(value)) {
        return value;
      }
    }
    return undefined;
  }
  for (let index = 0; index < length; index++) {
    const value = getProp(iterable, index);
    if (predicate(value)) {
      return value;
    }
  }
  return undefined;
}

class PowerCreepImpl extends RoomObject {
  declare id: string;
  declare readonly name: string;
  declare readonly my: boolean;
  declare readonly owner: { username: string };
  declare readonly level: number;
  declare readonly className: string;
  declare readonly hitsMax: number;
  declare readonly hits: number | undefined;
  declare readonly shard: string | undefined;
  declare readonly spawnCooldownTime: number | undefined;
  declare readonly deleteTime: number | undefined;
  declare readonly powers: Record<string, { level: number; cooldown: number }>;
  declare readonly saying: string | undefined;
  declare readonly carry: Store;
  declare readonly store: Store;
  declare readonly carryCapacity: number | null | undefined;
  declare readonly ticksToLive: number;
  declare memory: unknown;

  override toString(): string {
    return `[powerCreep ${this.name}]`;
  }

  // Creep.prototype methods are applied to the power creep exactly like upstream `.call(this, ...)`;
  // the Creep implementations only read members PowerCreep provides.
  move(target: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    return Creep.prototype.move.call(asCreep(this), target);
  }

  moveTo(firstArg: unknown, secondArg?: unknown, opts?: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    return Creep.prototype.moveTo.call(asCreep(this), firstArg, secondArg, opts);
  }

  moveByPath(path: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    return Creep.prototype.moveByPath.call(asCreep(this), path);
  }

  transfer(target: unknown, resourceType: unknown, amount?: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    return Creep.prototype.transfer.call(asCreep(this), target, resourceType, amount);
  }

  withdraw(target: unknown, resourceType: unknown, amount?: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    return Creep.prototype.withdraw.call(asCreep(this), target, resourceType, amount);
  }

  drop(resourceType: unknown, amount?: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    return Creep.prototype.drop.call(asCreep(this), resourceType, amount);
  }

  pickup(target: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    return Creep.prototype.pickup.call(asCreep(this), target);
  }

  say(message: unknown, isPublic?: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    return Creep.prototype.say.call(asCreep(this), message, isPublic);
  }

  spawn(powerSpawn: unknown): number {
    if (this.room) {
      return C.ERR_BUSY;
    }
    if (!(powerSpawn instanceof StructurePowerSpawn)) {
      return C.ERR_INVALID_TARGET;
    }
    if (!this.my || !powerSpawn.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!structureActive(powerSpawn)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }

    if (this.spawnCooldownTime) {
      return C.ERR_TIRED;
    }

    const { globals } = scope();
    if (isUndefined(getProp(globals.Memory, 'powerCreeps'))) {
      jsSetSloppy(globals.Memory, 'powerCreeps', {});
    }
    if (
      isObject(getProp(globals.Memory, 'powerCreeps')) &&
      isUndefined(getProp(getProp(globals.Memory, 'powerCreeps'), this.name))
    ) {
      jsSetSloppy(getProp(globals.Memory, 'powerCreeps'), this.name, {});
    }

    scope().intents.pushByName(
      'global',
      'spawnPowerCreep',
      { id: powerSpawn.id, name: this.name },
      50,
    );
    return C.OK;
  }

  suicide(): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }

    scope().intents.pushByName('global', 'suicidePowerCreep', { id: this.id }, 50);
    return C.OK;
  }

  delete(cancel?: unknown): number {
    if (this.room) {
      return C.ERR_BUSY;
    }
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }

    scope().intents.pushByName('global', 'deletePowerCreep', { id: this.id, cancel }, 50);
    return C.OK;
  }

  upgrade(power: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (calcFreePowerLevels() <= 0) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    if (this.level >= C.POWER_CREEP_MAX_LEVEL) {
      return C.ERR_FULL;
    }
    const powerInfo = getProp(C.POWER_INFO, power as PropertyKey);
    if (!powerInfo || getProp(powerInfo, 'className') !== this.className) {
      return C.ERR_INVALID_ARGS;
    }
    const powerData = getProp(data(this.id).powers, power as PropertyKey);
    const powerLevel = powerData ? getProp(powerData, 'level') : 0;
    if (looseEquals(powerLevel, 5)) {
      return C.ERR_FULL;
    }

    if (jsLt(this.level, getProp(getProp(powerInfo, 'level'), powerLevel as PropertyKey))) {
      return C.ERR_FULL;
    }

    scope().intents.pushByName('global', 'upgradePowerCreep', { id: this.id, power }, 50);
    return C.OK;
  }

  usePower(power: unknown, target?: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!this.room) {
      return C.ERR_BUSY;
    }
    if (this.room.controller) {
      if (!this.room.controller.isPowerEnabled) {
        return C.ERR_INVALID_ARGS;
      }
      if (!this.room.controller.my && this.room.controller.safeMode) {
        return C.ERR_INVALID_ARGS;
      }
    }

    const powerData = getProp(data(this.id).powers, power as PropertyKey);
    const powerInfo = getProp(C.POWER_INFO, power as PropertyKey);
    if (!powerData || !getProp(powerData, 'level') || !powerInfo) {
      return C.ERR_NO_BODYPART;
    }
    const { runtimeData, intents } = scope();
    if (jsGt(getProp(powerData, 'cooldownTime'), runtimeData.time)) {
      return C.ERR_TIRED;
    }
    let ops: unknown = getProp(powerInfo, 'ops') || 0;
    if (isArray(ops)) {
      ops = getProp(ops, jsSub(getProp(powerData, 'level'), 1) as PropertyKey);
    }
    if (jsLt(getProp(getProp(data(this.id), 'store'), 'ops') || 0, ops)) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    if (getProp(powerInfo, 'range')) {
      if (!target) {
        return C.ERR_INVALID_TARGET;
      }
      if (!this.pos.inRangeTo(target, getProp(powerInfo, 'range'))) {
        return C.ERR_NOT_IN_RANGE;
      }
      const currentEffect = lodashFind(getProp(target, 'effects'), (i) =>
        looseEquals(getProp(i, 'power'), power),
      );
      if (
        currentEffect &&
        jsGt(getProp(currentEffect, 'level'), getProp(powerData, 'level')) &&
        jsGt(getProp(currentEffect, 'ticksRemaining'), 0)
      ) {
        return C.ERR_FULL;
      }
    }

    intents.set(this.id, 'usePower', { power, id: target ? getProp(target, 'id') : undefined });
    return C.OK;
  }

  enableRoom(target: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!this.room) {
      return C.ERR_BUSY;
    }

    const { register, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      !getProp(register.structures, getProp(target, 'id') as PropertyKey) ||
      !(target instanceof Structure)
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    if (!target.pos.isNearTo(this.pos)) {
      return C.ERR_NOT_IN_RANGE;
    }
    if (
      target.structureType != 'controller' ||
      (getProp(target, 'safeMode') && !getProp(target, 'my'))
    ) {
      return C.ERR_INVALID_TARGET;
    }

    intents.set(this.id, 'enableRoom', { id: target.id });
    return C.OK;
  }

  renew(target: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!this.room) {
      return C.ERR_BUSY;
    }

    const { register, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      !getProp(register.structures, getProp(target, 'id') as PropertyKey) ||
      (!(target instanceof StructurePowerBank) && !(target instanceof StructurePowerSpawn))
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    if (target instanceof StructurePowerSpawn && !structureActive(target)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    if (!target.pos.isNearTo(this.pos)) {
      return C.ERR_NOT_IN_RANGE;
    }
    intents.set(this.id, 'renew', { id: target.id });
    return C.OK;
  }

  cancelOrder(name: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (scope().intents.remove(this.id, jsString(name))) {
      return C.OK;
    }
    return C.ERR_NOT_FOUND;
  }

  rename(name: unknown): number {
    if (this.room) {
      return C.ERR_BUSY;
    }
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!name || !isString(name) || name.length > 100) {
      return C.ERR_INVALID_ARGS;
    }
    const { runtimeData, intents } = scope();
    if (Object.values(runtimeData.userPowerCreeps).some((i) => i.name === name)) {
      return C.ERR_NAME_EXISTS;
    }

    intents.pushByName('global', 'renamePowerCreep', { id: this.id, name }, 50);
    return C.OK;
  }

  notifyWhenAttacked(enabled: unknown): number {
    if (!this.room) {
      return C.ERR_BUSY;
    }
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!isBoolean(enabled)) {
      return C.ERR_INVALID_ARGS;
    }

    if (enabled != data(this.id).notifyWhenAttacked) {
      scope().intents.set(this.id, 'notifyWhenAttacked', { enabled });
    }

    return C.OK;
  }

  static create(name: unknown, className: unknown): number {
    if (!name || !isString(name) || name.length > 100) {
      return C.ERR_INVALID_ARGS;
    }
    if (calcFreePowerLevels() <= 0) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    const { runtimeData, intents } = scope();
    if (Object.values(runtimeData.userPowerCreeps).some((i) => i.name === name)) {
      return C.ERR_NAME_EXISTS;
    }
    if ((Object.values(C.POWER_CLASS) as unknown[]).indexOf(className) === -1) {
      return C.ERR_INVALID_ARGS;
    }
    intents.pushByName('global', 'createPowerCreep', { name, className }, 50);
    return C.OK;
  }
}

export type PowerCreep = PowerCreepImpl;

/**
 * Upstream `register.wrapFn(function(id) {…})`. `gameConstructor` copies the `create` static onto the
 * constructor (enumerable, like upstream `PowerCreep.create = …`); the cast only exposes it in the type.
 */
export const PowerCreep = gameConstructor(
  PowerCreepImpl,
  function (this: PowerCreep, id?: unknown): void {
    const creepData = data(id);
    if (creepData.room) {
      RoomObject.call(this, creepData.x, creepData.y, creepData.room);
    }
    // upstream stores the raw argument, even when undefined
    this.id = id as string;
  },
  { name: '', length: 1 },
) as GameConstructor<PowerCreep, [id?: unknown]> & Pick<typeof PowerCreepImpl, 'create'>;

defineGameObjectProperties<PowerCreep, PowerCreepData>(PowerCreep.prototype, data, {
  // power creep documents always carry these fields; the raw values are returned like upstream
  name: (o) => o.name as string,
  my: (o) => o.user == scope().runtimeData.user._id,
  owner: (o) => ({ username: username(String(o.user)) }),
  level: (o) => o.level as number,
  className: (o) => o.className as string,
  hitsMax: (o) => o.hitsMax as number,
  hits: (o) => o.hits,
  shard: (o) => o.shard || undefined,
  // The casts let TypeScript emit upstream's raw comparisons/arithmetic (`undefined` coerces like JS).
  spawnCooldownTime: (o) =>
    o.spawnCooldownTime !== null && (o.spawnCooldownTime as number) > Date.now()
      ? o.spawnCooldownTime
      : undefined,
  deleteTime: (o) => o.deleteTime || undefined,
  powers: (o) => {
    const { runtimeData } = scope();
    const result: Record<string, { level: number; cooldown: number }> = {};
    for (const [key, i] of Object.entries(o.powers ?? {})) {
      result[key] = {
        level: i.level,
        cooldown: Math.max(0, (i.cooldownTime || 0) - runtimeData.time),
      };
    }
    return result;
  },
  saying: (o) => {
    const say = o.actionLog?.say;
    if (!say) {
      return undefined;
    }
    // `say` may be any truthy action-log value; its fields are read like upstream.
    if (o.user == scope().runtimeData.user._id) {
      return getProp(say, 'message') as string | undefined;
    }
    return getProp(say, 'isPublic') ? (getProp(say, 'message') as string | undefined) : undefined;
  },
  carry: (o) => new Store(o),
  store: (o) => new Store(o),
  carryCapacity: (o) => o.storeCapacity,
  ticksToLive: (o) => (o.ageTime as number) - scope().runtimeData.time,
});

// Sloppy-mode accessor bodies reading `globals.Memory` on every access, like upstream.
Object.defineProperty(PowerCreep.prototype, 'memory', {
  get(this: unknown): unknown {
    const self = sloppyThis(this);
    if (getProp(self, 'id') && !getProp(self, 'my')) {
      return undefined;
    }
    const { globals } = scope();
    resetPowerCreepsMemory(globals);
    if (!isObject(getProp(globals.Memory, 'powerCreeps'))) {
      return undefined;
    }
    // `Memory.powerCreeps[this.name] = Memory.powerCreeps[this.name] || {}`
    const powerCreeps = getProp(globals.Memory, 'powerCreeps');
    const key = getProp(self, 'name') as PropertyKey;
    const value: unknown =
      getProp(getProp(globals.Memory, 'powerCreeps'), getProp(self, 'name') as PropertyKey) || {};
    jsSetSloppy(powerCreeps, key, value);
    return value;
  },
  set(this: unknown, value: unknown): void {
    const self = sloppyThis(this);
    if (getProp(self, 'id') && !getProp(self, 'my')) {
      throw new Error("Could not set other player's creep memory");
    }
    const { globals } = scope();
    resetPowerCreepsMemory(globals);
    if (!isObject(getProp(globals.Memory, 'powerCreeps'))) {
      throw new Error('Could not set creep memory');
    }
    jsSetSloppy(
      getProp(globals.Memory, 'powerCreeps'),
      getProp(self, 'name') as PropertyKey,
      value,
    );
  },
});

export function make(): void {
  if (scope().globals.PowerCreep) {
    return;
  }
  exposeGlobal('PowerCreep', PowerCreep);
}
