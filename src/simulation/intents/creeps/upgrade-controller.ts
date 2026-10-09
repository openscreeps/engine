/*
 * Port of screeps/engine `processor/intents/creeps/upgradeController.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';

export function creepUpgradeController(
  object: RoomObject,
  intent: IntentArgs<'upgradeController'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, bulkUsers, stats, gameTime, eventLog, users, env } = scope;

  if (
    object.type !== 'creep' ||
    object.spawning ||
    !object.store ||
    (object.store.energy as number) <= 0
  ) {
    return;
  }

  const user = users[object.user as string];
  if (user && user.shardAccess === false) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target || target.type !== 'controller') {
    return;
  }
  if (Math.abs(target.x - object.x) > 3 || Math.abs(target.y - object.y) > 3) {
    return;
  }
  if (target.level === 0 || target.user !== object.user) {
    return;
  }
  if (target.upgradeBlocked && target.upgradeBlocked > gameTime) {
    return;
  }

  target._upgraded = target._upgraded || 0;

  const body = object.body ?? [];
  const energy = object.store.energy as number;
  const buildPower =
    body.filter((i) => (i.hits > 0 || (i._oldHits as number) > 0) && i.type === C.WORK).length *
      C.UPGRADE_CONTROLLER_POWER || 0;
  let buildEffect = Math.min(buildPower, energy);
  let boostedParts = body.map((i) => {
    if (i.type === C.WORK && i.boost) {
      const boost = lookup<Readonly<Record<string, number>>>(C.BOOSTS[C.WORK], i.boost) as Readonly<
        Record<string, number>
      >;
      if ((boost.upgradeController as number) > 0) {
        return (boost.upgradeController as number) - 1;
      }
    }
    return 0;
  });

  if (target.level === 8) {
    let limit: number = C.CONTROLLER_MAX_UPGRADE_PER_TICK;
    const effect = (target.effects ?? []).find((e) => e.power === C.PWR_OPERATE_CONTROLLER);
    if (effect && effect.endTime >= gameTime) {
      limit += C.POWER_INFO[C.PWR_OPERATE_CONTROLLER].effect[
        (effect.level as number) - 1
      ] as number;
    }
    if (target._upgraded >= limit) {
      return;
    }
    buildEffect = Math.min(buildEffect, limit - target._upgraded);
  }

  boostedParts.sort((a, b) => b - a);
  boostedParts = boostedParts.slice(0, buildEffect);

  const boostedEffect = Math.floor(buildEffect + boostedParts.reduce((s, v) => s + v, 0));

  if ((target.level as number) < 8) {
    let nextLevelProgress = lookup<number>(C.CONTROLLER_LEVELS, target.level) as number;
    if (env.config.ptr) {
      nextLevelProgress = 1000;
    }
    if (target.tutorial && target.level === 1) {
      nextLevelProgress = 4;
    }
    if (
      (target.progress as number) + boostedEffect >= nextLevelProgress &&
      (target.downgradeTime as number) + C.CONTROLLER_DOWNGRADE_RESTORE >=
        gameTime + (lookup<number>(C.CONTROLLER_DOWNGRADE, target.level) as number)
    ) {
      target.progress = (target.progress as number) + boostedEffect - nextLevelProgress;
      target.level = (target.level as number) + 1;
      target.downgradeTime =
        gameTime + (lookup<number>(C.CONTROLLER_DOWNGRADE, target.level) as number) / 2;
      env.sendNotification(
        target.user as string,
        `Your Controller in room ${target.room} has been upgraded to level ${String(target.level)}.`,
      );
      if (target.level === 8) {
        target.progress = 0;
      }
      target.safeModeAvailable = (target.safeModeAvailable || 0) + 1;
    } else {
      target.progress = (target.progress as number) + boostedEffect;
    }
  }

  bulkUsers.inc(target.user, 'gcl', boostedEffect);

  target._upgraded += buildEffect;

  stats.inc('energyControl', object.user, boostedEffect);

  object.store.energy = energy - buildEffect;

  (object.actionLog as ActionLog).upgradeController = { x: target.x, y: target.y };

  bulk.update(object, { store: { energy: object.store.energy } });

  bulk.update(target, {
    level: target.level,
    progress: target.progress,
    safeModeAvailable: target.safeModeAvailable,
    downgradeTime: target.downgradeTime,
  });

  eventLog.push({
    event: C.EVENT_UPGRADE_CONTROLLER,
    objectId: object._id,
    data: {
      amount: boostedEffect,
      energySpent: buildEffect,
    },
  });
}
