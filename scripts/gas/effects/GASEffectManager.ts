/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import type {GASAttributeSet} from '../attributes/GASAttributeSet';
import {Modifier} from '../attributes/Modifier';
import {EffectContext} from '../core/EffectContext';
import type {EffectActor} from '../core/EffectContext';
import {
  DurationPolicy,
  StackDurationRefreshPolicy,
  StackExpirationPolicy,
  StackPeriodResetPolicy,
  StackingPolicy,
} from '../core/Enums';
import {GameplayCueContext} from '../cues/GameplayCueContext';
import type {GameplayCueManager} from '../cues/GameplayCueManager';
import type {GASTagContainer} from '../tags/GASTagContainer';
import {Effect} from './Effect';
import type {GASEffectData} from './GASEffectData';

// Structural interface for effect application targets.
export interface EffectTarget {
  readonly effectManager: GASEffectManager;
}

// Structural interface for the EffectManager's owner. Extends EffectActor for
// EffectContext usage; adds cueManager for emitCuesOnExecute.
export interface EffectManagerOwner extends EffectActor {
  readonly cueManager: GameplayCueManager;
  broadcastCue(tag: string, ctx: GameplayCueContext): void;
}

export interface GASEffectManagerOptions {
  owner: EffectManagerOwner;
  attributeSet: GASAttributeSet;
  tagContainer: GASTagContainer;
}

type EffectAppliedListener = (data: GASEffectData) => void;
type EffectRemovedListener = (data: GASEffectData) => void;
type EffectStackedListener = (data: GASEffectData, newStackCount: number) => void;
type EffectUnstackedListener = (data: GASEffectData, newStackCount: number) => void;

export class GASEffectManager {
  private readonly activeEffects: Effect[] = [];
  private readonly owner: EffectManagerOwner;
  private readonly attributeSet: GASAttributeSet;
  private readonly tagContainer: GASTagContainer;

  private readonly effectAppliedListeners: Set<EffectAppliedListener> =
    new Set<EffectAppliedListener>();
  private readonly effectRemovedListeners: Set<EffectRemovedListener> =
    new Set<EffectRemovedListener>();
  private readonly effectStackedListeners: Set<EffectStackedListener> =
    new Set<EffectStackedListener>();
  private readonly effectUnstackedListeners: Set<EffectUnstackedListener> =
    new Set<EffectUnstackedListener>();

  constructor(options: GASEffectManagerOptions) {
    this.owner = options.owner;
    this.attributeSet = options.attributeSet;
    this.tagContainer = options.tagContainer;
  }

  public tick(delta: number): void {
    for (let i = this.activeEffects.length - 1; i >= 0; i--) {
      const effect = this.activeEffects[i];
      const canTick = effect.updateTimers(delta);

      if (canTick) {
        this.applyAsInstant(effect);
      }

      if (effect.hasFinished()) {
        this.handleExpiration(effect);
      }
    }
  }

  public applyEffectToSelf(
    data: GASEffectData,
    source: EffectActor | null = null,
    level: number = 1,
  ): Effect | null {
    const ctx = new EffectContext(source ?? this.owner, this.owner, level);

    // Stacking path. Only applies to Durational/Infinite — Instant always
    // takes the create-and-discard path; it never enters activeEffects and
    // has no stacking concept.
    if (data.stacking !== StackingPolicy.None && data.durationPolicy !== DurationPolicy.Instant) {
      const existing = this.findStackable(data, ctx.source);
      if (existing != null) {
        return this.mergeIntoStack(existing);
      }
    }

    const effect = new Effect(data, ctx);

    for (const tag of data.tagsAppliedToTarget) {
      this.tagContainer.addTag(tag);
    }

    switch (data.durationPolicy) {
      case DurationPolicy.Instant:
        this.applyAsInstant(effect);
        break;
      case DurationPolicy.Durational:
      case DurationPolicy.Infinite:
        if (data.period > 0) {
          if (data.tickImmediately) {
            this.applyAsInstant(effect);
          }
          this.activeEffects.push(effect);
        } else {
          this.applyAsModifiers(effect);
          this.activeEffects.push(effect);
        }
        break;
    }

    this.emitEffectApplied(data);
    return effect;
  }

  public applyEffectToTarget(
    target: EffectTarget,
    data: GASEffectData,
    level: number = 1,
  ): Effect | null {
    return target.effectManager.applyEffectToSelf(data, this.owner, level);
  }

  public removeEffect(effect: Effect): void {
    const idx = this.activeEffects.indexOf(effect);
    if (idx < 0) {
      return;
    }
    this.activeEffects.splice(idx, 1);

    for (const mod of effect.appliedModifiers) {
      this.attributeSet.removeModifier(mod);
    }
    effect.appliedModifiers.length = 0;

    for (const tag of effect.data.tagsAppliedToTarget) {
      // Strip all StackCount layers of this tag at once (matches each
      // stack-add having added one layer).
      this.tagContainer.removeTag(tag, effect.stackCount);
    }

    this.emitEffectRemoved(effect.data);
  }

  // Manual stack removal (e.g. shield breaking by one layer, antidote
  // removing one stack). count >= current stackCount is equivalent to
  // removeEffect.
  public removeEffectStack(effect: Effect, count: number = 1): void {
    if (count <= 0) {
      return;
    }
    if (this.activeEffects.indexOf(effect) < 0) {
      return;
    }

    if (count >= effect.stackCount) {
      this.removeEffect(effect);
      return;
    }

    effect.stackCount -= count;
    this.attributeSet.recomputeForEffect(effect);
    for (const tag of effect.data.tagsAppliedToTarget) {
      this.tagContainer.removeTag(tag, count);
    }
    this.emitEffectUnstacked(effect.data, effect.stackCount);
  }

  public getStackCount(data: GASEffectData): number {
    for (const e of this.activeEffects) {
      if (e.data === data) {
        return e.stackCount;
      }
    }
    return 0;
  }

  public getActiveEffects(): ReadonlyArray<Effect> {
    return this.activeEffects;
  }

  public onEffectApplied(listener: EffectAppliedListener): () => void {
    this.effectAppliedListeners.add(listener);
    return (): void => {
      this.effectAppliedListeners.delete(listener);
    };
  }

  public onEffectRemoved(listener: EffectRemovedListener): () => void {
    this.effectRemovedListeners.add(listener);
    return (): void => {
      this.effectRemovedListeners.delete(listener);
    };
  }

  public onEffectStacked(listener: EffectStackedListener): () => void {
    this.effectStackedListeners.add(listener);
    return (): void => {
      this.effectStackedListeners.delete(listener);
    };
  }

  public onEffectUnstacked(listener: EffectUnstackedListener): () => void {
    this.effectUnstackedListeners.add(listener);
    return (): void => {
      this.effectUnstackedListeners.delete(listener);
    };
  }

  private findStackable(data: GASEffectData, source: EffectActor | null): Effect | null {
    for (const e of this.activeEffects) {
      // Match by effectId when set (so a fresh GASEffectData built per application still
      // aggregates), otherwise fall back to object identity.
      const sameEffect =
        data.effectId.length > 0 ? e.data.effectId === data.effectId : e.data === data;
      if (!sameEffect) {
        continue;
      }
      if (data.stacking === StackingPolicy.AggregateBySource && e.context.source !== source) {
        continue;
      }
      return e;
    }
    return null;
  }

  private mergeIntoStack(existing: Effect): Effect {
    const atCap = existing.stackCount >= existing.data.maxStack;
    if (!atCap) {
      existing.stackCount++;
      // Mirrors the "AddTag once per apply" semantics — one extra stack
      // means one extra tag stack. removeEffect later balances it back via
      // removeTag(tag, stackCount).
      for (const tag of existing.data.tagsAppliedToTarget) {
        this.tagContainer.addTag(tag);
      }
      this.attributeSet.recomputeForEffect(existing);
      this.emitEffectStacked(existing.data, existing.stackCount);
    }

    // Refresh policies run on every apply, even at the stack cap (a cap
    // means you can refresh but not add more).
    if (existing.data.durationRefresh === StackDurationRefreshPolicy.RefreshOnAdd) {
      existing.resetDuration();
    }
    if (existing.data.periodReset === StackPeriodResetPolicy.ResetOnAdd) {
      existing.resetPeriod();
    }

    return existing;
  }

  private handleExpiration(effect: Effect): void {
    if (
      effect.data.expiration === StackExpirationPolicy.RemoveSingleStack &&
      effect.stackCount > 1
    ) {
      effect.stackCount--;
      effect.resetDuration();
      this.attributeSet.recomputeForEffect(effect);
      for (const tag of effect.data.tagsAppliedToTarget) {
        this.tagContainer.removeTag(tag, 1);
      }
      this.emitEffectUnstacked(effect.data, effect.stackCount);
    } else {
      this.removeEffect(effect);
    }
  }

  private applyAsInstant(effect: Effect): void {
    for (const modConfig of effect.data.modifiers) {
      if (modConfig.attribute == null) {
        continue;
      }
      let magnitude = modConfig.computeMagnitude(effect.context);
      // DoT × stack: a period tick writes base once, magnitude × current
      // stack count. Non-stacking effects keep stackCount = 1 and are
      // unaffected.
      magnitude *= effect.stackCount;

      const attrName = modConfig.attribute.attributeName;
      const attr = this.attributeSet.getAttribute(attrName);
      if (attr == null) {
        continue;
      }

      const oldBase = attr.baseValue;
      this.attributeSet.applyInstantModifier(attrName, modConfig.operator, magnitude);
      const delta = attr.baseValue - oldBase;

      // Post hook: gives game code a chance to route Meta Attributes or
      // emit custom signals after base has been written and recomputed.
      // Period DoT ticks reach this path via canTick → applyAsInstant.
      this.attributeSet.invokePostExecute(effect.context, attr, delta);
    }

    // Cues fire on every Instant application (including each Period DoT tick).
    this.emitCuesOnExecute(effect);
  }

  private emitCuesOnExecute(effect: Effect): void {
    const tags = effect.data.gameplayCueTagsOnExecute;
    if (tags.length === 0) {
      return;
    }
    const ctx = new GameplayCueContext({
      target: effect.context.target,
      source: effect.context.source,
      magnitude: computeFirstModifierMagnitude(effect),
    });
    for (const tag of tags) {
      this.owner.broadcastCue(tag, ctx);
    }
  }

  private applyAsModifiers(effect: Effect): void {
    for (const modConfig of effect.data.modifiers) {
      if (modConfig.attribute == null) {
        continue;
      }
      const magnitude = modConfig.computeMagnitude(effect.context);
      // Stack scaling reads SourceEffect.StackCount inside the aggregator
      // at recompute time, so we must NOT pre-multiply here. Otherwise a
      // later stack change would not flow into the modifier's magnitude.
      const mod = new Modifier(
        modConfig.attribute.attributeName,
        modConfig.operator,
        magnitude,
        effect,
      );
      effect.appliedModifiers.push(mod);
      this.attributeSet.addModifier(mod);
    }
  }

  private emitEffectApplied(data: GASEffectData): void {
    for (const listener of this.effectAppliedListeners) {
      listener(data);
    }
  }

  private emitEffectRemoved(data: GASEffectData): void {
    for (const listener of this.effectRemovedListeners) {
      listener(data);
    }
  }

  private emitEffectStacked(data: GASEffectData, newStackCount: number): void {
    for (const listener of this.effectStackedListeners) {
      listener(data, newStackCount);
    }
  }

  private emitEffectUnstacked(data: GASEffectData, newStackCount: number): void {
    for (const listener of this.effectUnstackedListeners) {
      listener(data, newStackCount);
    }
  }
}

// Magnitude carried in the cue context. Takes the first modifier's effective
// magnitude (× stackCount). Multi-modifier effects can recompute on the
// game side via the effect data if a single value is insufficient.
function computeFirstModifierMagnitude(effect: Effect): number {
  if (effect.data.modifiers.length === 0) {
    return 0;
  }
  const first = effect.data.modifiers[0];
  return Math.abs(first.computeMagnitude(effect.context) * effect.stackCount);
}
