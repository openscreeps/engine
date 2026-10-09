/*
 * Structures of the game API (screeps/engine `src/game/structures.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import {
  calcCreepCost,
  calcResources,
  calcRoomsDistance,
  calcTerminalEnergyCost,
  checkStructureAgainstController,
  getReactionVariants,
  jsAdd,
  jsGt,
  jsLt,
  jsMul,
  jsString,
  jsSub,
  looseEquals,
  roomNameToXY,
  toNumber,
  toPrimitive,
} from '../../utils/index.ts';
import { collectionValues, isObject, isString, sum } from '../../utils/lodash.ts';
import { getProp } from '../../utils/tables.ts';
import type { Effect, EffectCollection } from '../../simulation/state.ts';
import { contains, isArray, isBoolean, isUndefined, uniq } from './compat.ts';
import { Creep } from './creeps.ts';
import {
  defineGameObjectProperties,
  exposeGlobal,
  gameConstructor,
  type GameConstructor,
} from './define.ts';
import { getUniqueName } from './names.ts';
import { PowerCreep } from './power-creeps.ts';
import { RoomObject, type RoomObjectEffect } from './room-object.ts';
import { RoomPosition } from './room-position.ts';
import type { Room } from './rooms.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { memoryRoot, rawObject, scope, username } from './scope.ts';
import { Store } from './store.ts';

let createdCreepNames: unknown[] = [];
let lastActivateSafeMode: string | null = null;

// Widened views of the literal constant tables, indexed by untrusted keys like upstream.
const CONTROLLER_STRUCTURES: Readonly<Record<string, unknown>> = C.CONTROLLER_STRUCTURES;
const CONTROLLER_LEVELS: Readonly<Record<number, number>> = C.CONTROLLER_LEVELS;
const CONTROLLER_DOWNGRADE: Readonly<Record<number, number>> = C.CONTROLLER_DOWNGRADE;
const REACTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = C.REACTIONS;
const BOOSTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = C.BOOSTS;

const COMMODITIES: object = C.COMMODITIES;

function readError(property: string): TypeError {
  return new TypeError(`Cannot read properties of undefined (reading '${property}')`);
}

/** `this.room` followed by a property read, throwing like upstream when the object has no room. */
function roomOf(object: RoomObject, property: string): Room {
  if (!object.room) {
    throw readError(property);
  }
  return object.room;
}

function storeOf(o: RawRoomObject, property: string): Record<string, number> {
  if (!o.store) {
    throw readError(property);
  }
  return o.store;
}

/** `_(effects)` iterates arrays and plain objects (by values) alike. */
function effectList(effects: EffectCollection | null | undefined): readonly Effect[] {
  if (!effects) {
    return [];
  }
  return Array.isArray(effects) ? effects : Object.values(effects);
}

/** ECMAScript ToPropertyKey: how `object[value]` converts an untrusted key. */
function propertyKey(value: unknown): string | symbol {
  const key = toPrimitive(value, 'string');
  return typeof key === 'symbol' ? key : jsString(key);
}

/** `registry[target.id]` with upstream's fresh `id` read and key conversion (inherited keys included). */
function lookupTarget(registry: object, target: unknown): unknown {
  return Reflect.get(registry, propertyKey(getProp(target, 'id')));
}

/** `value.toString()` on an untrusted value; the result is kept as is like upstream. */
function callToString(value: unknown): unknown {
  const fn = getProp(value, 'toString');
  if (typeof fn !== 'function') {
    throw new TypeError('name.toString is not a function');
  }
  return Reflect.apply(fn, value, []);
}

/** lodash 3 `_.keys`: own enumerable keys of objects, indices of strings, nothing for other primitives. */
function lodashKeys(value: unknown): string[] {
  if (isObject(value)) {
    return Object.keys(value);
  }
  return typeof value === 'string'
    ? Array.from({ length: value.length }, (_entry, index) => String(index))
    : [];
}

/** Upstream `utils.roomNameToXY(name)` calls `name.substr(1)`: only strings and String objects work. */
function roomNameArgument(value: unknown): string {
  if (!isString(value)) {
    throw new TypeError('name.substr is not a function');
  }
  return jsString(value);
}

function effectBonus(
  effects: readonly RoomObjectEffect[] | undefined,
  power: number,
  table: readonly number[],
): number {
  const effect = effects?.find((i) => i.power == power);
  if (effect && effect.ticksRemaining > 0) {
    return effect.level === undefined ? NaN : (table[effect.level - 1] ?? NaN);
  }
  return 0;
}

function ticksToDecay(o: RawRoomObject): number | undefined {
  const time = scope().runtimeData.time;
  if (o.nextDecayTime) {
    return o.nextDecayTime - time;
  }
  if (o.decayTime) {
    return typeof o.decayTime === 'number' ? o.decayTime - time : NaN;
  }
  return undefined;
}

function cooldownOf(o: RawRoomObject): number {
  const time = scope().runtimeData.time;
  return o.cooldownTime && o.cooldownTime > time ? o.cooldownTime - time : 0;
}

function storeGetter(o: RawRoomObject): Store {
  return new Store(o);
}

/** `utils.checkStructureAgainstController(data(this.id), register.objectsByRoom[...], data(this.room.controller.id))` */
function activeAgainstController(structure: Structure): boolean {
  const raw = rawObject(structure.id);
  const objects = scope().register.objectsByRoom[raw.room];
  const controller = roomOf(structure, 'controller').controller;
  if (!controller) {
    throw readError('id');
  }
  return checkStructureAgainstController(
    raw,
    objects ?? EMPTY_ROOM_OBJECTS,
    rawObject(controller.id),
  );
}

function isBody(body: readonly unknown[]): body is string[] {
  for (let i = 0; i < body.length; i++) {
    if (!contains(C.BODYPARTS_ALL, body[i])) {
      return false;
    }
  }
  return true;
}

function isResource(value: unknown): value is string {
  return contains(C.RESOURCES_ALL, value);
}

/** `_.keys(undefined)` is empty upstream, so a room without stored objects scans nothing. */
const EMPTY_ROOM_OBJECTS: Readonly<Record<string, RawRoomObject>> = Object.freeze({});

/** lodash 3 `_.map(collection, 'id')`. */
function pluckIds(collection: unknown): unknown[] {
  return collectionValues(collection as Readonly<Record<string, unknown>> | null | undefined).map(
    (v): unknown => (v === null || v === undefined ? undefined : getProp(v, 'id')),
  );
}

function creepsMemory(): object | undefined {
  if (isUndefined(memoryRoot().creeps)) {
    memoryRoot().creeps = {};
  }
  const creeps: unknown = memoryRoot().creeps;
  return isObject(creeps) ? creeps : undefined;
}

/** The temporary `Game.creeps[name]` object created by `createCreep`/`spawnCreep`. */
function makeSpawningCreep(spawn: StructureSpawn, name: unknown, body: unknown): void {
  const { globals, runtimeData } = scope();
  Reflect.set(globals.Game.creeps, propertyKey(name), new Creep());
  RoomObject.call(
    Reflect.get(globals.Game.creeps, propertyKey(name)),
    spawn.pos.x,
    spawn.pos.y,
    spawn.pos.roomName,
  );
  Object.defineProperties(Reflect.get(globals.Game.creeps, propertyKey(name)), {
    name: { enumerable: true, get: () => name },
    spawning: { enumerable: true, get: () => true },
    my: { enumerable: true, get: () => true },
    body: {
      enumerable: true,
      get: () =>
        collectionValues(body as Readonly<Record<string, unknown>> | null | undefined).map(
          (type) => ({
            type,
            hits: 100,
          }),
        ),
    },
    owner: { enumerable: true, get: () => ({ username: runtimeData.user.username }) },
    ticksToLive: { enumerable: true, get: () => C.CREEP_LIFE_TIME },
    carryCapacity: {
      enumerable: true,
      get: () =>
        collectionValues(
          body as Readonly<Record<string, unknown>> | null | undefined,
        ).reduce<number>(
          (result, type) => result + (looseEquals(type, C.CARRY) ? C.CARRY_CAPACITY : 0),
          0,
        ),
    },
    carry: { enumerable: true, get: () => ({ energy: 0 }) },
    store: { enumerable: true, get: () => new Store({ store: { energy: 0 } }) },
    fatigue: { enumerable: true, get: () => 0 },
    hits: { enumerable: true, get: () => toNumber(getProp(body, 'length')) * 100 },
    hitsMax: { enumerable: true, get: () => toNumber(getProp(body, 'length')) * 100 },
    saying: { enumerable: true, get: () => undefined },
  });
}

function calcEnergyAvailable(
  roomObjects: Record<string, RawRoomObject>,
  energyStructures: readonly unknown[],
): number {
  return sum(energyStructures, (id) => {
    const at = (): RawRoomObject | undefined =>
      Reflect.get(roomObjects, propertyKey(id)) as RawRoomObject | undefined;
    if (
      at() &&
      !at()?.off &&
      (at()?.type === 'spawn' || at()?.type === 'extension') &&
      at()?.store
    ) {
      return at()?.store?.energy;
    }
    return 0;
  });
}

/**
 * Structure
 */
class StructureImpl extends RoomObject {
  declare id: string;
  declare readonly hits: number | undefined;
  declare readonly hitsMax: number | undefined;
  declare readonly structureType: string;

  override toString(): string {
    return `[structure (${this.structureType}) #${this.id}]`;
  }

  destroy(): number {
    if (!this.room) {
      return C.ERR_INVALID_TARGET;
    }
    if (!this.room.controller || !this.room.controller.my) {
      return C.ERR_NOT_OWNER;
    }
    if (
      this.room.find(C.FIND_HOSTILE_CREEPS).length > 0 ||
      this.room.find(C.FIND_HOSTILE_POWER_CREEPS).length > 0
    ) {
      return C.ERR_BUSY;
    }
    scope().intents.pushByName('room', 'destroyStructure', {
      roomName: this.room.name,
      id: this.id,
    });
    return C.OK;
  }

  notifyWhenAttacked(enabled: unknown): number {
    if (!this.room) {
      return C.ERR_INVALID_TARGET;
    }
    const controller = this.room.controller;
    if (Reflect.get(this, 'my') === false || (controller && controller.owner && !controller.my)) {
      return C.ERR_NOT_OWNER;
    }
    if (!isBoolean(enabled)) {
      return C.ERR_INVALID_ARGS;
    }
    if (enabled != rawObject(this.id).notifyWhenAttacked) {
      scope().intents.set(this.id, 'notifyWhenAttacked', { enabled });
    }
    return C.OK;
  }

  isActive(): boolean {
    const owner: unknown = Reflect.get(this, 'owner');
    if (!owner) {
      return true;
    }
    if (!CONTROLLER_STRUCTURES[rawObject(this.id).type]) {
      return true;
    }
    if (!this.room || !this.room.controller) {
      return false;
    }
    return activeAgainstController(this);
  }
}
export type Structure = StructureImpl;
/** Upstream `register.wrapFn(function(id) {…})`. */
export const Structure: GameConstructor<Structure, [id?: unknown]> = gameConstructor(
  StructureImpl,
  function (this: Structure, id?: unknown): void {
    if (id) {
      this.id = id as string;
      const data = rawObject(id);
      RoomObject.call(this, data.x, data.y, data.room, data.effects);

      if (data.type == C.STRUCTURE_CONTROLLER) {
        roomRegistered(data.room, 'controller').controller = this as StructureController;
      }
      if (data.type == C.STRUCTURE_STORAGE) {
        roomRegistered(data.room, 'storage').storage = this as StructureStorage;
      }
      if (data.type == C.STRUCTURE_TERMINAL) {
        roomRegistered(data.room, 'terminal').terminal = this as StructureTerminal;
      }
    }
  },
  { name: '', length: 1 },
);

/** Upstream subclass constructors whose whole body is `Structure.call(this, id)`. */
function callStructure(this: Structure, id?: unknown): void {
  Structure.call(this, id);
}

/** Upstream subclass constructors whose whole body is `OwnedStructure.call(this, id)`. */
function callOwnedStructure(this: OwnedStructure, id?: unknown): void {
  OwnedStructure.call(this, id);
}
defineGameObjectProperties(Structure.prototype, rawObject, {
  hits: (o) => o.hits,
  hitsMax: (o) => o.hitsMax,
  structureType: (o) => o.type,
});

function roomRegistered(roomName: string, property: string): Room {
  const room = scope().register.rooms[roomName];
  if (!room) {
    throw new TypeError(`Cannot set properties of undefined (setting '${property}')`);
  }
  return room;
}

export interface StructureOwner {
  username: string;
}

/**
 * OwnedStructure
 */
class OwnedStructureImpl extends Structure {
  declare readonly owner: StructureOwner | undefined;
  declare readonly my: boolean | undefined;
}
export type OwnedStructure = OwnedStructureImpl;
export const OwnedStructure: GameConstructor<OwnedStructure, [id?: unknown]> = gameConstructor(
  OwnedStructureImpl,
  callStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(OwnedStructure.prototype, rawObject, {
  owner: (o) =>
    isUndefined(o.user) || o.user === null ? undefined : { username: username(o.user) },
  my: (o) => (isUndefined(o.user) ? undefined : o.user == scope().runtimeData.user._id),
});

/**
 * StructureContainer
 */
class StructureContainerImpl extends Structure {
  declare readonly store: Store;
  declare readonly storeCapacity: number | null | undefined;
  declare readonly ticksToDecay: number | undefined;
}
export type StructureContainer = StructureContainerImpl;
export const StructureContainer: GameConstructor<StructureContainer, [id?: unknown]> =
  gameConstructor(StructureContainerImpl, callStructure, { name: '', length: 1 });
defineGameObjectProperties(StructureContainer.prototype, rawObject, {
  store: storeGetter,
  storeCapacity: (o) => o.storeCapacity,
  ticksToDecay,
});

export interface ControllerReservationInfo {
  username: string;
  ticksToEnd: number;
}

export interface ControllerSignInfo {
  username: string;
  text: string;
  time: number;
  datetime: Date;
}

/**
 * StructureController
 */
class StructureControllerImpl extends OwnedStructure {
  declare readonly ticksToDowngrade: number | undefined;
  declare readonly reservation: ControllerReservationInfo | undefined;
  declare readonly level: number | undefined;
  declare readonly progress: number | undefined;
  declare readonly progressTotal: number | undefined;
  declare readonly upgradeBlocked: number | undefined;
  declare readonly safeMode: number | undefined;
  declare readonly safeModeCooldown: number | undefined;
  declare readonly safeModeAvailable: number;
  declare readonly sign: ControllerSignInfo | undefined;
  declare readonly isPowerEnabled: boolean;

  unclaim(): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    scope().intents.set(this.id, 'unclaim', {});
    return C.OK;
  }

  activateSafeMode(): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (this.safeModeAvailable <= 0) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    const downgrade = this.level === undefined ? NaN : (CONTROLLER_DOWNGRADE[this.level] ?? NaN);
    if (
      this.safeModeCooldown ||
      (this.upgradeBlocked ?? 0) > 0 ||
      (this.ticksToDowngrade ?? NaN) < downgrade / 2 - C.CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD
    ) {
      return C.ERR_TIRED;
    }
    const { register, intents } = scope();
    if (
      Object.values(register.structures).some(
        (i) =>
          i.structureType == 'controller' && Reflect.get(i, 'my') && Reflect.get(i, 'safeMode'),
      )
    ) {
      return C.ERR_BUSY;
    }

    if (lastActivateSafeMode) {
      intents.remove(lastActivateSafeMode, 'activateSafeMode');
    }
    lastActivateSafeMode = this.id;

    intents.set(this.id, 'activateSafeMode', {});
    return C.OK;
  }
}
export type StructureController = StructureControllerImpl;
export const StructureController: GameConstructor<StructureController, [id?: unknown]> =
  gameConstructor(StructureControllerImpl, callOwnedStructure, { name: '', length: 1 });
defineGameObjectProperties(StructureController.prototype, rawObject, {
  ticksToDowngrade: (o) =>
    o.downgradeTime ? o.downgradeTime - scope().runtimeData.time : undefined,
  reservation: (o) =>
    o.reservation
      ? {
          username: username(o.reservation.user),
          ticksToEnd: o.reservation.endTime - scope().runtimeData.time,
        }
      : undefined,
  level: (o) => o.level,
  progress: (o) => ((o.level ?? 0) > 0 ? o.progress : undefined),
  progressTotal: (o) =>
    o.level !== undefined && o.level > 0 && o.level < 8 ? CONTROLLER_LEVELS[o.level] : undefined,
  upgradeBlocked: (o) => {
    const time = scope().runtimeData.time;
    return o.upgradeBlocked && o.upgradeBlocked > time ? o.upgradeBlocked - time : undefined;
  },
  safeMode: (o) => {
    const time = scope().runtimeData.time;
    return o.safeMode && o.safeMode > time ? o.safeMode - time : undefined;
  },
  safeModeCooldown: (o) => {
    const time = scope().runtimeData.time;
    return o.safeModeCooldown && o.safeModeCooldown > time ? o.safeModeCooldown - time : undefined;
  },
  safeModeAvailable: (o) => o.safeModeAvailable || 0,
  sign: (o) =>
    o.hardSign
      ? {
          username: C.SYSTEM_USERNAME,
          text: o.hardSign.text,
          time: o.hardSign.time,
          datetime: new Date(o.hardSign.datetime),
        }
      : o.sign
        ? {
            username: username(o.sign.user),
            text: o.sign.text,
            time: o.sign.time,
            datetime: new Date(o.sign.datetime),
          }
        : undefined,
  isPowerEnabled: (o) => !!o.isPowerEnabled,
});

/**
 * StructureExtension
 */
class StructureExtensionImpl extends OwnedStructure {
  declare readonly energy: number | undefined;
  declare readonly energyCapacity: number | null;
  declare readonly store: Store;
}
export type StructureExtension = StructureExtensionImpl;
export const StructureExtension: GameConstructor<StructureExtension, [id?: unknown]> =
  gameConstructor(StructureExtensionImpl, callOwnedStructure, { name: '', length: 1 });
defineGameObjectProperties(StructureExtension.prototype, rawObject, {
  energy: (o) => (o.store ? o.store.energy : 0),
  energyCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.energy || 0 : 0),
  store: storeGetter,
});

/**
 * StructureExtractor
 */
class StructureExtractorImpl extends OwnedStructure {
  declare readonly cooldown: number;
}
export type StructureExtractor = StructureExtractorImpl;
export const StructureExtractor: GameConstructor<StructureExtractor, [id?: unknown]> =
  gameConstructor(StructureExtractorImpl, callOwnedStructure, { name: '', length: 1 });
defineGameObjectProperties(StructureExtractor.prototype, rawObject, {
  cooldown: (o) => o.cooldown || 0,
});

/**
 * StructureKeeperLair
 */
class StructureKeeperLairImpl extends OwnedStructure {
  declare readonly ticksToSpawn: number | undefined;
}
export type StructureKeeperLair = StructureKeeperLairImpl;
export const StructureKeeperLair: GameConstructor<StructureKeeperLair, [id?: unknown]> =
  gameConstructor(StructureKeeperLairImpl, callOwnedStructure, { name: '', length: 1 });
defineGameObjectProperties(StructureKeeperLair.prototype, rawObject, {
  my: () => false,
  owner: () => ({ username: 'Source Keeper' }),
  ticksToSpawn: (o) => (o.nextSpawnTime ? o.nextSpawnTime - scope().runtimeData.time : undefined),
});

/**
 * StructureLab
 */
function labMineralAmountGetter(o: RawRoomObject): number {
  return sum(collectionValues(o.store)) - (storeOf(o, 'energy').energy || 0);
}

function labMineralTypeGetter(o: RawRoomObject): string | undefined {
  const store = o.store;
  if (!store) {
    return undefined;
  }
  return Object.keys(store).find((k) => k != C.RESOURCE_ENERGY && store[k]);
}

/** Lab-specific reads on a target validated only by `structureType` (like upstream). */
interface LabView {
  readonly structureType: string;
  readonly mineralAmount?: number;
  readonly mineralType?: string | undefined;
  readonly mineralCapacity?: number;
}

class StructureLabImpl extends OwnedStructure {
  declare readonly energy: number | undefined;
  declare readonly energyCapacity: number | null | undefined;
  declare readonly cooldown: number;
  declare readonly mineralAmount: number;
  declare readonly mineralCapacity: number;
  declare readonly mineralType: string | undefined;
  declare readonly store: Store;

  runReaction(lab1: unknown, lab2: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (this.cooldown > 0) {
      return C.ERR_TIRED;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    const { register, intents } = scope();
    if (
      !lab1 ||
      !getProp(lab1, 'id') ||
      !lookupTarget(register.structures, lab1) ||
      !(lab1 instanceof Structure) ||
      lab1.structureType != C.STRUCTURE_LAB ||
      lab1.id == this.id
    ) {
      register.assertTargetObject(lab1);
      return C.ERR_INVALID_TARGET;
    }
    if (
      !lab2 ||
      !getProp(lab2, 'id') ||
      !lookupTarget(register.structures, lab2) ||
      !(lab2 instanceof Structure) ||
      lab2.structureType != C.STRUCTURE_LAB ||
      lab2.id == this.id
    ) {
      register.assertTargetObject(lab2);
      return C.ERR_INVALID_TARGET;
    }
    if (this.pos.getRangeTo(lab1) > 2 || this.pos.getRangeTo(lab2) > 2) {
      return C.ERR_NOT_IN_RANGE;
    }
    const reactionAmount =
      C.LAB_REACTION_AMOUNT +
      effectBonus(this.effects, C.PWR_OPERATE_LAB, C.POWER_INFO[C.PWR_OPERATE_LAB].effect);
    if (this.mineralAmount > this.mineralCapacity - reactionAmount) {
      return C.ERR_FULL;
    }
    const l1: LabView = lab1;
    const l2: LabView = lab2;
    if ((l1.mineralAmount ?? NaN) < reactionAmount || (l2.mineralAmount ?? NaN) < reactionAmount) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    const product = REACTIONS[String(l1.mineralType)]?.[String(l2.mineralType)];
    if (
      !(String(l1.mineralType) in REACTIONS) ||
      !product ||
      (this.mineralType && this.mineralType != product)
    ) {
      return C.ERR_INVALID_ARGS;
    }

    intents.set(this.id, 'runReaction', { lab1: lab1.id, lab2: lab2.id });
    return C.OK;
  }

  reverseReaction(lab1: unknown, lab2: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (this.cooldown > 0) {
      return C.ERR_TIRED;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    const { register, intents } = scope();
    if (
      !lab1 ||
      !getProp(lab1, 'id') ||
      !lookupTarget(register.structures, lab1) ||
      !(lab1 instanceof Structure) ||
      lab1.structureType != C.STRUCTURE_LAB ||
      lab1.id == this.id
    ) {
      register.assertTargetObject(lab1);
      return C.ERR_INVALID_TARGET;
    }
    if (
      !lab2 ||
      !getProp(lab2, 'id') ||
      !lookupTarget(register.structures, lab2) ||
      !(lab2 instanceof Structure) ||
      lab2.structureType != C.STRUCTURE_LAB ||
      lab2.id == this.id
    ) {
      register.assertTargetObject(lab2);
      return C.ERR_INVALID_TARGET;
    }
    if (this.pos.getRangeTo(lab1) > 2 || this.pos.getRangeTo(lab2) > 2) {
      return C.ERR_NOT_IN_RANGE;
    }
    if (lab1 === lab2) {
      return C.ERR_INVALID_ARGS;
    }
    const reactionAmount =
      C.LAB_REACTION_AMOUNT +
      effectBonus(this.effects, C.PWR_OPERATE_LAB, C.POWER_INFO[C.PWR_OPERATE_LAB].effect);
    if (!this.mineralType || this.mineralAmount < reactionAmount) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    const l1: LabView = lab1;
    const l2: LabView = lab2;
    const variants = getReactionVariants(this.mineralType);
    const variant = variants.find(
      (v) =>
        (!l1.mineralType || l1.mineralType == v[0]) && (!l2.mineralType || l2.mineralType == v[1]),
    );
    if (!variant) {
      return C.ERR_INVALID_ARGS;
    }
    if (
      (l1.mineralAmount ?? NaN) + reactionAmount > (l1.mineralCapacity ?? NaN) ||
      (l2.mineralAmount ?? NaN) + reactionAmount > (l2.mineralCapacity ?? NaN)
    ) {
      return C.ERR_FULL;
    }

    intents.set(this.id, 'reverseReaction', { lab1: lab1.id, lab2: lab2.id });
    return C.OK;
  }

  boostCreep(target: unknown, bodyPartsCount?: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    const { register, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      !lookupTarget(register.creeps, target) ||
      !(target instanceof Creep) ||
      target.spawning
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    if (!this.pos.isNearTo(target)) {
      return C.ERR_NOT_IN_RANGE;
    }
    const raw = rawObject(this.id);
    if ((storeOf(raw, 'energy').energy ?? NaN) < C.LAB_BOOST_ENERGY) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    if (labMineralAmountGetter(rawObject(this.id)) < C.LAB_BOOST_MINERAL) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    const partsCount: unknown = bodyPartsCount || 0;
    const nonBoostedParts = target.body.filter((i) => {
      if (i.boost) {
        return false;
      }
      const boosts = BOOSTS[i.type];
      return boosts && boosts[String(labMineralTypeGetter(rawObject(this.id)))];
    }).length;

    if (!nonBoostedParts || (partsCount && jsGt(partsCount, nonBoostedParts))) {
      return C.ERR_NOT_FOUND;
    }

    intents.set(this.id, 'boostCreep', { id: target.id, bodyPartsCount: partsCount });
    return C.OK;
  }

  unboostCreep(target: unknown): number {
    const { register, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      !lookupTarget(register.creeps, target) ||
      !(target instanceof Creep)
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    if (!this.my || !target.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    if (this.cooldown > 0) {
      return C.ERR_TIRED;
    }
    if (!target.body.some((p) => !!p.boost)) {
      return C.ERR_NOT_FOUND;
    }
    if (!this.pos.isNearTo(target)) {
      return C.ERR_NOT_IN_RANGE;
    }

    intents.set(this.id, 'unboostCreep', { id: target.id });
    return C.OK;
  }
}
export type StructureLab = StructureLabImpl;
export const StructureLab: GameConstructor<StructureLab, [id?: unknown]> = gameConstructor(
  StructureLabImpl,
  callOwnedStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureLab.prototype, rawObject, {
  energy: (o) => (o.store ? o.store.energy : 0),
  energyCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.energy : 0),
  cooldown: cooldownOf,
  mineralAmount: labMineralAmountGetter,
  mineralCapacity: () => C.LAB_MINERAL_CAPACITY,
  mineralType: labMineralTypeGetter,
  store: storeGetter,
});

/**
 * StructureLink
 */
class StructureLinkImpl extends OwnedStructure {
  declare readonly energy: number | undefined;
  declare readonly energyCapacity: number | null;
  declare readonly cooldown: number;
  declare readonly store: Store;

  transferEnergy(target: unknown, amount?: unknown): number {
    if (jsLt(amount, 0)) {
      return C.ERR_INVALID_ARGS;
    }
    const { register, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      !lookupTarget(register.structures, target) ||
      !(target instanceof Structure) ||
      target === this ||
      target.structureType != C.STRUCTURE_LINK
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    if (!Reflect.get(target, 'my')) {
      return C.ERR_NOT_OWNER;
    }
    const lookedStructures: unknown = this.pos.lookFor('structure');
    if (
      this.my === false &&
      Array.isArray(lookedStructures) &&
      lookedStructures.some(
        (i: unknown) => Reflect.get(Object(i), 'structureType') == C.STRUCTURE_RAMPART,
      )
    ) {
      return C.ERR_NOT_OWNER;
    }

    if (this.cooldown > 0) {
      return C.ERR_TIRED;
    }
    if (!roomOf(this, 'controller').controller) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }

    const own = rawObject(this.id);
    if (!own.store || !own.store.energy) {
      return C.ERR_NOT_ENOUGH_ENERGY;
    }
    if (!amount) {
      const targetData = rawObject(target.id);
      amount = Math.min(
        own.store.energy,
        targetData.storeCapacityResource
          ? (targetData.storeCapacityResource.energy ?? NaN) -
              (storeOf(targetData, 'energy').energy ?? NaN)
          : 0,
      );
    }
    if (jsLt(this.energy, amount)) {
      return C.ERR_NOT_ENOUGH_ENERGY;
    }
    const targetData = rawObject(target.id);
    const capacity = targetData.storeCapacityResource;
    if (
      !capacity ||
      !capacity.energy ||
      jsGt(jsAdd(storeOf(targetData, 'energy').energy, amount), capacity.energy)
    ) {
      return C.ERR_FULL;
    }
    if (target.pos.roomName != this.pos.roomName) {
      return C.ERR_NOT_IN_RANGE;
    }

    intents.set(this.id, 'transfer', { id: target.id, amount, resourceType: 'energy' });
    return C.OK;
  }
}
export type StructureLink = StructureLinkImpl;
export const StructureLink: GameConstructor<StructureLink, [id?: unknown]> = gameConstructor(
  StructureLinkImpl,
  callOwnedStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureLink.prototype, rawObject, {
  energy: (o) => (o.store ? o.store.energy : 0),
  energyCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.energy || 0 : 0),
  cooldown: (o) => o.cooldown || 0,
  store: storeGetter,
});

/**
 * StructureObserver
 */
class StructureObserverImpl extends OwnedStructure {
  observeRoom(roomName: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!isString(roomName) || !/^(W|E)\d+(S|N)\d+$/.test(jsString(roomName))) {
      return C.ERR_INVALID_ARGS;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }

    const [tx, ty] = roomNameToXY(jsString(roomName));
    const [x, y] = roomNameToXY(rawObject(this.id).room);

    const effect = this.effects?.find((i) => i.power == C.PWR_OPERATE_OBSERVER);
    if (
      (!effect || effect.ticksRemaining <= 0) &&
      (Math.abs(tx - x) > C.OBSERVER_RANGE || Math.abs(ty - y) > C.OBSERVER_RANGE)
    ) {
      return C.ERR_NOT_IN_RANGE;
    }

    scope().intents.set(this.id, 'observeRoom', { roomName });
    return C.OK;
  }
}
export type StructureObserver = StructureObserverImpl;
export const StructureObserver: GameConstructor<StructureObserver, [id?: unknown]> =
  gameConstructor(StructureObserverImpl, callOwnedStructure, { name: '', length: 1 });

/**
 * StructurePowerBank
 */
class StructurePowerBankImpl extends OwnedStructure {
  declare readonly power: number | undefined;
  declare readonly ticksToDecay: number | undefined;
}
export type StructurePowerBank = StructurePowerBankImpl;
export const StructurePowerBank: GameConstructor<StructurePowerBank, [id?: unknown]> =
  gameConstructor(StructurePowerBankImpl, callOwnedStructure, { name: '', length: 1 });
defineGameObjectProperties(StructurePowerBank.prototype, rawObject, {
  power: (o) => storeOf(o, 'power').power,
  ticksToDecay,
  my: () => false,
  owner: () => ({ username: 'Power Bank' }),
});

/**
 * StructurePowerSpawn
 */
class StructurePowerSpawnImpl extends OwnedStructure {
  declare readonly energy: number;
  declare readonly energyCapacity: number | null | undefined;
  declare readonly power: number;
  declare readonly powerCapacity: number | null | undefined;
  declare readonly store: Store;

  processPower(): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    const amount =
      1 + effectBonus(this.effects, C.PWR_OPERATE_POWER, C.POWER_INFO[C.PWR_OPERATE_POWER].effect);
    if (this.power < amount || this.energy < amount * C.POWER_SPAWN_ENERGY_RATIO) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }

    scope().intents.set(this.id, 'processPower', {});
    return C.OK;
  }
}
export type StructurePowerSpawn = StructurePowerSpawnImpl;
export const StructurePowerSpawn: GameConstructor<StructurePowerSpawn, [id?: unknown]> =
  gameConstructor(StructurePowerSpawnImpl, callOwnedStructure, { name: '', length: 1 });
defineGameObjectProperties(StructurePowerSpawn.prototype, rawObject, {
  energy: (o) => (o.store ? o.store.energy || 0 : 0),
  energyCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.energy : 0),
  power: (o) => (o.store ? o.store.power || 0 : 0),
  powerCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.power : 0),
  store: storeGetter,
});

/**
 * StructureRampart
 */
class StructureRampartImpl extends OwnedStructure {
  declare readonly ticksToDecay: number | undefined;
  declare readonly isPublic: boolean;

  setPublic(isPublic: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    scope().intents.set(this.id, 'setPublic', { isPublic: !!isPublic });
    return C.OK;
  }
}
export type StructureRampart = StructureRampartImpl;
export const StructureRampart: GameConstructor<StructureRampart, [id?: unknown]> = gameConstructor(
  StructureRampartImpl,
  callOwnedStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureRampart.prototype, rawObject, {
  ticksToDecay,
  isPublic: (o) => !!o.isPublic,
});

/**
 * StructureRoad
 */
class StructureRoadImpl extends Structure {
  declare readonly ticksToDecay: number | undefined;
}
export type StructureRoad = StructureRoadImpl;
export const StructureRoad: GameConstructor<StructureRoad, [id?: unknown]> = gameConstructor(
  StructureRoadImpl,
  callStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureRoad.prototype, rawObject, {
  ticksToDecay,
});

/**
 * StructureStorage
 */
class StructureStorageImpl extends OwnedStructure {
  declare readonly store: Store;
  declare readonly storeCapacity: number | null | undefined;
}
export type StructureStorage = StructureStorageImpl;
export const StructureStorage: GameConstructor<StructureStorage, [id?: unknown]> = gameConstructor(
  StructureStorageImpl,
  callOwnedStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureStorage.prototype, rawObject, {
  store: storeGetter,
  storeCapacity: (o) => o.storeCapacity,
});

/**
 * StructureTerminal
 */
class StructureTerminalImpl extends OwnedStructure {
  declare readonly store: Store;
  declare readonly storeCapacity: number | null | undefined;
  declare readonly cooldown: number;

  send(
    resourceType: unknown,
    amount: unknown,
    targetRoomName: unknown,
    description?: unknown,
  ): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    if (typeof targetRoomName === 'symbol') {
      throw new TypeError('Cannot convert a Symbol value to a string');
    }
    if (!/^(W|E)\d+(N|S)\d+$/.test(jsString(targetRoomName))) {
      return C.ERR_INVALID_ARGS;
    }
    if (!isResource(resourceType)) {
      return C.ERR_INVALID_ARGS;
    }
    const { runtimeData, intents } = scope();
    const raw = rawObject(this.id);
    const stored = raw.store ? raw.store[resourceType] : undefined;
    if (!raw.store || !stored || jsLt(stored, amount)) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    if ((raw.cooldownTime ?? NaN) > runtimeData.time) {
      return C.ERR_TIRED;
    }
    const range = calcRoomsDistance(
      raw.room,
      roomNameArgument(targetRoomName),
      true,
      runtimeData.worldSize,
    );
    // `amount * …` inside calcTerminalEnergyCost: same conversion (BigInt throws the mixing error).
    const cost = calcTerminalEnergyCost(Number(jsMul(amount, 1)), range);
    const energy = raw.store.energy ?? NaN;
    if (
      (resourceType != C.RESOURCE_ENERGY && energy < cost) ||
      (resourceType == C.RESOURCE_ENERGY && jsLt(raw.store.energy, jsAdd(amount, cost)))
    ) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }
    if (description && (!isString(description) || jsString(description).length > 100)) {
      return C.ERR_INVALID_ARGS;
    }

    intents.set(this.id, 'send', { resourceType, amount, targetRoomName, description });
    return C.OK;
  }
}
export type StructureTerminal = StructureTerminalImpl;
export const StructureTerminal: GameConstructor<StructureTerminal, [id?: unknown]> =
  gameConstructor(StructureTerminalImpl, callOwnedStructure, { name: '', length: 1 });
defineGameObjectProperties(StructureTerminal.prototype, rawObject, {
  store: storeGetter,
  storeCapacity: (o) => o.storeCapacity,
  cooldown: cooldownOf,
});

/**
 * StructureTower
 */
class StructureTowerImpl extends OwnedStructure {
  declare readonly energy: number | undefined;
  declare readonly energyCapacity: number | null;
  declare readonly store: Store;

  attack(target: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    const { register, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      (!lookupTarget(register.creeps, target) &&
        !lookupTarget(register.powerCreeps, target) &&
        !lookupTarget(register.structures, target)) ||
      (!(target instanceof Creep) &&
        !(target instanceof PowerCreep) &&
        !(target instanceof StructureSpawn) &&
        !(target instanceof Structure))
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    const raw = rawObject(this.id);
    if (!raw.store || (raw.store.energy ?? NaN) < C.TOWER_ENERGY_COST) {
      return C.ERR_NOT_ENOUGH_ENERGY;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }

    intents.set(this.id, 'attack', { id: target.id });
    return C.OK;
  }

  heal(target: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    const { register, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      (!lookupTarget(register.creeps, target) && !lookupTarget(register.powerCreeps, target)) ||
      (!(target instanceof Creep) && !(target instanceof PowerCreep))
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    const raw = rawObject(this.id);
    if (!raw.store || (raw.store.energy ?? NaN) < C.TOWER_ENERGY_COST) {
      return C.ERR_NOT_ENOUGH_ENERGY;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }

    intents.set(this.id, 'heal', { id: target.id });
    return C.OK;
  }

  repair(target: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    const { register, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      !lookupTarget(register.structures, target) ||
      (!(target instanceof Structure) && !(target instanceof StructureSpawn))
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    const raw = rawObject(this.id);
    if (!raw.store || (raw.store.energy ?? NaN) < C.TOWER_ENERGY_COST) {
      return C.ERR_NOT_ENOUGH_ENERGY;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }

    intents.set(this.id, 'repair', { id: target.id });
    return C.OK;
  }
}
export type StructureTower = StructureTowerImpl;
export const StructureTower: GameConstructor<StructureTower, [id?: unknown]> = gameConstructor(
  StructureTowerImpl,
  callOwnedStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureTower.prototype, rawObject, {
  energy: (o) => (o.store ? o.store.energy : 0),
  energyCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.energy || 0 : 0),
  store: storeGetter,
});

/**
 * StructureWall
 */
class StructureWallImpl extends Structure {
  declare readonly ticksToLive: number | null | undefined;
}
export type StructureWall = StructureWallImpl;
export const StructureWall: GameConstructor<StructureWall, [id?: unknown]> = gameConstructor(
  StructureWallImpl,
  callStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureWall.prototype, rawObject, {
  ticksToLive: (o) => o.ticksToLive,
});

/**
 * SpawnSpawning (exposed as `StructureSpawn.Spawning`)
 */
class StructureSpawnSpawningImpl {
  declare readonly spawn: unknown;
  declare name: unknown;
  declare needTime: unknown;
  declare remainingTime: unknown;
  declare directions: unknown;

  setDirections(directions: unknown): number {
    if (!getProp(this.spawn, 'my')) {
      return C.ERR_NOT_OWNER;
    }
    if (isArray(directions) && directions.length > 0) {
      // convert directions to numbers, eliminate duplicates
      const numbers = uniq(Array.from(directions, (e) => toNumber(e)));
      // bail if any numbers are out of bounds or non-integers
      if (
        !numbers.some(
          (direction) => direction < 1 || direction > 8 || direction !== (direction | 0),
        )
      ) {
        scope().intents.set(jsString(getProp(this.spawn, 'id')), 'setSpawnDirections', {
          directions: numbers,
        });
        return C.OK;
      }
    }
    return C.ERR_INVALID_ARGS;
  }

  cancel(): number {
    if (!getProp(this.spawn, 'my')) {
      return C.ERR_NOT_OWNER;
    }
    scope().intents.set(jsString(getProp(this.spawn, 'id')), 'cancelSpawning', {});
    return C.OK;
  }
}
export type StructureSpawnSpawning = StructureSpawnSpawningImpl;
/** Upstream `StructureSpawn.Spawning = register.wrapFn(function(spawnId) {…})` (default prototype kept). */
export const StructureSpawnSpawning: GameConstructor<StructureSpawnSpawning, [spawnId?: unknown]> =
  gameConstructor(
    StructureSpawnSpawningImpl,
    function (this: StructureSpawnSpawning, spawnId?: unknown): void {
      Object.defineProperty(this, 'spawn', {
        enumerable: false,
        value: Reflect.get(scope().register._objects, propertyKey(spawnId)),
      });
      this.name = getProp(rawObject(spawnId).spawning, 'name');
      this.needTime = getProp(rawObject(spawnId).spawning, 'needTime');
      this.remainingTime = jsSub(
        getProp(rawObject(spawnId).spawning, 'spawnTime'),
        scope().runtimeData.time,
      );
      this.directions = getProp(rawObject(spawnId).spawning, 'directions');
    },
    { name: '', length: 1, enumerableConstructor: false },
  );

/**
 * StructureSpawn
 */
class StructureSpawnImpl extends OwnedStructure {
  declare readonly name: string | undefined;
  declare readonly energy: number | undefined;
  declare readonly energyCapacity: number | null;
  declare readonly spawning: StructureSpawnSpawning | null;
  declare readonly store: Store;
  declare memory: unknown;

  override toString(): string {
    const raw = rawObject(this.id);
    return `[spawn ${raw.user == scope().runtimeData.user._id ? String(raw.name) : '#' + this.id}]`;
  }

  canCreateCreep(body: unknown, name?: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (rawObject(this.id).spawning) {
      return C.ERR_BUSY;
    }
    if (!body || !isArray(body) || body.length == 0 || body.length > C.MAX_CREEP_SIZE) {
      return C.ERR_INVALID_ARGS;
    }
    if (!isBody(body)) {
      return C.ERR_INVALID_ARGS;
    }

    if (roomOf(this, 'energyAvailable').energyAvailable < calcCreepCost(body)) {
      return C.ERR_NOT_ENOUGH_ENERGY;
    }

    const { runtimeData, globals } = scope();
    if (runtimeData.roomObjects[this.id]?.off) {
      return C.ERR_RCL_NOT_ENOUGH;
    }

    if (name) {
      name = callToString(name);
      if (
        Reflect.get(globals.Game.creeps, propertyKey(name)) ||
        createdCreepNames.indexOf(name) != -1
      ) {
        return C.ERR_NAME_EXISTS;
      }
      if (jsGt(getProp(name, 'length'), 100)) {
        return C.ERR_INVALID_ARGS;
      }
    }

    return C.OK;
  }

  createCreep(body: unknown, name?: unknown, creepMemory?: unknown): unknown {
    if (isObject(name) && isUndefined(creepMemory)) {
      creepMemory = name;
      name = undefined;
    }

    const canResult = this.canCreateCreep(body, name);
    if (canResult != C.OK) {
      return canResult;
    }

    const { runtimeData, intents } = scope();
    if (!name) {
      const user = rawObject(this.id).user;
      name = getUniqueName(
        (i) =>
          Object.values(runtimeData.roomObjects).some(
            (o) => o.type === 'creep' && o.user === user && o.name === i,
          ) || createdCreepNames.indexOf(i) != -1,
      );
    }

    createdCreepNames.push(name);

    const memory = creepsMemory();
    if (memory) {
      if (!isUndefined(creepMemory)) {
        Reflect.set(memory, propertyKey(name), creepMemory);
      } else {
        const existing: unknown = Reflect.get(memory, propertyKey(name));
        Reflect.set(memory, propertyKey(name), existing || {});
      }
    }

    makeSpawningCreep(this, name, body);

    intents.set(this.id, 'createCreep', { name, body });
    return name;
  }

  spawnCreep(body: unknown, name: unknown, options: unknown = {}): number {
    if (!name || !isObject(options)) {
      return C.ERR_INVALID_ARGS;
    }
    name = callToString(name);
    if (jsGt(getProp(name, 'length'), 100)) {
      return C.ERR_INVALID_ARGS;
    }

    const { runtimeData, intents, globals } = scope();
    if (
      Reflect.get(globals.Game.creeps, propertyKey(name)) ||
      createdCreepNames.indexOf(name) != -1
    ) {
      return C.ERR_NAME_EXISTS;
    }

    const energyStructuresOption: unknown = Reflect.get(options, 'energyStructures');
    const energyStructures = energyStructuresOption
      ? uniq(pluckIds(energyStructuresOption))
      : energyStructuresOption;

    let directions: unknown = Reflect.get(options, 'directions');
    if (directions !== undefined) {
      if (!isArray(directions)) {
        return C.ERR_INVALID_ARGS;
      }
      // convert directions to numbers, eliminate duplicates
      const numbers = uniq(Array.from(directions, (d) => toNumber(d)));
      // bail if any numbers are out of bounds or non-integers
      if (
        numbers.length == 0 ||
        !numbers.every(
          (direction) => direction >= 1 && direction <= 8 && direction === (direction | 0),
        )
      ) {
        return C.ERR_INVALID_ARGS;
      }
      directions = numbers;
    }

    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (rawObject(this.id).spawning) {
      return C.ERR_BUSY;
    }
    if (rawObject(this.id).off) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    if (!body || !isArray(body) || body.length === 0 || body.length > C.MAX_CREEP_SIZE) {
      return C.ERR_INVALID_ARGS;
    }
    if (!isBody(body)) {
      return C.ERR_INVALID_ARGS;
    }

    const energyAvailable = isArray(energyStructures)
      ? calcEnergyAvailable(runtimeData.roomObjects, energyStructures)
      : roomOf(this, 'energyAvailable').energyAvailable;
    if (energyAvailable < calcCreepCost(body)) {
      return C.ERR_NOT_ENOUGH_ENERGY;
    }

    if (Reflect.get(options, 'dryRun')) {
      return C.OK;
    }

    createdCreepNames.push(name);

    const memory = creepsMemory();
    if (memory) {
      const optionMemory: unknown = Reflect.get(options, 'memory');
      const existing: unknown = optionMemory || Reflect.get(memory, propertyKey(name));
      Reflect.set(memory, propertyKey(name), existing || {});
    }

    makeSpawningCreep(this, name, body);

    intents.set(this.id, 'createCreep', { name, body, energyStructures, directions });
    return C.OK;
  }

  override notifyWhenAttacked(enabled: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!isBoolean(enabled)) {
      return C.ERR_INVALID_ARGS;
    }
    if (enabled != rawObject(this.id).notifyWhenAttacked) {
      scope().intents.set(this.id, 'notifyWhenAttacked', { enabled });
    }
    return C.OK;
  }

  renewCreep(target: unknown): number {
    if (this.spawning) {
      return C.ERR_BUSY;
    }
    const { register, runtimeData, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      !lookupTarget(register.creeps, target) ||
      !(target instanceof Creep) ||
      target.spawning ||
      target.body.some((i) => i.type === C.CLAIM)
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    if (!this.my || !target.my) {
      return C.ERR_NOT_OWNER;
    }
    if (runtimeData.roomObjects[this.id]?.off) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    if (!target.pos.isNearTo(this.pos)) {
      return C.ERR_NOT_IN_RANGE;
    }
    if (
      roomOf(this, 'energyAvailable').energyAvailable <
      Math.ceil(
        (C.SPAWN_RENEW_RATIO * calcCreepCost(target.body)) /
          C.CREEP_SPAWN_TIME /
          target.body.length,
      )
    ) {
      return C.ERR_NOT_ENOUGH_ENERGY;
    }
    if (
      (target.ticksToLive ?? NaN) +
        Math.floor(
          (C.SPAWN_RENEW_RATIO * C.CREEP_LIFE_TIME) / C.CREEP_SPAWN_TIME / target.body.length,
        ) >
      C.CREEP_LIFE_TIME
    ) {
      return C.ERR_FULL;
    }
    if (target.body.some((i) => !!i.boost)) {
      register.deprecated(
        'Using `StructureSpawn.renewCreep` on a boosted creep is deprecated and will throw an error soon. Please remove boosts using `StructureLab.unboostCreep` before renewing.',
      );
    }

    intents.set(this.id, 'renewCreep', { id: target.id });
    return C.OK;
  }

  recycleCreep(target: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    const { register, runtimeData, intents } = scope();
    if (
      !target ||
      !getProp(target, 'id') ||
      !lookupTarget(register.creeps, target) ||
      !(target instanceof Creep) ||
      target.spawning
    ) {
      register.assertTargetObject(target);
      return C.ERR_INVALID_TARGET;
    }
    if (runtimeData.roomObjects[this.id]?.off) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    if (!target.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!target.pos.isNearTo(this.pos)) {
      return C.ERR_NOT_IN_RANGE;
    }

    intents.set(this.id, 'recycleCreep', { id: target.id });
    return C.OK;
  }
}
export type StructureSpawn = StructureSpawnImpl;
export const StructureSpawn: GameConstructor<StructureSpawn, [id?: unknown]> = gameConstructor(
  StructureSpawnImpl,
  callOwnedStructure,
  { name: '', length: 1, namedMethods: ['spawnCreep'] },
);
// Upstream `StructureSpawn.Spawning = …` (plain assignment).
Object.assign(StructureSpawn, { Spawning: StructureSpawnSpawning });
defineGameObjectProperties(StructureSpawn.prototype, rawObject, {
  name: (o) => o.name,
  energy: (o) => (o.store ? o.store.energy : 0),
  energyCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.energy || 0 : 0),
  spawning: (o, id) => (o.spawning ? new StructureSpawnSpawning(id) : null),
  store: storeGetter,
});

function spawnsMemory(): Record<string, unknown> | undefined {
  const spawns: unknown = memoryRoot().spawns;
  if (isUndefined(spawns) || spawns === 'undefined') {
    memoryRoot().spawns = {};
  }
  const value: unknown = memoryRoot().spawns;
  return isObject(value) ? (value as Record<string, unknown>) : undefined;
}

Object.defineProperty(StructureSpawn.prototype, 'memory', {
  get(this: StructureSpawn): unknown {
    if (!this.my) {
      return undefined;
    }
    const spawns = spawnsMemory();
    if (!spawns) {
      return undefined;
    }
    const name = String(rawObject(this.id).name);
    return (spawns[name] = spawns[name] || {});
  },
  set(this: StructureSpawn, value: unknown): void {
    if (!this.my) {
      throw new Error("Could not set other player's spawn memory");
    }
    const spawns = spawnsMemory();
    if (!spawns) {
      throw new Error('Could not set spawn memory');
    }
    spawns[String(rawObject(this.id).name)] = value;
  },
});

/**
 * StructureNuker
 */
class StructureNukerImpl extends OwnedStructure {
  declare readonly energy: number;
  declare readonly energyCapacity: number | null | undefined;
  declare readonly ghodium: number;
  declare readonly ghodiumCapacity: number | null | undefined;
  declare readonly cooldown: number;
  declare readonly store: Store;

  launchNuke(pos: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (!(pos instanceof RoomPosition)) {
      return C.ERR_INVALID_ARGS;
    }
    const { runtimeData, intents } = scope();
    const roomInfo = runtimeData.rooms[roomOf(this, 'name').name];
    if (!roomInfo) {
      throw readError('novice');
    }
    if (
      (roomInfo.novice ?? NaN) > Date.now() ||
      (roomInfo.respawnArea ?? NaN) > Date.now() ||
      !isUndefined(runtimeData.roomStatusData.novice[pos.roomName]) ||
      !isUndefined(runtimeData.roomStatusData.respawn[pos.roomName])
    ) {
      return C.ERR_INVALID_TARGET;
    }
    if (this.cooldown > 0) {
      return C.ERR_TIRED;
    }
    if (!activeAgainstController(this)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    const [tx, ty] = roomNameToXY(pos.roomName);
    const [x, y] = roomNameToXY(rawObject(this.id).room);

    if (Math.abs(tx - x) > C.NUKE_RANGE || Math.abs(ty - y) > C.NUKE_RANGE) {
      return C.ERR_NOT_IN_RANGE;
    }
    if (
      this.energy < (this.energyCapacity ?? NaN) ||
      this.ghodium < (this.ghodiumCapacity ?? NaN)
    ) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }

    intents.set(this.id, 'launchNuke', { roomName: pos.roomName, x: pos.x, y: pos.y });
    return C.OK;
  }
}
export type StructureNuker = StructureNukerImpl;
export const StructureNuker: GameConstructor<StructureNuker, [id?: unknown]> = gameConstructor(
  StructureNukerImpl,
  callOwnedStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureNuker.prototype, rawObject, {
  energy: (o) => (o.store ? o.store.energy || 0 : 0),
  energyCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.energy : 0),
  ghodium: (o) => (o.store ? o.store.G || 0 : 0),
  ghodiumCapacity: (o) => (o.storeCapacityResource ? o.storeCapacityResource.G : 0),
  cooldown: cooldownOf,
  store: storeGetter,
});

/**
 * StructurePortal
 */
export interface PortalShardDestination {
  shard: string;
  room: string;
}

class StructurePortalImpl extends Structure {
  declare readonly destination: PortalShardDestination | RoomPosition;
  declare readonly ticksToDecay: number | undefined;
}
export type StructurePortal = StructurePortalImpl;
export const StructurePortal: GameConstructor<StructurePortal, [id?: unknown]> = gameConstructor(
  StructurePortalImpl,
  callStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructurePortal.prototype, rawObject, {
  destination: (o) => {
    const destination = o.destination;
    if (!destination) {
      throw readError('shard');
    }
    if (destination.shard) {
      return { shard: destination.shard, room: destination.room };
    }
    return new RoomPosition(destination.x, destination.y, destination.room);
  },
  ticksToDecay: (o) =>
    o.decayTime
      ? typeof o.decayTime === 'number'
        ? o.decayTime - scope().runtimeData.time
        : NaN
      : undefined,
});

/**
 * StructureFactory
 */
class StructureFactoryImpl extends OwnedStructure {
  declare readonly level: number | undefined;
  declare readonly store: Store;
  declare readonly storeCapacity: number | null | undefined;
  declare readonly cooldown: number;

  produce(resourceType: unknown): number {
    if (!this.my) {
      return C.ERR_NOT_OWNER;
    }
    if (this.cooldown > 0) {
      return C.ERR_TIRED;
    }
    // Upstream re-reads `C.COMMODITIES[resourceType]` (inherited keys included) at every use.
    const commodity = (): unknown => Reflect.get(COMMODITIES, propertyKey(resourceType));
    if (!commodity()) {
      return C.ERR_INVALID_ARGS;
    }

    const { register, runtimeData, intents } = scope();
    const rawFactory = rawObject(this.id);
    if (
      !!getProp(commodity(), 'level') &&
      !looseEquals(getProp(commodity(), 'level'), rawFactory.level)
    ) {
      return C.ERR_INVALID_TARGET;
    }

    const controller = roomOf(this, 'controller').controller;
    if (!controller) {
      throw readError('id');
    }
    if (
      !checkStructureAgainstController(
        rawFactory,
        register.objectsByRoom[rawFactory.room] ?? EMPTY_ROOM_OBJECTS,
        rawObject(controller.id),
      )
    ) {
      return C.ERR_RCL_NOT_ENOUGH;
    }

    if (
      !!getProp(commodity(), 'level') &&
      (rawFactory.level ?? 0) > 0 &&
      !effectList(rawFactory.effects).some(
        (e) =>
          e.power == C.PWR_OPERATE_FACTORY &&
          looseEquals(e.level, getProp(commodity(), 'level')) &&
          e.endTime >= runtimeData.time,
      )
    ) {
      return C.ERR_BUSY;
    }

    const componentKeys = lodashKeys(getProp(commodity(), 'components'));
    if (
      componentKeys.some((p) =>
        jsLt(storeOf(rawFactory, p)[p] || 0, getProp(getProp(commodity(), 'components'), p)),
      )
    ) {
      return C.ERR_NOT_ENOUGH_RESOURCES;
    }

    if (!rawFactory.storeCapacity) {
      return C.ERR_FULL;
    }
    const components = getProp(commodity(), 'components');
    if (components === null || components === undefined) {
      // `utils.calcResources(object)` reads `object.store`
      getProp(components, 'store');
    }
    const amount: unknown = getProp(commodity(), 'amount');
    if (
      jsGt(
        jsAdd(calcResources(rawFactory) - calcResources(Object(components) as object), amount || 1),
        rawFactory.storeCapacity,
      )
    ) {
      return C.ERR_FULL;
    }

    intents.set(this.id, 'produce', { resourceType });
    return C.OK;
  }
}
export type StructureFactory = StructureFactoryImpl;
export const StructureFactory: GameConstructor<StructureFactory, [id?: unknown]> = gameConstructor(
  StructureFactoryImpl,
  callOwnedStructure,
  { name: '', length: 1 },
);
defineGameObjectProperties(StructureFactory.prototype, rawObject, {
  level: (o) => o.level,
  store: storeGetter,
  storeCapacity: (o) => o.storeCapacity,
  cooldown: cooldownOf,
});

/**
 * StructureInvaderCore
 */
class StructureInvaderCoreImpl extends OwnedStructure {
  declare readonly level: number | undefined;
  declare readonly spawning: StructureSpawnSpawning | null;
  declare readonly ticksToDeploy: number | undefined;

  override toString(): string {
    return `[invaderCore ${'#' + this.id}]`;
  }
}
export type StructureInvaderCore = StructureInvaderCoreImpl;
export const StructureInvaderCore: GameConstructor<StructureInvaderCore, [id?: unknown]> =
  gameConstructor(StructureInvaderCoreImpl, callOwnedStructure, { name: '', length: 1 });
defineGameObjectProperties(StructureInvaderCore.prototype, rawObject, {
  level: (o) => o.level,
  spawning: (o, id) => (o.spawning ? new StructureSpawnSpawning(id) : null),
  ticksToDeploy: (o) => (o.deployTime ? o.deployTime - scope().runtimeData.time : undefined),
});

/** Per-tick reset; exposes the structure globals on the first call per sandbox (upstream order). */
export function make(): void {
  createdCreepNames = [];
  lastActivateSafeMode = null;

  if (scope().globals.Structure) {
    return;
  }

  exposeGlobal('Structure', Structure);
  exposeGlobal('OwnedStructure', OwnedStructure);
  exposeGlobal('StructureContainer', StructureContainer);
  exposeGlobal('StructureController', StructureController);
  exposeGlobal('StructureExtension', StructureExtension);
  exposeGlobal('StructureExtractor', StructureExtractor);
  exposeGlobal('StructureKeeperLair', StructureKeeperLair);
  exposeGlobal('StructureLab', StructureLab);
  exposeGlobal('StructureLink', StructureLink);
  exposeGlobal('StructureObserver', StructureObserver);
  exposeGlobal('StructurePowerBank', StructurePowerBank);
  exposeGlobal('StructurePowerSpawn', StructurePowerSpawn);
  exposeGlobal('StructureRampart', StructureRampart);
  exposeGlobal('StructureRoad', StructureRoad);
  exposeGlobal('StructureStorage', StructureStorage);
  exposeGlobal('StructureTerminal', StructureTerminal);
  exposeGlobal('StructureTower', StructureTower);
  exposeGlobal('StructureWall', StructureWall);
  exposeGlobal('StructureSpawn', StructureSpawn);
  exposeGlobal('Spawn', StructureSpawn);
  exposeGlobal('StructureNuker', StructureNuker);
  exposeGlobal('StructurePortal', StructurePortal);
  exposeGlobal('StructureFactory', StructureFactory);
  exposeGlobal('StructureInvaderCore', StructureInvaderCore);
}
