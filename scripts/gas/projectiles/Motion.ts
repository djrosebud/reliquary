/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {TransformComponent} from 'meta/worlds';
import type {Entity, Vec3} from 'meta/worlds';

/**
 * Context handed to a motion strategy each frame. Most motions only need the
 * transform/speed; target-seeking motions (e.g. homing) also read `target`.
 */
export interface MotionContext {
  transform: TransformComponent;
  deltaTime: number;
  speed: number;
  target?: Entity;
}

/**
 * A motion strategy returns the projectile's next world position. Games pick a
 * strategy (or pass their own). Keep this palette driven by real needs — add
 * arc / wave / boomerang here only when a game actually requires them.
 */
export type MotionStep = (ctx: MotionContext) => Vec3;

/** Travels straight along the projectile's own forward direction. */
export const straightForward: MotionStep = (ctx) =>
  ctx.transform.worldPosition.add(ctx.transform.worldForward.mul(ctx.speed * ctx.deltaTime));

/**
 * Seeks `ctx.target`, steering toward its current position each frame (does not
 * overshoot on the arrival frame). Falls back to straight flight if the target
 * is gone. The hit itself is handled by the normal trigger, same as any motion.
 */
export const homing: MotionStep = (ctx) => {
  const target = ctx.target;
  if (target && !target.isDestroyed()) {
    const targetTransform = target.getComponent(TransformComponent);
    if (targetTransform) {
      const toTarget = targetTransform.worldPosition.sub(ctx.transform.worldPosition);
      const stepLen = ctx.speed * ctx.deltaTime;
      if (toTarget.magnitude() <= stepLen) {
        return targetTransform.worldPosition; // reach exactly, no overshoot
      }
      return ctx.transform.worldPosition.add(toTarget.normalize().mul(stepLen));
    }
  }
  return straightForward(ctx); // target gone -> fly straight
};
