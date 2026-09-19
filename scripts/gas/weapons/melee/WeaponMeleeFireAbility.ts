/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {TransformComponent, type Entity, type Vec3} from 'meta/worlds';
import {GASComponent} from '../../core/GASComponent';
import {allTargetsInRadius} from '../targeting/Targeting';
import {WeaponFireAbilityBase} from '../core/WeaponFireAbilityBase';
import type {WeaponAbilitySpec} from '../core/WeaponSetup';
import type {
  WeaponConfigProvider,
  WeaponFireConfigBase,
} from '../core/WeaponFireAbilityBase';

/** Target filter matched against the candidate's GAS tags. */
export interface MeleeTagFilter {
  /** Target must have ALL of these. */
  required?: string[];

  /** Target must have NONE of these. */
  blocked?: string[];
}

/** One resolved melee hit, nearest-first within the swing. */
export interface MeleeHitResult {
  /** Apply the damage effect to this — the GAS-owning entity. */
  gasEntity: Entity;

  /** Origin → target distance, for falloff. */
  distance: number;

  /** 0-based order by distance, for per-target falloff on a cleave. */
  hitIndex: number;

  /** The swing's facing direction. */
  direction: Vec3;
}

/**
 * What a melee swing needs on top of the shared weapon config: how far it
 * reaches, how wide the arc is, how many targets one swing may catch, and what
 * a hit means.
 */
export interface MeleeFireConfig extends WeaponFireConfigBase {
  /** Reach in meters, measured from `origin`. */
  range: number;

  /**
   * Half-angle of the swing arc in degrees, measured from the facing direction.
   * 180 is a full circle; 60 gives a 120-degree frontal arc. Values <= 0 are
   * treated as "directly ahead only" and will essentially never connect, so the
   * component clamps to a sane floor rather than passing 0 through.
   */
  coneHalfAngleDeg: number;

  /** Targets one swing may damage. 1 = single target; >1 = cleave. */
  maxTargets?: number;

  /** Which candidates count as targets. Omit = any GAS entity. */
  targetFilter?: MeleeTagFilter;

  /**
   * Invoked once per valid target, nearest-first. The game applies its damage
   * effect here and may shape it by distance and hit index.
   */
  onHit(hit: MeleeHitResult): void;

  /** Fires once per accepted swing, before targets resolve. */
  onSwing?(): void;
}

/** Supplies the per-swing config. Implemented by the weapon component. */
export type MeleeConfigProvider = WeaponConfigProvider<MeleeFireConfig>;

/**
 * Proximity + facing delivery. Resolves a single sphere overlap plus an XZ arc
 * test at swing time. Applies no damage: `config.onHit` does, nearest-first.
 */
export class WeaponMeleeFireAbility extends WeaponFireAbilityBase<MeleeFireConfig> {
  protected override async deliver(
    config: MeleeFireConfig,
    origin: Vec3,
    direction: Vec3,
  ): Promise<void> {
    const owner = this.ownerGas;
    const ownerEntity = owner.entity;
    const maxTargets = Math.max(1, Math.floor(config.maxTargets ?? 1));

    config.onSwing?.();

    const candidates = await allTargetsInRadius(
      origin,
      config.range,
      {
        required: config.targetFilter?.required,
        blocked: config.targetFilter?.blocked,
      },
      {exclude: ownerEntity},
    );
    if (ownerEntity.isDestroyed()) {
      return;
    }

    const facing = flattenXZ(direction);
    if (!facing) {
      return;
    }
    const cosLimit = Math.cos(degreesToRadians(clampHalfAngle(config.coneHalfAngleDeg)));

    let hitIndex = 0;
    for (const target of candidates) {
      if (!target || target.isDestroyed() || target === ownerEntity) {
        continue;
      }
      const transform = target.getComponent(TransformComponent);
      if (!transform) {
        continue;
      }
      const toTarget = transform.worldPosition.sub(origin);
      const flat = flattenXZ(toTarget);
      // No horizontal offset means no direction; treat as in-arc.
      if (flat && flat.x * facing.x + flat.z * facing.z < cosLimit) {
        continue;
      }
      if (!target.getComponent(GASComponent)) {
        continue;
      }
      config.onHit({
        gasEntity: target,
        distance: Math.sqrt(toTarget.x * toTarget.x + toTarget.z * toTarget.z),
        hitIndex,
        direction,
      });
      hitIndex++;
      if (hitIndex >= maxTargets) {
        return;
      }
    }
  }
}

/** Ability pair granted for a melee weapon. */
export const MELEE_ABILITIES: WeaponAbilitySpec = {
  fireAbility: WeaponMeleeFireAbility,
  fireAbilityName: 'weapon.melee.fire',
  reloadAbilityName: 'weapon.melee.reload',
};

/** A cone narrower than this can never connect in practice. */
const MIN_HALF_ANGLE_DEG = 1;

/** A half-angle of 180 degrees or more is a full circle; clamp so cos() is stable. */
const MAX_HALF_ANGLE_DEG = 180;

function clampHalfAngle(deg: number): number {
  if (!Number.isFinite(deg)) {
    return MAX_HALF_ANGLE_DEG;
  }
  return Math.min(Math.max(deg, MIN_HALF_ANGLE_DEG), MAX_HALF_ANGLE_DEG);
}

function degreesToRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Unit vector on the XZ plane, or null when the input has no horizontal
 * component at all (straight up, or zero length).
 */
function flattenXZ(v: Vec3): {x: number; z: number} | null {
  const lengthSq = v.x * v.x + v.z * v.z;
  if (lengthSq <= 1e-8) {
    return null;
  }
  const length = Math.sqrt(lengthSq);
  return {x: v.x / length, z: v.z / length};
}
