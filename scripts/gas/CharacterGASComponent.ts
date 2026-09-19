/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v2

import {component, editor, property, rpc, ExecuteOn, type Entity} from 'meta/worlds';
import {GASComponent} from './core/GASComponent';
import {GASAttributeData} from './attributes/GASAttributeData';
import type {GASAttribute} from './attributes/GASAttribute';
import type {EffectContext} from './core/EffectContext';
import {createDamageEffect, HEALTH_ATTR} from './weapons/core/WeaponSetup';
import {CharacterAnimationController} from '../animation/CharacterAnimationController';
import {AnimAction} from '../animation/layers/TriggeredLayer';
import {CharacterStateMachine} from '../Character/State/CharacterStateMachine';

/** Applied at zero health. Hierarchical: `blockedByTags: ['state']` matches it. */
export const DEAD_TAG = 'state.dead';

/** Attribute holding the ceiling that healing cannot exceed. */
export const MAX_HEALTH_ATTR = 'max_health';

/**
 * Character health as a GAS attribute: seeds `health` and `max_health`, clamps
 * them, applies {@link DEAD_TAG} at zero and drives the entity's animation and
 * state machine. Both are optional, so this serves player and NPC alike.
 */
@component({
  description:
    "Character health as a GAS attribute: seeds and clamps it, applies the death tag at zero, and drives the entity's animation and state machine.",
})
export class CharacterGASComponent extends GASComponent {
  @editor({
    description:
      'Starting and maximum health. Damage effects subtract from this; it is the ' +
      'ceiling healing cannot exceed.',
  })
  @property()
  public maxHealth: number = 100;

  protected animation: CharacterAnimationController | null = null;
  protected stateMachine: CharacterStateMachine | null = null;
  private resolved: boolean = false;

  /** True once health has reached zero. Never clears — respawn, do not revive. */
  // Pending is promoted in onDamaged, so an unattributed hit reports no
  // attacker rather than the previous one.
  private pendingAttacker: Entity | null = null;
  private pendingKnockbackMultiplier: number = 1;
  private lastAttacker: Entity | null = null;
  private lastKnockbackMultiplier: number = 1;

  /** Call immediately before takeDamage(), on the owner. */
  public recordAttacker(attacker: Entity, knockbackMultiplier: number = 1): void {
    this.pendingAttacker = attacker;
    this.pendingKnockbackMultiplier = knockbackMultiplier;
  }

  public getLastAttacker(): Entity | null {
    // Validity checked on read; the attacker can be destroyed before the
    // stagger polls for it.
    if (this.lastAttacker != null && !this.lastAttacker.valid) {
      this.lastAttacker = null;
      this.lastKnockbackMultiplier = 1;
    }
    return this.lastAttacker;
  }

  public getLastKnockbackMultiplier(): number {
    return this.lastKnockbackMultiplier;
  }

  public get isDead(): boolean {
    return this.hasTag(DEAD_TAG);
  }

  /** Current health, for HUD and debug. */
  public get health(): number {
    return this.getAttributeValue(HEALTH_ATTR);
  }

  protected override getInitialAttributes(): ReadonlyArray<GASAttributeData> {
    const max = Math.max(1, this.maxHealth);
    return [
      new GASAttributeData({
        attributeName: HEALTH_ATTR,
        defaultValue: max,
        minValue: 0,
        maxValue: max,
        description: 'Current health. Zero applies the death tag.',
      }),
      new GASAttributeData({
        attributeName: MAX_HEALTH_ATTR,
        defaultValue: max,
        minValue: max,
        maxValue: max,
        description: 'Maximum health. Constant; the ceiling for healing.',
      }),
    ];
  }

  /** Applies damage from a non-GAS source, on the health owner. */
  public takeDamage(amount: number): void {
    if (amount <= 0) {
      return;
    }
    // Routes the amount, not the effect: effect IDs resolve against a registry
    // local to each machine.
    if (this.entity.networked && !this.entity.isOwned()) {
      this.RpcTakeDamage(amount);
      return;
    }
    this.applyDamageHere(amount);
  }

  @rpc({execution: ExecuteOn.Owner})
  RpcTakeDamage(amount: number): void {
    this.applyDamageHere(amount);
  }

  private applyDamageHere(amount: number): void {
    if (this.isDead) {
      return;
    }
    // Via an effect, not a direct write: only the effect path reaches
    // postGameplayEffectExecute.
    this.applyEffectToSelf(createDamageEffect('character.damage.' + String(amount), amount));
  }

  /** Clamps to [0, maxHealth]; GAS clamps currentValue but not base. */
  protected override preAttributeBaseChange(attributeName: string, newValue: number): number {
    if (attributeName !== HEALTH_ATTR) {
      return newValue;
    }
    const max = Math.max(1, this.maxHealth);
    return Math.min(Math.max(newValue, 0), max);
  }

  protected override postGameplayEffectExecute(
    _ctx: EffectContext,
    attribute: GASAttribute,
    magnitudeDelta: number,
  ): void {
    if (attribute.data.attributeName !== HEALTH_ATTR) {
      return;
    }
    if (magnitudeDelta >= 0) {
      return;
    }
    if (this.isDead) {
      return;
    }
    this.resolveTargets();

    if (attribute.currentValue > 0) {
      this.onDamaged(-magnitudeDelta, attribute.currentValue);
      return;
    }
    this.onDamaged(-magnitudeDelta, 0);
    this.applyDeath();
  }

  protected applyDeath(): void {
    // Tag first: anything gating on it must see a dead character before the
    // animation and state machine react.
    this.addLooseTag(DEAD_TAG);
    this.stateMachine?.setDead(true);
    this.animation?.setLayerActive(AnimAction.DEATH, true);
    console.log(`[CharacterGAS] ${this.entity.name} died`);
  }

  /** Resolved lazily; start order against these two is not guaranteed. */
  protected resolveTargets(): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.animation = this.entity.getComponent(CharacterAnimationController);
    this.stateMachine = this.entity.getComponent(CharacterStateMachine);
  }

  /** Damage only; never healing. Override to extend. */
  protected onDamaged(_amount: number, remainingHealth: number): void {
    this.lastAttacker = this.pendingAttacker;
    this.lastKnockbackMultiplier = this.pendingKnockbackMultiplier;
    this.pendingAttacker = null;
    this.pendingKnockbackMultiplier = 1;
    if (remainingHealth > 0) {
      this.animation?.play(AnimAction.FLINCH);
    }
  }
}
