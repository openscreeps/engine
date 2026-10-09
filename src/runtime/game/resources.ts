/*
 * Resource, a dropped resource pile (screeps/engine `src/game/resources.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import {
  defineGameObjectProperties,
  exposeGlobal,
  gameConstructor,
  type GameConstructor,
} from './define.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { RoomObject } from './room-object.ts';
import { rawObject, scope } from './scope.ts';

class ResourceImpl extends RoomObject {
  declare id: string;
  declare readonly energy: number | undefined;
  declare readonly amount: number | undefined;
  declare readonly resourceType: string;

  override toString(): string {
    return `[resource (${this.resourceType}) #${this.id}]`;
  }
}

export type Resource = ResourceImpl;

/** Upstream `register.wrapFn(function(id) {…})`. */
export const Resource: GameConstructor<Resource, [id?: unknown]> = gameConstructor(
  ResourceImpl,
  function (this: Resource, id?: unknown): void {
    const data = rawObject(id);
    RoomObject.call(this, data.x, data.y, data.room, data.effects);
    // upstream stores the raw argument
    this.id = id as string;
  },
  { name: '', length: 1 },
);

defineGameObjectProperties<Resource, RawRoomObject>(Resource.prototype, rawObject, {
  energy: (o) => o.energy,
  amount: (o) => Reflect.get(o, o.resourceType || C.RESOURCE_ENERGY) as number | undefined,
  resourceType: (o) => o.resourceType || C.RESOURCE_ENERGY,
});

export function make(): void {
  if (scope().globals.Resource) {
    return;
  }
  exposeGlobal('Resource', Resource);
  exposeGlobal('Energy', Resource);
}
