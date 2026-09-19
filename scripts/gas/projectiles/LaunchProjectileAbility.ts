/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {NetworkMode, Quaternion, TransformComponent, Vec3, WorldService} from 'meta/worlds';
import type {Entity, Maybe, TemplateAsset} from 'meta/worlds';
import {GASAbility} from '../abilities/GASAbility';
import {GASComponent} from '../core/GASComponent';
import {GASProjectile} from './GASProjectile';
import type {ProjectileConfig} from './GASProjectile';

// Defaults applied when the config omits these — so a subclass only has to
// specify what matters (template, speed, onHit, targetFilter).
const DEFAULT_SPAWN_HEIGHT: number = 0.5;
const DEFAULT_LIFETIME_SEC: number = 10;
// Spawn projectiles ~1.2m in front of the caster so they clear its own capsule
// (radius ~0.25) and never overlap the shooter's collider on spawn.
const DEFAULT_MUZZLE_OFFSET: number = 1.2;

/**
 * Reusable "launch a projectile" ability. A game configures it by parameters:
 * which template, how fast, how it detects a hit, and what GAS effects to apply
 * on hit. The same ability backs any projectile — only the config differs.
 *
 * Default behavior: fires ONE projectile along the caster's facing (or the
 * `aimDirection` if given), at a small height above the caster, despawning after
 * DEFAULT_LIFETIME_SEC.
 *
 * Subclass (or codegen) supplies getConfig(). Subclasses that need a different
 * spawn pattern (e.g. a shotgun firing several pellets with spread) override
 * `fire()` and reuse the protected `spawnProjectile()` helper.
 */
export interface LaunchProjectileConfig extends ProjectileConfig {
  template: Maybe<TemplateAsset>;
  spawnHeight?: number;
  // Distance in front of the caster (along the aim direction) to spawn the
  // projectile, so it originates at a "muzzle" and NOT inside the caster's own
  // collider (which otherwise perturbs the character controller / ground check).
  muzzleOffset?: number;
  // Fire along this direction instead of the caster's forward. Supply the
  // camera / aim direction here for "shoot toward the crosshair".
  aimDirection?: Vec3;
}

export abstract class LaunchProjectileAbility extends GASAbility {
  protected abstract getConfig(): LaunchProjectileConfig;

  override onActivate(_userData: unknown): void {
    void this.launch();
    this.owner.endAbility(this.data.abilityId);
  }

  private async launch(): Promise<void> {
    const config = this.getConfig();
    if (!config.template) {
      return;
    }

    // Owner is the entity's GASComponent (see GASAbility.AbilityOwner note).
    const owner = this.owner as unknown as GASComponent;
    const ownerTransform = owner.entity.getComponent(TransformComponent);
    if (!ownerTransform) {
      return;
    }

    const spawnHeight = config.spawnHeight ?? DEFAULT_SPAWN_HEIGHT;
    // Aim along the explicit direction if given (camera / crosshair), else along
    // the caster's facing.
    const direction = (config.aimDirection ?? ownerTransform.worldForward).normalize();
    // Spawn at a muzzle in FRONT of the caster (along the aim direction), not
    // inside its own collider — a projectile spawned inside the capsule streams
    // trigger overlaps that jitter the character controller / ground detection.
    const muzzleOffset = config.muzzleOffset ?? DEFAULT_MUZZLE_OFFSET;
    const start = ownerTransform.worldPosition
      .add(new Vec3(0, spawnHeight, 0))
      .add(direction.mul(muzzleOffset));
    await this.fire(config, start, direction);
  }

  // Spawn the projectile(s) for one activation. Default: a single projectile
  // along `direction`. Override to change the pattern (e.g. shotgun spread) and
  // call spawnProjectile() per projectile.
  protected async fire(
    config: LaunchProjectileConfig,
    start: Vec3,
    direction: Vec3,
  ): Promise<void> {
    await this.spawnProjectile(config, start, direction);
  }

  // Spawn a single projectile at `start` travelling along `direction`. The
  // projectile faces its travel direction so straightForward (which advances
  // along worldForward) flies where it was aimed.
  protected async spawnProjectile(
    config: LaunchProjectileConfig,
    start: Vec3,
    direction: Vec3,
  ): Promise<void> {
    const owner = this.owner as unknown as GASComponent;
    await spawnConfiguredProjectile(config, start, direction, owner.entity);
  }
}

/**
 * Spawn and configure one projectile. Split out of the ability so a weapon that
 * does NOT inherit from it — the weaponprojectile family, which inherits the
 * shared weapon skeleton instead — can reuse the spawn without duplicating the
 * child-lookup and instigator defaulting below.
 */
export async function spawnConfiguredProjectile(
  config: LaunchProjectileConfig,
  start: Vec3,
  direction: Vec3,
  instigator: Entity,
): Promise<void> {
  const template = config.template;
  if (!template) {
    return;
  }
  const entity = await WorldService.get().spawnTemplate({
    templateAsset: template,
    networkMode: NetworkMode.Networked,
    position: start,
    rotation: Quaternion.lookRotation(direction),
  });
  let projectile = entity.getComponent(GASProjectile);
  if (!projectile) {
    // Editor templates commonly nest the mesh/collider/logic on a CHILD of the
    // spawned root, so GASProjectile may not be on the returned root entity.
    const withComp = entity.getChildrenWithComponent(GASProjectile, true);
    projectile = withComp.length > 0 ? withComp[0].getComponent(GASProjectile) : null;
  }
  if (!projectile) {
    console.warn('[Projectile] template is missing the GASProjectile component.');
    return;
  }
  projectile.configure({
    ...config,
    // The caster never counts as a hit (prevents self-hits in PvP).
    instigator: config.instigator ?? instigator,
    lifetimeSec: config.lifetimeSec ?? DEFAULT_LIFETIME_SEC,
  });
}
