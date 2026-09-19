/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {GASAbilityData} from './GASAbilityData';

// Structural interface for the ability owner. Lists the minimum surface used
// by base helpers (self-ending / self-removing patterns); game-side subclasses
// can cast `this.owner` to GASComponent for the full facade.
export interface AbilityOwner {
  removeAbility(id: string): void;
  endAbility(id: string): void;
}

export class GASAbility {
  public readonly data: GASAbilityData;
  public readonly owner: AbilityOwner;
  public remainingCooldown: number = 0;
  public isActive: boolean = false;

  constructor(data: GASAbilityData, owner: AbilityOwner) {
    this.data = data;
    this.owner = owner;
  }

  /**
   * Subclass activation gate, checked after cooldown / tags / cost and before
   * anything is committed, so a doomed activation costs nothing.
   *
   * Reached through the public `canActivateAbility` query, which callers use
   * speculatively — must be side-effect free. It carries no userData, so
   * payload-specific checks belong in `onActivate`.
   */
  public canActivate(): boolean {
    return true;
  }

  public onActivate(_userData: unknown): void {
    // Default no-op. Override in subclass.
  }

  public onEnd(): void {
    // Default no-op. Override in subclass.
  }

  public tick(_delta: number): void {
    // Default no-op. Override in subclass for channelled abilities.
  }
}

// Constructor signature for an ability class. Used by GASAbilityManager.grantAbility
// to instantiate the right runtime subclass.
export type AbilityConstructor<T extends GASAbility = GASAbility> = new (
  data: GASAbilityData,
  owner: AbilityOwner,
) => T;
