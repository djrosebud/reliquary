/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {
  DurationPolicy,
  StackDurationRefreshPolicy,
  StackExpirationPolicy,
  StackPeriodResetPolicy,
  StackingPolicy,
} from '../core/Enums';
import type {GASEffectModifier} from './GASEffectModifier';

export interface GASEffectDataInit {
  durationPolicy?: DurationPolicy;
  duration?: number;
  period?: number;
  tickImmediately?: boolean;
  modifiers?: GASEffectModifier[];
  tagsAppliedToTarget?: string[];

  // Stable id used to reference this effect across the network. Effects applied
  // to a remote (proxy) target are routed by id — the target's authority looks
  // the definition up in its own registry (see GASComponent.registerEffect).
  // Local / single-player application does not need it. Register with
  // GASComponent.registerEffect so cross-authority application can resolve it.
  //
  // Doubles as the stacking identity key: GASEffectManager.findStackable treats
  // two applies sharing an id as the same effect. So rebuilding a GASEffectData
  // per application under a shared id merges into the existing stack and keeps
  // the FIRST instance's definition — per-application magnitudes are dropped.
  effectId?: string;

  stacking?: StackingPolicy;
  maxStack?: number;
  durationRefresh?: StackDurationRefreshPolicy;
  periodReset?: StackPeriodResetPolicy;
  expiration?: StackExpirationPolicy;

  gameplayCueTagsOnExecute?: string[];
}

export class GASEffectData {
  public durationPolicy: DurationPolicy;
  public duration: number;
  public period: number;
  public tickImmediately: boolean;

  public modifiers: GASEffectModifier[];

  public tagsAppliedToTarget: string[];

  // Stable id for cross-network application; '' means not networkable by id.
  public effectId: string;

  // Stacking. None (default) creates an independent Effect instance per apply.
  // AggregateBy* makes a second apply of the same (Data[, Source]) merge into
  // the existing instance: StackCount++ plus the configured refresh / reset
  // policies. Instant effects never participate in stacking — they never
  // enter the activeEffects queue.
  public stacking: StackingPolicy;
  public maxStack: number;
  public durationRefresh: StackDurationRefreshPolicy;
  public periodReset: StackPeriodResetPolicy;
  public expiration: StackExpirationPolicy;

  // Cues. Emitted on every Instant application (including each Period DoT
  // tick). The CueManager routes them to handlers (VFX / SFX / camera shake).
  public gameplayCueTagsOnExecute: string[];

  constructor(init: GASEffectDataInit = {}) {
    this.durationPolicy = init.durationPolicy ?? DurationPolicy.Instant;
    this.duration = init.duration ?? 0;
    this.period = init.period ?? 0;
    this.tickImmediately = init.tickImmediately ?? false;
    this.modifiers = init.modifiers ?? [];
    this.tagsAppliedToTarget = init.tagsAppliedToTarget ?? [];
    this.effectId = init.effectId ?? '';
    this.stacking = init.stacking ?? StackingPolicy.None;
    this.maxStack = init.maxStack ?? 1;
    this.durationRefresh = init.durationRefresh ?? StackDurationRefreshPolicy.RefreshOnAdd;
    this.periodReset = init.periodReset ?? StackPeriodResetPolicy.NeverReset;
    this.expiration = init.expiration ?? StackExpirationPolicy.ClearEntireStack;
    this.gameplayCueTagsOnExecute = init.gameplayCueTagsOnExecute ?? [];
  }
}
