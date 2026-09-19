/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {spawnConfiguredProjectile} from '../../projectiles/LaunchProjectileAbility';
import {WeaponFireAbilityBase} from '../core/WeaponFireAbilityBase';
import type {WeaponAbilitySpec} from '../core/WeaponSetup';
import type {Entity, Maybe, TemplateAsset, Vec3} from 'meta/worlds';
import type {
  WeaponConfigProvider,
  WeaponFireConfigBase,
} from '../core/WeaponFireAbilityBase';
import type {TagFilter} from '../../projectiles/GASProjectile';

/**
 * What a projectile shot needs on top of the shared weapon config: what to
 * launch, how fast, how long it lives, and what a landing means.
 */
export interface ProjectileWeaponFireConfig extends WeaponFireConfigBase {
  /** The bullet. Needs GASProjectile, a collider, and a Trigger PhysicsBody. */
  template: Maybe<TemplateAsset>;

  /** Travel speed in meters per second. */
  speed: number;

  /** Despawn after this long, so a projectile that hits nothing cannot leak. */
  lifetimeSec?: number;

  /** Which hits count as targets. Omit = any GAS entity. */
  targetFilter?: TagFilter;

  /**
   * Invoked when a projectile lands, which is frames after the shot and may be
   * after the shooter is gone. Unlike hitscan there is no distance or collider
   * detail — the trigger reports the entity only.
   */
  onHit(target: Entity): void;
}

/** Supplies the per-shot config. Implemented by the weapon component. */
export type ProjectileWeaponConfigProvider = WeaponConfigProvider<ProjectileWeaponFireConfig>;

/**
 * Travelling-shot delivery. Everything around the shot — cooldown, burst,
 * pellets, spread, muzzle — comes from {@link WeaponFireAbilityBase}; this class
 * is only the spawn.
 *
 * It applies no damage. The projectile carries `config.onHit` and calls it when
 * its trigger finds a valid target, frames after the ability has already ended.
 */
export class WeaponProjectileFireAbility extends WeaponFireAbilityBase<ProjectileWeaponFireConfig> {
  /** Launch one projectile along `direction`, already spread-perturbed. */
  protected override async deliver(
    config: ProjectileWeaponFireConfig,
    origin: Vec3,
    direction: Vec3,
  ): Promise<void> {
    await spawnConfiguredProjectile(
      {
        template: config.template,
        speed: config.speed,
        lifetimeSec: config.lifetimeSec,
        targetFilter: config.targetFilter,
        // Forwarded through an arrow so the provider keeps its own receiver.
        onHit: (target: Entity): void => config.onHit(target),
        // The muzzle is already resolved by the shared burst loop; zero these
        // so the spawn helper does not offset it a second time.
        spawnHeight: 0,
        muzzleOffset: 0,
      },
      origin,
      direction,
      this.ownerGas.entity,
    );
  }
}

/** Ability pair granted for a projectile weapon. */
export const PROJECTILE_ABILITIES: WeaponAbilitySpec = {
  fireAbility: WeaponProjectileFireAbility,
  fireAbilityName: 'weapon.projectile.fire',
  reloadAbilityName: 'weapon.projectile.reload',
};
