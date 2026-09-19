/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {component, editor, property, type Entity, type Maybe, type TemplateAsset} from 'meta/worlds';
import {GASComponent} from '../../core/GASComponent';
import {WeaponComponentBase} from '../core/WeaponComponentBase';
import {setupWeapon} from '../core/WeaponSetup';
import type {WeaponRuntime} from '../core/WeaponSetup';
import type {Aim} from '../core/AimProvider';
import {PROJECTILE_ABILITIES} from './WeaponProjectileFireAbility';
import type {
  ProjectileWeaponConfigProvider,
  ProjectileWeaponFireConfig,
} from './WeaponProjectileFireAbility';

/**
 * Data-driven projectile weapon — the shot travels and can be dodged. One
 * component covers pistol / shotgun / grenade launcher; they differ only in the
 * properties here and the ones inherited from {@link WeaponComponentBase}.
 *
 * The instant-hit twin is WeaponHitscanComponent. Pick this one when the shot
 * should be visible, dodgeable, or arcing.
 *
 * See README.md for the model, extension points, and boundaries.
 */
@component({
  description: 'Data-driven projectile weapon — travelling shots, triggered fire + reload.',
})
export class WeaponProjectileComponent
  extends WeaponComponentBase
  implements ProjectileWeaponConfigProvider
{
  @editor({
    description:
      'The bullet template. Must carry a GASProjectile, a collider, and a ' +
      'PhysicsBody of type Trigger — the trigger is what detects the hit.',
  })
  @property()
  public projectileTemplate: Maybe<TemplateAsset> = null;

  @editor({
    description:
      'Travel speed in meters per second. 30 = a visible bolt, 100 = a fast ' +
      'bullet. Slow enough and players can dodge it.',
  })
  @property()
  public projectileSpeed: number = 30;

  @editor({
    description:
      'Seconds before an unspent projectile despawns. This is the effective ' +
      'range: speed times lifetime. Keep it finite or misses leak.',
  })
  @property()
  public lifetimeSec: number = 5;

  protected override assemble(gas: GASComponent): WeaponRuntime {
    if (!this.projectileTemplate) {
      console.error('[WeaponProjectile] projectileTemplate is unset; the weapon cannot fire.');
    }
    return setupWeapon(
      {
        gas,
        provider: this,
        weaponKey: this.weaponKey,
        magazineSize: this.magazineSize,
        reserveAmmo: this.reserveAmmo,
        fireRate: this.fireRate,
        damage: this.damage,
        damageEffectId: this.damageEffectId,
        healthAttribute: this.healthAttribute,
      },
      PROJECTILE_ABILITIES,
    );
  }

  /** Per-shot config for the fire ability; rebuilt on every activation. */
  public buildFireConfig(): ProjectileWeaponFireConfig | null {
    const gas = this.gas;
    const runtime = this.runtime;
    const aim = this.aimProvider?.getAim(this.entity);
    if (!gas || !runtime || !aim || !this.projectileTemplate) {
      return null;
    }
    const damageEffect = runtime.damageEffect;
    return {
      template: this.projectileTemplate,
      speed: this.projectileSpeed,
      lifetimeSec: this.lifetimeSec,
      origin: aim.origin,
      direction: aim.direction,
      pelletCount: this.pelletCount,
      spreadDeg: this.spreadDeg,
      burstCount: this.burstCount,
      burstIntervalSec: this.burstIntervalSec,
      targetFilter: this.targetFilter(),
      refreshAim: (): Aim | null => this.aimProvider?.getAim(this.entity) ?? null,
      onHit: (target: Entity): void => {
        // A projectile lands frames after it was fired, so the shooter may be
        // gone by now. Damage is attributed to this weapon's GAS, so with no
        // shooter there is nothing to attribute it to — drop the hit rather
        // than apply an effect through a destroyed component.
        if (this.entity.isDestroyed()) {
          return;
        }
        const targetGas = target.getComponent(GASComponent);
        if (targetGas) {
          gas.applyEffectToTarget(targetGas, damageEffect);
        }
      },
    };
  }
}
