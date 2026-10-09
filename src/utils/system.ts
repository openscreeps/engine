/*
 * Ported from @screeps/common lib/system.js and @screeps/engine src/utils.js (`storeIntents`).
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import type { BodyPartConstant } from '../types/index.ts';
import { isObject } from './lodash.ts';
import { getProp } from './tables.ts';

/** One raw intent payload as recorded by the player runtime (untrusted values). */
export type RawIntent = Readonly<Record<string, unknown>>;

/** ECMAScript OrdinaryToPrimitive/ToPrimitive with the `default` hint (what `'' + value` applies). */
function toPrimitiveDefault(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }
  const exotic: unknown = Reflect.get(value, Symbol.toPrimitive);
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== 'function') {
      throw new TypeError('Symbol.toPrimitive is not a function');
    }
    const result: unknown = Reflect.apply(exotic, value, ['default']);
    if (isObject(result)) {
      throw new TypeError('Cannot convert object to primitive value');
    }
    return result;
  }
  for (const method of ['valueOf', 'toString']) {
    const fn: unknown = Reflect.get(value, method);
    if (typeof fn === 'function') {
      const result: unknown = Reflect.apply(fn, value, []);
      if (!isObject(result)) {
        return result;
      }
    }
  }
  throw new TypeError('Cannot convert object to primitive value');
}

/** JS `"" + value`, which upstream used for string coercion (default-hint ToPrimitive, then ToString). */
function concatString(value: unknown): string {
  const primitive = toPrimitiveDefault(value);
  switch (typeof primitive) {
    case 'string':
      return primitive;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(primitive);
    case 'undefined':
      return 'undefined';
    case 'symbol':
      throw new TypeError('Cannot convert a Symbol value to a string');
    default:
      // Only `null` remains: functions and objects were converted to primitives above.
      return 'null';
  }
}

/** JS `parseInt(value)` on an arbitrary value (ToString, then parse). */
function parseIntValue(value: unknown): number {
  const operand = value as string;
  return parseInt(operand);
}

/** Elements visited by lodash 3 `_.filter` for an arbitrary collection value. */
function filterSource(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value as unknown[];
  }
  if (typeof value === 'string') {
    return Array.from({ length: value.length }, (_unused, index) => value[index]);
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (
    'length' in value &&
    typeof value.length === 'number' &&
    value.length > -1 &&
    value.length % 1 === 0
  ) {
    const arrayLike: ArrayLike<unknown> = value as ArrayLike<unknown>;
    return Array.from(arrayLike);
  }
  return Object.values(value);
}

function isBodyPart(value: unknown): value is BodyPartConstant {
  return (C.BODYPARTS_ALL as readonly unknown[]).includes(value);
}

/** Output type of each field coercion. */
export interface TransformResults {
  string: string;
  number: number;
  boolean: boolean;
  price: number;
  'string[]': string[] | undefined;
  'number[]': number[] | undefined;
  'bodypart[]': BodyPartConstant[];
  userString: string;
  userText: string;
}

export type TransformName = keyof TransformResults;
export type TransformResult<T extends TransformName> = TransformResults[T];

/** Field coercions applied to every intent field (exactly upstream's `transforms`). */
export const transforms: {
  readonly [K in TransformName]: (value: unknown) => TransformResults[K];
} = {
  string: (value: unknown): string => concatString(value),
  number: (value: unknown): number => parseIntValue(value),
  boolean: (value: unknown): boolean => !!value,
  price: (value: unknown): number => {
    const operand = value as number;
    return parseInt((1000 * operand).toFixed(0));
  },
  'string[]': (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.map((i: unknown) => concatString(i)) : undefined,
  'number[]': (value: unknown): number[] | undefined =>
    Array.isArray(value) ? value.map((i: unknown) => parseIntValue(i)) : undefined,
  'bodypart[]': (value: unknown): BodyPartConstant[] => filterSource(value).filter(isBodyPart),
  userString: (value: unknown): string => concatString(value || '').substring(0, 100),
  userText: (value: unknown): string => concatString(value || '').substring(0, 1000),
};

export type IntentSchema = Readonly<Record<string, TransformName>>;
export type IntentSchemas = Readonly<Record<string, IntentSchema>>;

/** Fields and coercions of every built-in intent. */
export const intentTypes = {
  notify: { message: 'userText', groupInterval: 'number' },
  createConstructionSite: {
    roomName: 'string',
    x: 'number',
    y: 'number',
    structureType: 'string',
    name: 'userString',
  },
  createFlag: {
    roomName: 'string',
    x: 'number',
    y: 'number',
    name: 'userString',
    color: 'number',
    secondaryColor: 'number',
  },
  destroyStructure: { roomName: 'string', id: 'string' },
  removeConstructionSite: { roomName: 'string', id: 'string' },
  removeFlag: { roomName: 'string', name: 'userString' },
  cancelOrder: { orderId: 'string' },
  changeOrderPrice: { orderId: 'string', newPrice: 'price' },
  createOrder: {
    type: 'string',
    resourceType: 'string',
    price: 'price',
    totalAmount: 'number',
    roomName: 'string',
  },
  createPowerCreep: { name: 'userString', className: 'string' },
  deal: { orderId: 'string', amount: 'number', targetRoomName: 'string' },
  deletePowerCreep: { id: 'string', cancel: 'boolean' },
  extendOrder: { orderId: 'string', addAmount: 'number' },
  renamePowerCreep: { id: 'string', name: 'userString' },
  spawnPowerCreep: { id: 'string', name: 'userString' },
  suicidePowerCreep: { id: 'string' },
  upgradePowerCreep: { id: 'string', power: 'number' },
  activateSafeMode: {},
  attack: { id: 'string', x: 'number', y: 'number' },
  attackController: { id: 'string' },
  boostCreep: { id: 'string', bodyPartsCount: 'number' },
  build: { id: 'string', x: 'number', y: 'number' },
  cancelSpawning: {},
  claimController: { id: 'string' },
  createCreep: {
    name: 'userString',
    body: 'bodypart[]',
    energyStructures: 'string[]',
    directions: 'number[]',
  },
  destroy: {},
  dismantle: { id: 'string' },
  drop: { amount: 'number', resourceType: 'string' },
  enableRoom: { id: 'string' },
  generateSafeMode: { id: 'string' },
  harvest: { id: 'string' },
  heal: { id: 'string', x: 'number', y: 'number' },
  launchNuke: { x: 'number', y: 'number', roomName: 'string' },
  move: { id: 'string', direction: 'number' },
  notifyWhenAttacked: { enabled: 'boolean' },
  observeRoom: { roomName: 'string' },
  pickup: { id: 'string' },
  processPower: {},
  produce: { resourceType: 'string', amount: 'number' },
  pull: { id: 'string' },
  rangedAttack: { id: 'string' },
  rangedHeal: { id: 'string' },
  rangedMassAttack: {},
  recycleCreep: { id: 'string' },
  renew: { id: 'string' },
  renewCreep: { id: 'string' },
  reverseReaction: { lab1: 'string', lab2: 'string' },
  runReaction: { lab1: 'string', lab2: 'string' },
  remove: {},
  repair: { id: 'string', x: 'number', y: 'number' },
  reserveController: { id: 'string' },
  say: { message: 'userString', isPublic: 'boolean' },
  send: {
    targetRoomName: 'string',
    resourceType: 'string',
    amount: 'number',
    description: 'userString',
  },
  setColor: { color: 'number', secondaryColor: 'number' },
  setPosition: { x: 'number', y: 'number', roomName: 'string' },
  setPublic: { isPublic: 'boolean' },
  setSpawnDirections: { directions: 'number[]' },
  signController: { id: 'string', sign: 'userString' },
  suicide: {},
  transfer: { id: 'string', amount: 'number', resourceType: 'string' },
  unboostCreep: { id: 'string' },
  unclaim: {},
  upgradeController: { id: 'string' },
  usePower: { power: 'number', id: 'string' },
  withdraw: { id: 'string', amount: 'number', resourceType: 'string' },
} as const satisfies IntentSchemas;

export type IntentTypes = typeof intentTypes;
export type IntentName = keyof IntentTypes;

/** Sanitized payload of a built-in intent. Note `number` fields may be `NaN` (upstream `parseInt`). */
export type SanitizedIntent<N extends IntentName> = {
  -readonly [F in keyof IntentTypes[N]]: IntentTypes[N][F] extends TransformName
    ? TransformResult<IntentTypes[N][F]>
    : never;
};

/** Sanitized payload of a custom (mod-defined) intent. */
export type SanitizedCustomIntent = Record<string, TransformResult<TransformName>>;

/** Intents attached to a single object (one payload per intent name). */
export type ObjectIntents = { [N in IntentName]?: SanitizedIntent<N> } & {
  readonly [customIntent: string]: unknown;
};

/** Room-level intents (`room` bucket): every intent name may carry a list. */
export type RoomIntents = { [N in IntentName]?: SanitizedIntent<N>[] } & {
  readonly [customIntent: string]: unknown;
};

/** Global intents (market, power creeps): every intent name may carry a list. */
export type GlobalIntents = RoomIntents;

/** Result of {@link sanitizeUserIntents}: arrays stay arrays, single payloads stay single. */
export type SanitizedIntentMap = Record<string, SanitizedCustomIntent | SanitizedCustomIntent[]>;

/** Per-room intents in upstream key order: object ids and the special `room` key interleaved. */
export type StoredRoomIntents = Record<string, ObjectIntents | RoomIntents>;

export interface StoredUserIntents {
  /** roomName -> objectId | 'room' -> intents (insertion order preserved). */
  rooms: Record<string, StoredRoomIntents>;
  notify?: SanitizedIntent<'notify'>[];
  global?: GlobalIntents;
}

/** Strict-mode JS `target[key] = value` on an arbitrary value. */
function setProp(target: unknown, key: PropertyKey, value: unknown): void {
  if (target === null || target === undefined) {
    throw new TypeError(`Cannot set properties of ${String(target)} (setting '${String(key)}')`);
  }
  if (!isObject(target)) {
    throw new TypeError(`Cannot create property '${String(key)}' on ${typeof target}`);
  }
  if (!Reflect.set(target, key, value)) {
    throw new TypeError(`Cannot assign to read only property '${String(key)}' of object`);
  }
}

/** JS `target[method](...args)` on an arbitrary value. */
function callMethod(target: unknown, method: string, args: unknown[]): unknown {
  const fn = getProp(target, method);
  if (typeof fn !== 'function') {
    throw new TypeError(`${method} is not a function`);
  }
  const result: unknown = Reflect.apply(fn, target, args);
  return result;
}

/** Coerces one intent payload according to its schema (unknown intents yield `{}`). */
export function sanitizeIntent(
  name: string,
  intent: unknown,
  customIntentTypes: IntentSchemas = {},
): SanitizedCustomIntent {
  const result: SanitizedCustomIntent = {};
  // Upstream: `intentTypes[name] || customIntentTypes[name]`, then `for (field in intentType)`.
  const intentType = getProp(intentTypes, name) || getProp(customIntentTypes, name);
  // `for...in` over null/undefined/primitives visits nothing, as `Object(x)` of them has no enumerable keys.
  const schema = Object(intentType) as object;
  for (const field in schema) {
    // `transforms[intentType[field]](intent[field])`: callee, then argument, then the callable check.
    const transformKey = getProp(schema, field);
    const transform = getProp(
      transforms,
      typeof transformKey === 'symbol' ? transformKey : String(transformKey),
    );
    const argument = getProp(intent, field);
    if (typeof transform !== 'function') {
      throw new TypeError('transforms[intentType[field]] is not a function');
    }
    const value: unknown = Reflect.apply(transform, transforms, [argument]);
    // Schema-listed transforms yield TransformResults; inherited members are invoked as upstream did.
    result[field] = value as TransformResult<TransformName>;
  }
  return result;
}

/** Sanitizes every known intent present in `input`; array values are sanitized element-wise. */
export function sanitizeUserIntents(
  input: Readonly<Record<string, unknown>>,
  customIntentTypes: IntentSchemas = {},
): SanitizedIntentMap {
  const intentResult: SanitizedIntentMap = {};
  for (const name of Object.keys(intentTypes)) {
    const value = input[name];
    if (value) {
      intentResult[name] = Array.isArray(value)
        ? value.map((i: unknown) => sanitizeIntent(name, i))
        : sanitizeIntent(name, value, customIntentTypes);
    }
  }
  for (const name of Object.keys(customIntentTypes)) {
    const value = input[name];
    if (value) {
      intentResult[name] = Array.isArray(value)
        ? value.map((i: unknown) => sanitizeIntent(name, i, customIntentTypes))
        : sanitizeIntent(name, value, customIntentTypes);
    }
  }
  return intentResult;
}

function iterateIntentList(value: unknown, name: string): Iterable<unknown> {
  // `for...of` semantics: strings iterate their characters, objects/functions need `Symbol.iterator`.
  if (typeof value === 'string') {
    return value;
  }
  if (isObject(value) && Symbol.iterator in value) {
    // `for...of` itself throws if the `Symbol.iterator` member is not a valid iterator factory.
    const iterable: Iterable<unknown> = value as Iterable<unknown>;
    return iterable;
  }
  throw new TypeError(`input[${name}] is not iterable`);
}

/**
 * Sanitizes room-level intent lists and groups them by `groupingField` (the target room name) into
 * `rooms[groupValue].room[intentName]`.
 */
export function sanitizeUserRoomIntents(
  input: Readonly<Record<string, unknown>>,
  rooms: Record<string, StoredRoomIntents>,
  customIntentTypes: IntentSchemas = {},
  groupingField = 'roomName',
): void {
  const store = (name: string, sanitized: SanitizedCustomIntent): void => {
    // Upstream: `(result[g] = result[g] || {}).room = ... || {}`, then `(room[name] = room[name] || []).push(x)`.
    const groupingValue = String(sanitized[groupingField]);
    const roomNameResult = getProp(rooms, groupingValue) || {};
    setProp(rooms, groupingValue, roomNameResult);
    const roomResult = getProp(roomNameResult, 'room') || {};
    setProp(roomNameResult, 'room', roomResult);
    const list = getProp(roomResult, name) || [];
    setProp(roomResult, name, list);
    callMethod(list, 'push', [sanitized]);
  };
  for (const name of Object.keys(intentTypes)) {
    const value = input[name];
    if (value) {
      for (const intent of iterateIntentList(value, name)) {
        store(name, sanitizeIntent(name, intent));
      }
    }
  }
  for (const name of Object.keys(customIntentTypes)) {
    const value = input[name];
    if (value) {
      for (const intent of iterateIntentList(value, name)) {
        store(name, sanitizeIntent(name, intent, customIntentTypes));
      }
    }
  }
}

function asRecord(value: unknown, key: string): Readonly<Record<string, unknown>> {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${String(value)} (intents '${key}')`);
  }
  const record: Readonly<Record<string, unknown>> = Object(value) as Readonly<
    Record<string, unknown>
  >;
  return record;
}

/**
 * Converts the raw per-user intents list recorded by the player runtime into the stored per-room form.
 *
 * `list` keys are, in recording order: object ids (`{intentName: payload}`), `room`
 * (`{intentName: payload[]}`), `global` (`{intentName: payload[]}`) and `notify` (`payload[]`).
 * `lookupRoom` resolves an object id to the room it is in (user objects first, then room objects);
 * ids it cannot resolve are dropped. Object intent payloads must be single objects (as recorded by the
 * runtime's `intents.set`); list-valued object intents are dropped.
 */
export function storeIntents(
  list: Readonly<Record<string, unknown>>,
  lookupRoom: (objectId: string) => string | undefined,
  customIntentTypes: IntentSchemas = {},
): StoredUserIntents {
  const intents: StoredUserIntents = { rooms: {} };

  for (const key of Object.keys(list)) {
    const value = list[key];

    if (key === 'notify') {
      const notify = sanitizeUserIntents({ notify: value }).notify;
      if (Array.isArray(notify)) {
        // Built-in `notify` schema guarantees the sanitized shape.
        intents.notify = notify as SanitizedIntent<'notify'>[];
      } else if (notify) {
        intents.notify = [notify as SanitizedIntent<'notify'>];
      }
      continue;
    }

    if (key === 'room') {
      sanitizeUserRoomIntents(asRecord(value, key), intents.rooms, customIntentTypes);
      continue;
    }

    if (key === 'global') {
      intents.global = sanitizeUserIntents(asRecord(value, key), customIntentTypes);
      continue;
    }

    const roomName = lookupRoom(key);
    if (roomName === undefined) {
      continue;
    }
    const raw = asRecord(value, key);
    const objectIntents: Record<string, SanitizedCustomIntent> = {};
    for (const name of [...Object.keys(intentTypes), ...Object.keys(customIntentTypes)]) {
      const payload = raw[name];
      if (payload && !Array.isArray(payload)) {
        objectIntents[name] = sanitizeIntent(name, payload, customIntentTypes);
      }
    }
    // Upstream: `intents[room] = intents[room] || {}; intents[room][id] = ...`.
    const roomBucket = getProp(intents.rooms, roomName) || {};
    setProp(intents.rooms, roomName, roomBucket);
    setProp(roomBucket, key, objectIntents);
  }

  return intents;
}

/**
 * Walks a room's stored intents in upstream order, dispatching the `room` bucket and object buckets
 * with their precise types.
 */
export function forEachRoomIntents(
  roomIntents: StoredRoomIntents,
  onRoom: (intents: RoomIntents) => void,
  onObject: (objectId: string, intents: ObjectIntents) => void,
): void {
  for (const [key, value] of Object.entries(roomIntents)) {
    if (key === 'room') {
      // The `room` key is only ever written by sanitizeUserRoomIntents.
      onRoom(value as RoomIntents);
    } else {
      onObject(key, value as ObjectIntents);
    }
  }
}
