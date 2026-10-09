/*
 * Ported from @screeps/engine src/utils.js (`sendAttackingNotification`).
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

export interface AttackedObjectLike {
  readonly _id: string;
  readonly type: string;
  readonly room: string;
  readonly name?: string | undefined;
  readonly user?: string | null | undefined;
}

/** Sink for user notifications (upstream: `driver.sendNotification(userId, message)`). */
export type SendNotification = (userId: string, message: string) => void;

/** Notifies the owner of `target` (or of the room controller) that the object is under attack. */
export function sendAttackingNotification(
  target: AttackedObjectLike,
  roomController: { readonly user?: string | null | undefined } | null | undefined,
  sendNotification: SendNotification,
): void {
  let labelText: string;
  if (target.type === 'creep') {
    labelText = `creep ${String(target.name)}`;
  } else if (target.type === 'spawn') {
    labelText = `spawn ${String(target.name)}`;
  } else {
    labelText = `${target.type} #${target._id}`;
  }
  const user = target.user ? target.user : roomController ? roomController.user : null;
  if (user) {
    sendNotification(user, `Your ${labelText} in room ${target.room} is under attack!`);
  }
}
