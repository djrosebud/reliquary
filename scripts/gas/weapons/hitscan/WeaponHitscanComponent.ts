/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {component, editor, property} from 'meta/worlds';
import {GASComponent} from '../../core/GASComponent';
import {WeaponComponentBase} from '../core/WeaponComponentBase';
import {setupWeapon} from '../core/WeaponSetup';
import type {WeaponRuntime} from '../core/WeaponSetup';
import type {Aim} from '../core/AimProvider';
import {HITSCAN_ABILITIES} from './WeaponHitscanFireAbility';
import type {HitResult, HitscanConfigProvider, HitscanFireConfig} from './WeaponHitscanFireAbility';

/**
 * Data-driven hitscan weapon — the shot lands the instant the trigger is pulled.
 * One component covers pistol / rifle / shotgun / sniper; they differ only in
 * the properties here and the ones inherited from {@link WeaponComponentBase}.
 *
 * The travelling-shot twin is WeaponProjectileComponent. Pick this one when the
 * shot should be instant and undodgeable.
 *
 * See README.md for the model, extension points, and boundaries.
 */
@component({
  description: 'Data-driven hitscan weapon — instant trace, triggered fire + reload.',
})
export class WeaponHitscanComponent
  extends WeaponComponentBase
  implements HitscanConfigProvider
{
  @editor({
    description:
      'Maximum range in meters. Anything past this is not hit at all — there is ' +
      'no falloff, damage is the same at 1 m and at this range.',
  })
  @property()
  public range: number = 50;

  @editor({
    description:
      'How many targets one shot can damage. 1 = stops at the first thing it ' +
      'hits, including cover. Above 1 = armour-piercing, passes through.',
  })
  @property()
  public maxHits: number = 1;

  protected override assemble(gas: GASComponent): WeaponRuntime {
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
      HITSCAN_ABILITIES,
    );
  }

  /** Per-shot config for the fire ability; rebuilt on every activation. */
  public buildFireConfig(): HitscanFireConfig | null {
    const gas = this.gas;
    const runtime = this.runtime;
    const aim = this.aimProvider?.getAim(this.entity);
    if (!gas || !runtime || !aim) {
      return null;
    }
    const damageEffect = runtime.damageEffect;
    return {
      origin: aim.origin,
      direction: aim.direction,
      range: this.range,
      maxHits: this.maxHits,
      pelletCount: this.pelletCount,
      spreadDeg: this.spreadDeg,
      burstCount: this.burstCount,
      burstIntervalSec: this.burstIntervalSec,
      excludeEntities: [this.entity],
      targetFilter: this.targetFilter(),
      refreshAim: (): Aim | null => this.aimProvider?.getAim(this.entity) ?? null,
      onHit: (hit: HitResult): void => {
        const targetGas = hit.gasEntity.getComponent(GASComponent);
        if (targetGas) {
          gas.applyEffectToTarget(targetGas, damageEffect);
        }
      },
    };
  }
}
