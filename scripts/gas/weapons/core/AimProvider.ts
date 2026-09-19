/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {CameraService, TransformComponent, Vec3, type Entity} from 'meta/worlds';

/** The ray a weapon fires along this shot. */
export interface Aim {
  origin: Vec3;
  direction: Vec3;
}

/**
 * Produces the ray a weapon fires along — crosshair, muzzle, auto-target, cursor.
 * Resolved on the shooting client, so drive firing owner-only.
 */
export interface AimProvider {
  getAim(owner: Entity): Aim | null;
}

/** Aims from the camera along its optical axis — the screen-center crosshair. */
export class CameraAimProvider implements AimProvider {
  getAim(_owner: Entity): Aim | null {
    const cam = CameraService.get();
    return {origin: cam.position, direction: cam.forward};
  }
}

/** Muzzle offset in the owner's local frame: x = right, y = up, z = forward. */
export const DEFAULT_MUZZLE_OFFSET: Vec3 = new Vec3(0, 1.0, 0.33);

/**
 * Aims along the owner's facing from a muzzle offset off its pivot, so the ray
 * clears the owner's own body. For turrets, top-down shooters, and NPCs.
 */
export class ForwardAimProvider implements AimProvider {
  constructor(private readonly muzzleOffset: Vec3 = DEFAULT_MUZZLE_OFFSET) {}

  getAim(owner: Entity): Aim | null {
    const t = owner.getComponent(TransformComponent);
    if (!t) {
      return null;
    }
    const origin = t.worldPosition
      .add(t.worldRight.mul(this.muzzleOffset.x))
      .add(t.worldUp.mul(this.muzzleOffset.y))
      .add(t.worldForward.mul(this.muzzleOffset.z));
    return {origin, direction: t.worldForward};
  }
}

/**
 * Aims along the camera's optical axis but from a muzzle offset off the owner's
 * pivot, so the shot leaves the body while still going where the player looks.
 */
export class MuzzleAimProvider implements AimProvider {
  constructor(private readonly muzzleOffset: Vec3 = DEFAULT_MUZZLE_OFFSET) {}

  getAim(owner: Entity): Aim | null {
    const t = owner.getComponent(TransformComponent);
    if (!t) {
      return null;
    }
    const origin = t.worldPosition
      .add(t.worldRight.mul(this.muzzleOffset.x))
      .add(t.worldUp.mul(this.muzzleOffset.y))
      .add(t.worldForward.mul(this.muzzleOffset.z));
    return {origin, direction: CameraService.get().forward};
  }
}

/** Legal `aimSource` values, for warnings and editor descriptions. */
export const AIM_SOURCES: readonly string[] = ['camera', 'forward'];

/**
 * Build the provider named by `source`; the muzzle offset applies to 'forward'
 * only. The editor has no enum property, so an unknown value warns and falls
 * back rather than silently aiming the wrong way.
 */
export function createAimProvider(source: string, muzzleOffset: Vec3): AimProvider {
  if (source === 'forward') {
    return new ForwardAimProvider(muzzleOffset);
  }
  if (source !== 'camera') {
    console.warn(
      `[Weapon] unknown aimSource '${source}'; expected ${AIM_SOURCES.join(' or ')}. Using 'camera'.`,
    );
  }
  return new CameraAimProvider();
}
