/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v2

import {component, editor, property} from 'meta/worlds';
import {GASComponent} from '../../core/GASComponent';
import {CharacterAnimationController} from '../../../animation/CharacterAnimationController';
import {AnimAction} from '../../../animation/layers/TriggeredLayer';
import {WeaponComponentBase} from '../core/WeaponComponentBase';
import {setupWeapon} from '../core/WeaponSetup';
import type {WeaponRuntime} from '../core/WeaponSetup';
import {MELEE_ABILITIES} from './WeaponMeleeFireAbility';
import type {
  MeleeConfigProvider,
  MeleeFireConfig,
  MeleeHitResult,
} from './WeaponMeleeFireAbility';

/**
 * Data-driven melee weapon: reach plus an arc, resolved at the instant of the
 * press. Ranged twins are WeaponHitscanComponent and WeaponProjectileComponent.
 */
@component({
  description:
    'Data-driven melee weapon — proximity + facing arc resolved on the swing, triggered fire.',
})
export class WeaponMeleeComponent extends WeaponComponentBase implements MeleeConfigProvider {
  @editor({
    description:
      'Reach in meters from the attacker. Roughly weapon length plus arm: 2 is a ' +
      'sword, 1.2 a fist, 4 a polearm.',
  })
  @property()
  public range: number = 2;

  @editor({
    description:
      'Half-angle of the swing arc in degrees, measured from where the attacker ' +
      'faces. 60 gives a 120-degree frontal arc; 180 hits all round. Measured on ' +
      'the ground plane, so a target up a step still counts as in front.',
  })
  @property()
  public coneHalfAngleDeg: number = 60;

  @editor({
    description:
      'How many targets one swing damages, nearest first. 1 is single-target; ' +
      'raise it for a cleave that catches a crowd.',
  })
  @property()
  public maxTargets: number = 1;

  // Resolved lazily; start order against the animator is not guaranteed.
  private animation: CharacterAnimationController | null = null;
  private animationResolved: boolean = false;

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
      MELEE_ABILITIES,
    );
  }

  /** Per-swing config for the fire ability; rebuilt on every activation. */
  public buildFireConfig(): MeleeFireConfig | null {
    const gas = this.gas;
    const runtime = this.runtime;
    const aim = this.aimProvider?.getAim(this.entity);
    if (!gas || !runtime || !aim) {
      return null;
    }
    const damageEffect = runtime.damageEffect;
    return {
      range: this.range,
      coneHalfAngleDeg: this.coneHalfAngleDeg,
      maxTargets: this.maxTargets,
      origin: aim.origin,
      direction: aim.direction,
      // Pinned: every pellet would query the same sphere.
      pelletCount: 1,
      spreadDeg: 0,
      burstCount: this.burstCount,
      burstIntervalSec: this.burstIntervalSec,
      targetFilter: this.targetFilter(),
      onSwing: (): void => {
        if (this.entity.isDestroyed()) {
          return;
        }
        this.resolveAnimation();
        this.animation?.play(AnimAction.MELEE);
      },
      onHit: (hit: MeleeHitResult): void => {
        if (this.entity.isDestroyed()) {
          return;
        }
        const targetGas = hit.gasEntity.getComponent(GASComponent);
        if (targetGas) {
          gas.applyEffectToTarget(targetGas, damageEffect);
        }
      },
    };
  }

  private resolveAnimation(): void {
    if (this.animationResolved) {
      return;
    }
    this.animationResolved = true;
    this.animation = this.entity.getComponent(CharacterAnimationController);
  }
}
