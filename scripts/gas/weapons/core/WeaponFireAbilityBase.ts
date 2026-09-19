/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {TransformComponent, type Vec3} from 'meta/worlds';
import {GASAbility} from '../../abilities/GASAbility';
import {GASComponent} from '../../core/GASComponent';
import {applyConeSpread} from './Spread';
import type {Aim} from './AimProvider';

/**
 * What every weapon shot has in common, whatever finally delivers it. A
 * delivery-specific config extends this with its own payload — a trace range,
 * a projectile template, a beam width.
 */
export interface WeaponFireConfigBase {
  /** Muzzle position. Defaults to the owner's world position. */
  origin?: Vec3;

  /** Aim direction, need not be normalized. Defaults to the owner's forward. */
  direction?: Vec3;

  /** Deliveries per round. >1 = shotgun cone. */
  pelletCount?: number;

  /** Cone half-angle (degrees); 0 = perfectly accurate. */
  spreadDeg?: number;

  /**
   * Rounds per activation. 1 = semi/auto; N = burst. The cooldown is committed
   * once per activation, so set it to at least
   * `(burstCount - 1) * burstIntervalSec` or bursts overlap.
   */
  burstCount?: number;

  /** Seconds between burst rounds, in game time. 0 = one frame. */
  burstIntervalSec?: number;

  /**
   * Re-resolve aim between burst rounds, which leave the muzzle on later frames.
   * Omit to fire the whole burst along the direction captured at activation.
   */
  refreshAim?(): Aim | null;
}

/** Supplies the per-shot config. Implemented by the weapon component. */
export interface WeaponConfigProvider<TConfig extends WeaponFireConfigBase> {
  buildFireConfig(): TConfig | null;
}

interface PendingDelay {
  remaining: number;
  resolve: () => void;
}

/**
 * Everything a weapon shot does EXCEPT deliver it: cooldown gating, burst
 * rounds, one delivery per pellet inside a spread cone, muzzle resolution, and
 * ending the ability exactly once when the whole burst finishes.
 *
 * Subclasses implement {@link deliver} — trace a ray, launch a projectile, open
 * a beam. That single method is the entire difference between weapon families;
 * everything above it is identical, which is why it lives here rather than
 * being written once per family.
 *
 * Burst spacing runs on GAME time via {@link tick}, not wall clock, so a stalled
 * or slowed update loop cannot desynchronise it from the ability cooldown.
 */
export abstract class WeaponFireAbilityBase<
  TConfig extends WeaponFireConfigBase,
> extends GASAbility {
  public configProvider: WeaponConfigProvider<TConfig> | null = null;
  private pendingDelay: PendingDelay | null = null;

  /**
   * Send one pellet on its way. Called `pelletCount` times per round, each with
   * its own spread-perturbed direction. Applies no damage — the game does that
   * from the config's own hit callback.
   */
  protected abstract deliver(config: TConfig, origin: Vec3, direction: Vec3): Promise<void>;

  /** The GASComponent this ability was granted on. */
  protected get ownerGas(): GASComponent {
    return this.owner as unknown as GASComponent;
  }

  /**
   * Reject before the cost is paid and the cooldown starts, so a rejected frame
   * costs nothing. Guards on `isActive` rather than a state tag: a burst spans
   * frames, and a tag write per shot would republish the owner's whole
   * replicated tag set — every frame, on an automatic weapon.
   *
   * The config is deliberately rebuilt in {@link onActivate}: reusing the one
   * probed here would fire a stale aim after a speculative `canActivateAbility`.
   */
  public override canActivate(): boolean {
    if (this.isActive) {
      return false;
    }
    return this.configProvider?.buildFireConfig() != null;
  }

  public override onActivate(_userData: unknown): void {
    const config = this.configProvider?.buildFireConfig();
    if (!config) {
      this.owner.endAbility(this.data.abilityId);
      return;
    }
    // Nothing awaits this promise, so a rejection would otherwise surface as an
    // unhandled rejection with no attribution.
    void this.fire(config).catch((error: unknown): void => {
      console.error('[Weapon] shot failed to resolve:', error);
    });
  }

  /** Advances a burst waiting between rounds. */
  public override tick(delta: number): void {
    const delay = this.pendingDelay;
    if (!delay) {
      return;
    }
    delay.remaining -= delta;
    if (delay.remaining <= 0) {
      this.pendingDelay = null;
      delay.resolve();
    }
  }

  /**
   * Release a burst still waiting between rounds. Without this, an ability ended
   * from outside (death, despawn, weapon swap) leaves `fire` parked on a promise
   * that never settles, so `isActive` stays true and `canActivate` refuses every
   * later shot — the weapon goes permanently dead.
   */
  public override onEnd(): void {
    const delay = this.pendingDelay;
    this.pendingDelay = null;
    delay?.resolve();
  }

  private async fire(config: TConfig): Promise<void> {
    const owner = this.ownerGas;
    try {
      let origin = config.origin;
      let direction = config.direction;
      if (!origin || !direction) {
        const transform = owner.entity.getComponent(TransformComponent);
        if (!transform) {
          return;
        }
        origin = origin ?? transform.worldPosition;
        direction = direction ?? transform.worldForward;
      }
      direction = direction.normalize();
      const rounds = Math.max(1, Math.floor(config.burstCount ?? 1));
      const interval = Math.max(0, config.burstIntervalSec ?? 0);

      for (let round = 0; round < rounds; round++) {
        // Rounds land on later frames; the shooter can despawn mid-burst.
        if (owner.entity.isDestroyed()) {
          return;
        }

        if (round > 0 && config.refreshAim) {
          const aim = config.refreshAim();
          if (aim) {
            origin = aim.origin;
            direction = aim.direction.normalize();
          }
        }
        await this.fireRound(config, origin, direction);
        if (round < rounds - 1 && interval > 0) {
          await this.delayGameSeconds(interval);
        }
      }
    } finally {
      // In `finally` so every exit path — normal finish, no-transform bail,
      // mid-burst despawn — ends the ability exactly once.
      this.owner.endAbility(this.data.abilityId);
    }
  }

  /**
   * One round: a single delivery, or `pelletCount` of them across a cone.
   * Spread applies to a single-pellet weapon too — that is per-shot inaccuracy,
   * the only thing `spreadDeg` can mean with one pellet.
   */
  private async fireRound(config: TConfig, origin: Vec3, direction: Vec3): Promise<void> {
    const pellets = Math.max(1, Math.floor(config.pelletCount ?? 1));
    const spreadDeg = config.spreadDeg ?? 0;
    const sent: Array<Promise<void>> = [];
    for (let i = 0; i < pellets; i++) {
      const dir = spreadDeg > 0 ? applyConeSpread(direction, spreadDeg) : direction;
      sent.push(this.deliver(config, origin, dir));
    }
    await Promise.all(sent);
  }

  private delayGameSeconds(seconds: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      this.pendingDelay = {remaining: seconds, resolve};
    });
  }
}
