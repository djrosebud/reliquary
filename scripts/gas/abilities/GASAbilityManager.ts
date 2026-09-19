/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import {EffectContext} from '../core/EffectContext';
import type {EffectActor} from '../core/EffectContext';
import {ModifierOperator} from '../core/Enums';
import type {Effect} from '../effects/Effect';
import type {GASEffectData} from '../effects/GASEffectData';
import {GameplayCueContext} from '../cues/GameplayCueContext';
import type {GameplayCueManager} from '../cues/GameplayCueManager';
import type {GASTagContainer} from '../tags/GASTagContainer';
import {GASAbility} from './GASAbility';
import type {AbilityConstructor, AbilityOwner} from './GASAbility';
import type {GASAbilityData} from './GASAbilityData';

// Structural interface for the AbilityManager's owner. Extends EffectActor
// (for EffectContext usage) and AbilityOwner (passed through to constructed
// GASAbility instances).
export interface AbilityManagerOwner extends EffectActor, AbilityOwner {
  readonly tagContainer: GASTagContainer;
  readonly cueManager: GameplayCueManager;
  broadcastCue(tag: string, ctx: GameplayCueContext): void;
  getAttributeBase(name: string): number;
  applyEffectToSelf(
    data: GASEffectData,
    source?: EffectActor | null,
    level?: number,
  ): Effect | null;
}

export interface GASAbilityManagerOptions {
  owner: AbilityManagerOwner;
}

type AbilityIdListener = (id: string) => void;

export class GASAbilityManager {
  private readonly granted: Map<string, GASAbility> = new Map<string, GASAbility>();

  // Snapshot buffer used by tick() — if Tick triggers EndAbility/RemoveAbility,
  // iterating `granted.values()` directly would mutate while iterating.
  // Reused across frames to avoid per-tick allocation.
  private readonly tickBuffer: GASAbility[] = [];

  private readonly owner: AbilityManagerOwner;

  private readonly grantedListeners: Set<AbilityIdListener> = new Set<AbilityIdListener>();
  private readonly activatedListeners: Set<AbilityIdListener> = new Set<AbilityIdListener>();
  private readonly endedListeners: Set<AbilityIdListener> = new Set<AbilityIdListener>();

  constructor(options: GASAbilityManagerOptions) {
    this.owner = options.owner;
  }

  public tick(delta: number): void {
    this.tickBuffer.length = 0;
    for (const ability of this.granted.values()) {
      this.tickBuffer.push(ability);
    }
    for (const ability of this.tickBuffer) {
      // ability may have been removed by a previous Tick in this same loop;
      // skip stale references.
      const current = this.granted.get(ability.data.abilityId);
      if (current !== ability) {
        continue;
      }

      if (ability.remainingCooldown > 0) {
        ability.remainingCooldown = Math.max(0, ability.remainingCooldown - delta);
      }
      if (ability.isActive) {
        ability.tick(delta);
      }
    }
  }

  public grantAbility(
    data: GASAbilityData,
    abilityClass: AbilityConstructor = GASAbility,
  ): void {
    if (data.abilityId.length === 0) {
      console.warn('GASAbilityManager.grantAbility: abilityId is empty.');
      return;
    }
    if (this.granted.has(data.abilityId)) {
      return;
    }
    const ability = new abilityClass(data, this.owner);
    this.granted.set(data.abilityId, ability);
    this.emitGranted(data.abilityId);
  }

  public removeAbility(id: string): void {
    const ability = this.granted.get(id);
    if (!ability) {
      return;
    }
    if (ability.isActive) {
      this.endAbility(id);
    }
    this.granted.delete(id);
  }

  public isAbilityGranted(id: string): boolean {
    return this.granted.has(id);
  }

  public isOnCooldown(id: string): boolean {
    const ability = this.granted.get(id);
    return ability != null && ability.remainingCooldown > 0;
  }

  public getCooldownRemaining(id: string): number {
    return this.granted.get(id)?.remainingCooldown ?? 0;
  }

  public isAbilityActive(id: string): boolean {
    const ability = this.granted.get(id);
    return ability != null && ability.isActive;
  }

  public getAbility(id: string): GASAbility | null {
    return this.granted.get(id) ?? null;
  }

  public canActivateAbility(id: string): boolean {
    const ability = this.granted.get(id);
    if (!ability) {
      return false;
    }
    if (ability.remainingCooldown > 0) {
      return false;
    }
    if (!this.checkTags(ability)) {
      return false;
    }
    if (!this.canPayCost(ability)) {
      return false;
    }
    // Subclass gate last: the checks above are data-driven and cheap, this one
    // runs arbitrary override code.
    if (!ability.canActivate()) {
      return false;
    }
    return true;
  }

  public tryActivateAbility(id: string, userData: unknown = null): boolean {
    if (!this.canActivateAbility(id)) {
      return false;
    }
    const ability = this.granted.get(id);
    if (!ability) {
      return false;
    }
    this.commit(ability);
    this.applyTagsToOwner(ability);
    ability.isActive = true;
    // Announce the activation BEFORE running the ability body. An ability is
    // allowed to end itself inside onActivate (an instant ability, or one whose
    // work turned out to be a no-op), and emitting afterwards would deliver
    // Ended before Activated and play the end cue before the activate cue.
    this.emitActivated(id);
    this.emitAbilityCues(ability.data.gameplayCueTagsOnActivate);
    ability.onActivate(userData);
    return true;
  }

  public endAbility(id: string): void {
    const ability = this.granted.get(id);
    if (!ability) {
      return;
    }
    if (!ability.isActive) {
      return;
    }
    ability.isActive = false;
    this.removeTagsFromOwner(ability);
    // Announce before running the body, matching tryActivateAbility. Both
    // transitions follow one rule — publish the state change, then run the
    // subclass hook — so a hook that triggers the opposite transition can never
    // deliver the two events out of order.
    this.emitEnded(id);
    this.emitAbilityCues(ability.data.gameplayCueTagsOnEnd);
    ability.onEnd();
  }

  public onAbilityGranted(listener: AbilityIdListener): () => void {
    this.grantedListeners.add(listener);
    return (): void => {
      this.grantedListeners.delete(listener);
    };
  }

  public onAbilityActivated(listener: AbilityIdListener): () => void {
    this.activatedListeners.add(listener);
    return (): void => {
      this.activatedListeners.delete(listener);
    };
  }

  public onAbilityEnded(listener: AbilityIdListener): () => void {
    this.endedListeners.add(listener);
    return (): void => {
      this.endedListeners.delete(listener);
    };
  }

  private checkTags(ability: GASAbility): boolean {
    const tagContainer = this.owner.tagContainer;
    if (ability.data.requiredTags.length > 0 && !tagContainer.hasAllTags(ability.data.requiredTags)) {
      return false;
    }
    if (ability.data.blockedByTags.length > 0 && tagContainer.hasAnyTag(ability.data.blockedByTags)) {
      return false;
    }
    return true;
  }

  private canPayCost(ability: GASAbility): boolean {
    const cost = ability.data.costEffect;
    if (cost == null) {
      return true;
    }
    const ctx = new EffectContext(this.owner, this.owner, 1);
    for (const modConfig of cost.modifiers) {
      if (modConfig.attribute == null) {
        continue;
      }
      if (modConfig.operator !== ModifierOperator.Add) {
        continue;
      }
      const currentBase = this.owner.getAttributeBase(modConfig.attribute.attributeName);
      const magnitude = modConfig.computeMagnitude(ctx);
      if (currentBase + magnitude < modConfig.attribute.minValue) {
        return false;
      }
    }
    return true;
  }

  private commit(ability: GASAbility): void {
    if (ability.data.costEffect != null) {
      this.owner.applyEffectToSelf(ability.data.costEffect);
    }
    ability.remainingCooldown = ability.data.cooldown;
  }

  private applyTagsToOwner(ability: GASAbility): void {
    const tagContainer = this.owner.tagContainer;
    for (const tag of ability.data.tagsAppliedToOwner) {
      tagContainer.addTag(tag);
    }
  }

  private removeTagsFromOwner(ability: GASAbility): void {
    const tagContainer = this.owner.tagContainer;
    for (const tag of ability.data.tagsAppliedToOwner) {
      tagContainer.removeTag(tag);
    }
  }

  private emitAbilityCues(tags: ReadonlyArray<string>): void {
    if (tags.length === 0) {
      return;
    }
    const ctx = new GameplayCueContext({
      target: this.owner,
      source: this.owner,
      magnitude: 0,
    });
    for (const tag of tags) {
      this.owner.broadcastCue(tag, ctx);
    }
  }

  private emitGranted(id: string): void {
    for (const listener of this.grantedListeners) {
      listener(id);
    }
  }

  private emitActivated(id: string): void {
    for (const listener of this.activatedListeners) {
      listener(id);
    }
  }

  private emitEnded(id: string): void {
    for (const listener of this.endedListeners) {
      listener(id);
    }
  }
}
