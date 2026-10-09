/*
 * Server-mod object prototypes (screeps/engine `src/game/custom-prototypes.js`, driver
 * `registerCustomObjectPrototype` and `runtime.js` source evaluation).
 *
 * Portions derived from screeps/engine and screeps/driver, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as engineUtils from '../../utils/index.ts';
import { getProp } from '../../utils/tables.ts';
import { jsSetSloppy, sloppyThis } from './compat.ts';
import { defineGameObjectProperties } from './define.ts';
import { RoomObject } from './room-object.ts';
import type { CustomObjectPrototype, RawRoomObject } from './runtime-data.ts';
import { rawObject, scope, username } from './scope.ts';

/** Upstream `utils` handed to prototype extenders. */
const extenderUtils: Readonly<Record<string, unknown>> = {
  ...engineUtils,
  defineGameObjectProperties,
};

export type CustomObjectConstructor = new (id: string) => RoomObject;

export interface CustomObjectInfo {
  name: string;
  ctor: CustomObjectConstructor;
  findConstant: number | undefined;
  lookConstant: string | undefined;
}

const compiled: Record<string, CustomObjectInfo> = {};

/** Driver `runtime.js`: `eval('(' + source + ')')` of mod-supplied function source. */
function evaluateFunction(source: string, label: string): (...args: unknown[]) => unknown {
  const evaluate: unknown = Reflect.get(globalThis, 'eval');
  if (typeof evaluate !== 'function') {
    throw new Error('eval is not available in this sandbox');
  }
  const text = source.startsWith('prototypeExtender') ? `function ${source}` : source;
  const fn: unknown = Reflect.apply(evaluate, undefined, [`(${text})`]);
  if (typeof fn !== 'function') {
    throw new TypeError(`Custom prototype ${label} is not a function`);
  }
  return (...args: unknown[]): unknown => Reflect.apply(fn, undefined, args);
}

function makeCustomObject(info: CustomObjectPrototype): CustomObjectInfo {
  const { name, opts } = info;
  const parent = opts.parent;
  const parentPrototype: unknown =
    parent === undefined ? RoomObject.prototype : getProp(scope().globals[parent], 'prototype');
  // Upstream `register.wrapFn(function (id) {…})`: a sloppy plain function usable with `new` or `.call`.
  const ctor = function (this: unknown, id: unknown): void {
    const self = sloppyThis(this);
    const data = rawObject(id);
    if (parent !== undefined) {
      const parentCtor: unknown = scope().globals[parent];
      const call: unknown = getProp(parentCtor, 'call');
      if (typeof call !== 'function') {
        throw new TypeError('scope.globals[parent].call is not a function');
      }
      Reflect.apply(call, parentCtor, [self, id]);
    } else {
      RoomObject.call(self, data.x, data.y, data.room);
    }
    jsSetSloppy(self, 'id', id);
  } as unknown as CustomObjectConstructor;
  Object.defineProperty(ctor, 'name', { value: '', configurable: true });
  const proto = Object.create(parentPrototype as object | null) as RoomObject;
  Object.defineProperty(ctor, 'prototype', { value: proto, writable: true });
  // Upstream assigns `prototype.constructor` explicitly (enumerable).
  Reflect.set(proto, 'constructor', ctor);

  if (opts.properties) {
    const getters: Record<string, (o: RawRoomObject, id: unknown) => unknown> = {};
    for (const [key, source] of Object.entries(opts.properties)) {
      const fn = evaluateFunction(source, `${name}.${key}`);
      getters[key] = (o, id) => fn(o, id);
    }
    defineGameObjectProperties(proto, rawObject, getters);
  }
  if (opts.userOwned) {
    const ownership: Record<string, (o: RawRoomObject) => unknown> = {
      my: (o) => o.user == scope().runtimeData.user._id,
      owner: (o) => ({ username: username(String(o.user)) }),
    };
    defineGameObjectProperties(proto, rawObject, ownership);
  }
  if (opts.prototypeExtender) {
    evaluateFunction(opts.prototypeExtender, `${name}.prototypeExtender`)(proto, scope(), {
      utils: extenderUtils,
    });
  }
  Object.defineProperty(scope().globals, name, {
    value: ctor,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return { name, ctor, findConstant: opts.findConstant, lookConstant: opts.lookConstant };
}

/**
 * Creates (once per sandbox, like upstream's `if (globals[name]) return`) the classes for every
 * custom prototype and returns them by object type.
 */
export function makeCustomPrototypes(
  prototypes: readonly CustomObjectPrototype[],
): Record<string, CustomObjectInfo> {
  const result: Record<string, CustomObjectInfo> = {};
  for (const info of prototypes) {
    const made = compiled[info.name] ?? makeCustomObject(info);
    compiled[info.name] = made;
    result[info.objectType] = made;
  }
  return result;
}
