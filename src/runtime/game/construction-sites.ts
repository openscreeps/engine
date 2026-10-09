/*
 * ConstructionSite (screeps/engine `src/game/construction-sites.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { isUndefined } from './compat.ts';
import {
  defineGameObjectProperties,
  exposeGlobal,
  gameConstructor,
  type GameConstructor,
} from './define.ts';
import { RoomObject } from './room-object.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { rawObject, scope, username } from './scope.ts';

class ConstructionSiteImpl extends RoomObject {
  declare id: string;
  declare readonly progress: number | undefined;
  declare readonly progressTotal: number | undefined;
  declare readonly structureType: string | undefined;
  declare readonly name: string | undefined;
  declare readonly owner: { username: string };
  declare readonly my: boolean | undefined;

  override toString(): string {
    return `[construction site (${String(rawObject(this.id).structureType)}) #${this.id}]`;
  }

  remove(): number {
    if (!this.my && !(this.room && this.room.controller && this.room.controller.my)) {
      return C.ERR_NOT_OWNER;
    }
    scope().intents.pushByName('room', 'removeConstructionSite', {
      roomName: rawObject(this.id).room,
      id: this.id,
    });
    return C.OK;
  }
}

export type ConstructionSite = ConstructionSiteImpl;

/** Upstream `register.wrapFn(function(id) {…})`. */
export const ConstructionSite: GameConstructor<ConstructionSite, [id?: unknown]> = gameConstructor(
  ConstructionSiteImpl,
  function (this: ConstructionSite, id?: unknown): void {
    const data = rawObject(id);
    RoomObject.call(this, data.x, data.y, data.room, data.effects);
    // upstream stores the raw argument
    this.id = id as string;
  },
  { name: '', length: 1 },
);

defineGameObjectProperties<ConstructionSite, RawRoomObject>(ConstructionSite.prototype, rawObject, {
  progress: (o) => o.progress,
  progressTotal: (o) => o.progressTotal,
  structureType: (o) => o.structureType,
  name: (o) => o.name,
  owner: (o) => ({ username: username(String(o.user)) }),
  my: (o) => (isUndefined(o.user) ? undefined : o.user == scope().runtimeData.user._id),
});

export function make(): void {
  if (scope().globals.ConstructionSite) {
    return;
  }
  exposeGlobal('ConstructionSite', ConstructionSite);
}
