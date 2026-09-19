/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {GASAbility} from '../../abilities/GASAbility';
import {GASComponent} from '../../core/GASComponent';

/** Per-reload parameters, supplied by a {@link ReloadConfigProvider}. */
export interface ReloadConfig {
  /** Attribute holding the current magazine rounds. */
  ammoAttr: string;
  /** Full magazine capacity. */
  magazineSize: number;
  /** Spare rounds outside the magazine. Omit for an infinite reserve. */
  reserveAttr?: string;
  /** Seconds the reload takes. 0 reloads instantly. */
  reloadTimeSec: number;
  /** Invoked with the rounds loaded when a reload completes (cues / analytics). */
  onReloaded?(loaded: number): void;
}

/**
 * Supplies the per-reload config. Implemented by the weapon component; the
 * ability holds it as an interface so the two stay decoupled.
 */
export interface ReloadConfigProvider {
  buildReloadConfig(): ReloadConfig | null;
}

/**
 * Generic timed reload. While it runs the framework holds the reload tag on the
 * owner (`GASAbilityData.tagsAppliedToOwner`, wired by the weapon), which the
 * fire ability lists in `blockedByTags`. On completion it moves rounds from the
 * reserve into the magazine. Applies no other effects, so it imports no game type.
 */
export class WeaponReloadAbility extends GASAbility {
  public configProvider: ReloadConfigProvider | null = null;
  private config: ReloadConfig | null = null;
  private remaining: number = 0;

  /**
   * Reject when there is nothing to load: no config, magazine full, or empty
   * reserve. Checked before the manager applies the reload tag, which matters
   * for pollers — retrying every frame would otherwise add and remove that tag
   * on each one, republishing the owner's whole replicated tag set.
   */
  public override canActivate(): boolean {
    const config = this.configProvider?.buildReloadConfig() ?? null;
    return config != null && this.loadableRounds(config) > 0;
  }

  /**
   * Start the timer. Re-reads the config as a backstop for the conditions
   * {@link canActivate} rejects — it is provider-supplied and may have changed.
   */
  public override onActivate(_userData: unknown): void {
    const config = this.configProvider?.buildReloadConfig() ?? null;
    if (!config || this.loadableRounds(config) <= 0) {
      this.owner.endAbility(this.data.abilityId);
      return;
    }
    this.config = config;
    this.remaining = Math.max(0, config.reloadTimeSec);
    if (this.remaining <= 0) {
      this.complete();
    }
  }

  public override tick(delta: number): void {
    if (!this.config) {
      return;
    }
    this.remaining -= delta;
    if (this.remaining <= 0) {
      this.complete();
    }
  }

  /**
   * Clear transient state. The framework removes the reload tag; the refill
   * happens only in {@link complete}, so a reload cancelled early (death,
   * despawn) leaves ammo untouched.
   */
  public override onEnd(): void {
    this.config = null;
    this.remaining = 0;
  }

  private complete(): void {
    const config = this.config;
    if (config) {
      const loaded = this.transfer(config);
      config.onReloaded?.(loaded);
    }
    this.owner.endAbility(this.data.abilityId);
  }

  /** Rounds loadable now: bounded by magazine space and, if set, the reserve. */
  private loadableRounds(config: ReloadConfig): number {
    const gas = this.owner as unknown as GASComponent;
    const need = config.magazineSize - gas.getAttributeValue(config.ammoAttr);
    if (need <= 0) {
      return 0;
    }
    if (config.reserveAttr === undefined) {
      return need; // infinite reserve
    }
    return Math.min(need, gas.getAttributeValue(config.reserveAttr));
  }

  /** Move rounds reserve → magazine. Returns how many were loaded. */
  private transfer(config: ReloadConfig): number {
    const gas = this.owner as unknown as GASComponent;
    const loaded = this.loadableRounds(config);
    if (loaded <= 0) {
      return 0;
    }
    gas.setAttributeBase(config.ammoAttr, gas.getAttributeValue(config.ammoAttr) + loaded);
    if (config.reserveAttr !== undefined) {
      gas.setAttributeBase(config.reserveAttr, gas.getAttributeValue(config.reserveAttr) - loaded);
    }
    return loaded;
  }
}
