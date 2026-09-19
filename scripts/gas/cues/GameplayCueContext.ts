/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {Vec3} from 'meta/worlds';
import type {EffectActor} from '../core/EffectContext';

/**
 * Presentation data passed to a cue handler when a cue fires. Target / source
 * carry GAS identity (who hit whom). Location / normal / magnitude carry the
 * spatial and intensity information used to spawn VFX, SFX, camera shake, etc.
 */

export interface GameplayCueContextInit {
  target?: EffectActor | null;
  source?: EffectActor | null;
  location?: Vec3;
  normal?: Vec3;
  magnitude?: number;
}

export class GameplayCueContext {
  public target: EffectActor | null;
  public source: EffectActor | null;
  public location: Vec3;
  public normal: Vec3;
  public magnitude: number;

  constructor(init: GameplayCueContextInit = {}) {
    this.target = init.target ?? null;
    this.source = init.source ?? null;
    this.location = init.location ?? Vec3.zero;
    this.normal = init.normal ?? new Vec3(0, 1, 0);
    this.magnitude = init.magnitude ?? 0;
  }
}
