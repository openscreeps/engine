/*
 * Per-sandbox game API state. Every player sandbox (isolate or trusted context) evaluates its own copy
 * of the runtime bundle, so this module state is private to one player — the equivalent of the module
 * variables (`runtimeData`, `intents`, `register`, `globals`) shared by screeps/engine `src/game/*.js`.
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { jsConcat, jsString } from '../../utils/js.ts';
import { isObject, isString } from '../../utils/lodash.ts';
import { getProp } from '../../utils/tables.ts';
import { isPlainObject, isUndefined, jsSetSloppy } from './compat.ts';
import type { IntentRecorder } from './intents.ts';
import type { RawRoomObject, SandboxRuntimeData } from './runtime-data.ts';
import type { EventLogEntry } from '../../simulation/state.ts';
import type { ConstructionSite } from './construction-sites.ts';
import type { Creep } from './creeps.ts';
import type { Deposit } from './deposits.ts';
import type { Flag } from './flags.ts';
import type { GameMap } from './map.ts';
import type { GameMarket } from './market.ts';
import type { Mineral } from './minerals.ts';
import type { Nuke } from './nukes.ts';
import type { PowerCreep } from './power-creeps.ts';
import type { Resource } from './resources.ts';
import type { RoomObject } from './room-object.ts';
import type { Room } from './rooms.ts';
import type { RoomPosition } from './room-position.ts';
import type { Ruin } from './ruins.ts';
import type { Source } from './sources.ts';
import type { OwnedStructure, Structure, StructureSpawn } from './structures.ts';
import type { Tombstone } from './tombstones.ts';
import type { SandboxConsole } from './console.ts';
import type { GameObject, RawMemory, RequireFunction } from './game.ts';

/** Object registries shared by the global register and every per-room register. */
export interface ObjectRegistries {
  creeps: Record<string, Creep>;
  structures: Record<string, Structure>;
  ownedStructures: Record<string, OwnedStructure>;
  spawns: Record<string, StructureSpawn>;
  sources: Record<string, Source>;
  energy: Record<string, Resource>;
  flags: Record<string, Flag>;
  constructionSites: Record<string, ConstructionSite>;
  minerals: Record<string, Mineral>;
  deposits: Record<string, Deposit>;
  tombstones: Record<string, Tombstone>;
  nukes: Record<string, Nuke>;
  powerCreeps: Record<string, PowerCreep>;
  ruins: Record<string, Ruin>;
  customObjects: Record<string, RoomObject>;
}

export type RegistryKey = keyof ObjectRegistries;

/** Objects stored at `x * 50 + y` (sparse; `undefined` where nothing is registered). */
export type SpatialRegistries = {
  [K in RegistryKey]: Array<Array<ObjectRegistries[K][string]> | undefined>;
};

export interface RoomRegister extends ObjectRegistries {
  spatial: SpatialRegistries;
  /** Custom object registries keyed by their `lookConstant` (upstream `reg[lookConstant]`). */
  custom: Record<string, Record<string, RoomObject>>;
  /** Spatial custom registries keyed by `lookConstant` (upstream `reg.spatial[lookConstant]`). */
  customSpatial: Record<string, Array<RoomObject[] | undefined>>;
}

export const REGISTRY_KEYS: readonly RegistryKey[] = [
  'creeps',
  'structures',
  'ownedStructures',
  'spawns',
  'sources',
  'energy',
  'flags',
  'constructionSites',
  'minerals',
  'deposits',
  'tombstones',
  'nukes',
  'powerCreeps',
  'ruins',
  'customObjects',
];

export function createObjectRegistries(): ObjectRegistries {
  return {
    creeps: {},
    structures: {},
    ownedStructures: {},
    spawns: {},
    sources: {},
    energy: {},
    flags: {},
    constructionSites: {},
    minerals: {},
    deposits: {},
    tombstones: {},
    nukes: {},
    powerCreeps: {},
    ruins: {},
    customObjects: {},
  };
}

export function createRoomRegister(lookConstants: readonly string[]): RoomRegister {
  const spatial: SpatialRegistries = {
    creeps: new Array<Creep[] | undefined>(2500),
    structures: new Array<Structure[] | undefined>(2500),
    ownedStructures: new Array<OwnedStructure[] | undefined>(2500),
    spawns: new Array<StructureSpawn[] | undefined>(2500),
    sources: new Array<Source[] | undefined>(2500),
    energy: new Array<Resource[] | undefined>(2500),
    flags: new Array<Flag[] | undefined>(2500),
    constructionSites: new Array<ConstructionSite[] | undefined>(2500),
    minerals: new Array<Mineral[] | undefined>(2500),
    deposits: new Array<Deposit[] | undefined>(2500),
    tombstones: new Array<Tombstone[] | undefined>(2500),
    nukes: new Array<Nuke[] | undefined>(2500),
    powerCreeps: new Array<PowerCreep[] | undefined>(2500),
    ruins: new Array<Ruin[] | undefined>(2500),
    customObjects: new Array<RoomObject[] | undefined>(2500),
  };
  const custom: Record<string, Record<string, RoomObject>> = {};
  const customSpatial: Record<string, Array<RoomObject[] | undefined>> = {};
  for (const lookConstant of lookConstants) {
    custom[lookConstant] = {};
    customSpatial[lookConstant] = new Array<RoomObject[] | undefined>(2500);
  }
  return { ...createObjectRegistries(), spatial, custom, customSpatial };
}

/**
 * The upstream `register`: object registries, per-room registries, find caches and helpers.
 * `map` and `market` become available once `Game` construction reaches them.
 */
export class Register implements ObjectRegistries {
  _useNewPathFinder = true;
  readonly _objects: Record<string, RoomObject> = {};
  readonly byRoom: Record<string, RoomRegister> = {};
  /** Find cache: FIND_* constant → room name → objects (exit positions for FIND_EXIT_*). */
  readonly findCache: Record<number, Record<string, Array<RoomObject | RoomPosition>>> = {};
  readonly rooms: Record<string, Room> = {};
  readonly roomEventLogCache: Record<string, EventLogEntry[]> = {};
  /** Non-temporary raw objects per room keyed by id. */
  readonly objectsByRoom: Record<string, Record<string, RawRoomObject>> = {};
  readonly objectsByRoomKeys: Record<string, string[]> = {};

  creeps: Record<string, Creep> = {};
  structures: Record<string, Structure> = {};
  ownedStructures: Record<string, OwnedStructure> = {};
  spawns: Record<string, StructureSpawn> = {};
  sources: Record<string, Source> = {};
  energy: Record<string, Resource> = {};
  flags: Record<string, Flag> = {};
  constructionSites: Record<string, ConstructionSite> = {};
  minerals: Record<string, Mineral> = {};
  deposits: Record<string, Deposit> = {};
  tombstones: Record<string, Tombstone> = {};
  nukes: Record<string, Nuke> = {};
  powerCreeps: Record<string, PowerCreep> = {};
  ruins: Record<string, Ruin> = {};
  customObjects: Record<string, RoomObject> = {};
  /** Custom object registries keyed by `lookConstant`. */
  readonly custom: Record<string, Record<string, RoomObject>> = {};

  #map: GameMap | undefined;
  #market: GameMarket | undefined;
  readonly #deprecatedShown: string[] = [];
  readonly #log: (message: string) => void;

  constructor(log: (message: string) => void) {
    this.#log = log;
  }

  get map(): GameMap {
    if (!this.#map) {
      throw new Error('Game.map is not initialized yet');
    }
    return this.#map;
  }

  set map(value: GameMap) {
    this.#map = value;
  }

  get market(): GameMarket {
    if (!this.#market) {
      throw new Error('Game.market is not initialized yet');
    }
    return this.#market;
  }

  set market(value: GameMarket) {
    this.#market = value;
  }

  /** Logs a deprecation message once per tick. */
  deprecated(message: string): void {
    if (!this.#deprecatedShown.includes(message)) {
      this.#deprecatedShown.push(message);
      this.#log(message);
    }
  }

  /** Throws when a plain object looking like a serialized game object is used as a target. */
  assertTargetObject(obj: unknown): void {
    if (obj && isPlainObject(obj) && isString(obj.id) && obj.id.length == 24) {
      throw new Error(
        "It seems you're trying to use a serialized game object stored in Memory which is not allowed. Please use `Game.getObjectById` to retrieve a live object reference instead.",
      );
    }
  }
}

/**
 * The sandbox global object (`global`) as seen by the game API. Constants and player-defined
 * globals are reachable through the index signature.
 */
export interface SandboxGlobals {
  [key: string]: unknown;
  Game: GameObject;
  /** Lazily parsed memory root; `null` when the stored memory is not valid JSON. */
  Memory: unknown;
  RawMemory: RawMemory;
  console: SandboxConsole;
  require: RequireFunction;
  _: unknown;
}

export interface GameScope {
  runtimeData: SandboxRuntimeData;
  intents: IntentRecorder;
  register: Register;
  globals: SandboxGlobals;
}

let current: GameScope | undefined;

/** The scope of the tick being executed in this sandbox. */
export function scope(): GameScope {
  if (!current) {
    throw new Error('The game API is not initialized');
  }
  return current;
}

export function setScope(value: GameScope): void {
  current = value;
}

/**
 * Upstream's sloppy-mode `if(_.isUndefined(globals.Memory[key]) || globals.Memory[key] === 'undefined')
 * globals.Memory[key] = {};` followed by its `_.isObject(globals.Memory[key])` guard. Every read goes
 * through `globals.Memory` again (lazy parse); null/undefined roots throw the property-access
 * TypeError and primitive roots silently drop the assignment, exactly like upstream. The
 * `'undefined'` string reset is skipped by spawn's creep-memory initialization.
 */
export function prepareMemorySection(
  key: 'creeps' | 'rooms' | 'spawns',
  resetUndefinedString: boolean,
): boolean {
  const { globals } = scope();
  if (
    isUndefined(getProp(globals.Memory, key)) ||
    (resetUndefinedString && getProp(globals.Memory, key) === 'undefined')
  ) {
    jsSetSloppy(globals.Memory, key, {});
  }
  return isObject(getProp(globals.Memory, key));
}

/** Raw room object by id (`runtimeData.roomObjects[id]`), throwing like upstream `data(id)`. */
export function rawObject(id: unknown): RawRoomObject {
  const key: PropertyKey = typeof id === 'symbol' ? id : jsString(id);
  // Upstream indexes the plain object directly (inherited keys included).
  const object: unknown = Reflect.get(scope().runtimeData.roomObjects, key);
  if (!object) {
    throw new Error('Could not find an object with ID ' + jsConcat(id));
  }
  return object as RawRoomObject;
}

/** Username of a user referenced by visible data. */
export function username(userId: string): string {
  const user = scope().runtimeData.users[userId];
  if (!user) {
    throw new TypeError(`Cannot read properties of undefined (reading 'username')`);
  }
  return user.username;
}
