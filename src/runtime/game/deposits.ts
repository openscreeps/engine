/*
 * Deposit, a highway commodity deposit (screeps/engine `src/game/deposits.js`).
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

class DepositImpl extends RoomObject {
  declare id: string;
  declare readonly depositType: string | undefined;
  declare readonly cooldown: number;
  declare readonly lastCooldown: number;
  declare readonly ticksToDecay: number | undefined;

  override toString(): string {
    return `[deposit (${String(this.depositType)}) #${this.id}]`;
  }
}

export type Deposit = DepositImpl;

/** Upstream `register.wrapFn(function(id) {…})`. */
export const Deposit: GameConstructor<Deposit, [id?: unknown]> = gameConstructor(
  DepositImpl,
  function (this: Deposit, id?: unknown): void {
    const data = rawObject(id);
    RoomObject.call(this, data.x, data.y, data.room, data.effects);
    // upstream stores the raw argument
    this.id = id as string;
  },
  { name: '', length: 1 },
);

defineGameObjectProperties<Deposit, RawRoomObject>(Deposit.prototype, rawObject, {
  depositType: (o) => o.depositType,
  cooldown: (o) => {
    const time = scope().runtimeData.time;
    return o.cooldownTime && o.cooldownTime > time ? o.cooldownTime - time : 0;
  },
  // The casts let TypeScript emit upstream's raw arithmetic (`undefined`/`null` coerce like JS).
  lastCooldown: (o) =>
    Math.ceil(C.DEPOSIT_EXHAUST_MULTIPLY * Math.pow(o.harvested as number, C.DEPOSIT_EXHAUST_POW)),
  ticksToDecay: (o) =>
    o.decayTime ? (o.decayTime as number) - scope().runtimeData.time : undefined,
});

export function make(): void {
  if (scope().globals.Deposit) {
    return;
  }
  exposeGlobal('Deposit', Deposit);
}
