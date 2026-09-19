/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {EffectContext} from '../core/EffectContext';
import {DurationPolicy} from '../core/Enums';
import type {Modifier} from '../attributes/Modifier';
import type {GASEffectData} from './GASEffectData';

export class Effect {
  public readonly data: GASEffectData;
  public readonly context: EffectContext;
  public readonly appliedModifiers: Modifier[] = [];

  // Current stack count. New effects default to 1; merging into an existing
  // stack increments. Always 1 for StackingPolicy.None.
  public stackCount: number = 1;

  public remainingDuration: number;
  public timeUntilNextTick: number;

  constructor(data: GASEffectData, context: EffectContext) {
    this.data = data;
    this.context = context;
    this.remainingDuration = data.duration;
    this.timeUntilNextTick = data.tickImmediately ? 0 : data.period;
  }

  // Advance timers; returns whether this frame should fire a period tick.
  public updateTimers(delta: number): boolean {
    let canTick = false;

    if (this.data.durationPolicy === DurationPolicy.Durational) {
      this.remainingDuration -= delta;
    }

    if (this.data.period > 0) {
      this.timeUntilNextTick -= delta;
      if (this.timeUntilNextTick <= 0) {
        // `+= period` (not `=`) preserves overshoot, so drift does not
        // accumulate across ticks. Otherwise period boundaries would drift
        // against the frame boundary and the last tick near the duration
        // boundary could be dropped.
        this.timeUntilNextTick += this.data.period;
        canTick = true;
      }
    }

    return canTick;
  }

  public hasFinished(): boolean {
    switch (this.data.durationPolicy) {
      case DurationPolicy.Instant:
        return true;
      case DurationPolicy.Durational:
        return this.remainingDuration <= 0;
      case DurationPolicy.Infinite:
        return false;
      default:
        return false;
    }
  }

  public resetDuration(): void {
    this.remainingDuration = this.data.duration;
  }

  public resetPeriod(): void {
    this.timeUntilNextTick = this.data.period;
  }
}
