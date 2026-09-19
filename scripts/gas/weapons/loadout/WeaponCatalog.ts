/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {FireMode} from '../core/WeaponTrigger';

/**
 * One weapon's numbers. Everything a projectile weapon needs except the bullet
 * template, which is an editor asset reference and so cannot live in code.
 *
 * This is the data half of {@link WeaponLoadoutComponent}: a loadout is an array
 * of these, supplied by a concrete subclass. Editor-authored single weapons use
 * WeaponProjectileComponent's `@property` block instead, which carries the same
 * fields.
 */
export interface WeaponStats {
  /**
   * Namespaces this weapon's magazine and abilities on the shared GASComponent,
   * and derives its damage effect id. MUST be unique within a loadout — a
   * duplicate is silently ignored at registration, leaving the second weapon
   * sharing the first one's magazine.
   */
  key: string;

  /** Shown in the console on equip, so the demo is readable with no UI. */
  displayName: string;

  /** Subtracted per hit. For a shotgun this is PER PELLET, not per shot. */
  damage: number;

  /** Shots per second; the fire cooldown is its reciprocal. */
  fireRate: number;

  /** Projectiles per round. 1 for a normal gun, 8-12 for a shotgun. */
  pelletCount: number;

  /** Cone half-angle in degrees. 0 is perfectly accurate. */
  spreadDeg: number;

  /** Rounds before a reload. */
  magazineSize: number;

  /** Seconds a reload takes. Firing is blocked throughout. */
  reloadTimeSec: number;

  /** semi fires once per pull; auto keeps firing while held. */
  fireMode: FireMode;

  /**
   * Travel speed in m/s. A projectile steps once per frame, so at 60fps a speed
   * of 30 moves it 0.5 m per step — anything much faster can straddle a thin
   * target between frames and pass through without ever overlapping its trigger.
   * Raise it only alongside a deeper target collider.
   */
  speed: number;

  /**
   * Seconds before an unspent projectile despawns. Speed times lifetime is the
   * effective range, and the only range limit there is — damage does not fall
   * off, so a short lifetime is what makes a shotgun a close-range weapon.
   */
  lifetimeSec: number;
}
