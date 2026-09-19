/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import {AnimAction, TriggeredLayer} from './TriggeredLayer';

/** Tuning keys this layer accepts from the gameplay component that owns the shot. */
/* eslint-disable @typescript-eslint/naming-convention -- constants-only class */
export class RangedTuning {
  static readonly DURATION_SEC = 'ranged.durationSec';
  /** Same `> 0.1` exit gate as the melee layer — a 0 freezes the ranged pose. */
  static readonly COOLDOWN_SEC = 'ranged.cooldownSec';
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * The ranged fire / throw, on its own layer rather than as a second state on the melee layer.
 *
 * They are mutually exclusive in gameplay, so one layer with two states would also work; they
 * are kept apart because a weapon swap should be able to add or remove a whole family of
 * motion without editing a layer another weapon is using.
 */
export class RangedLayer extends TriggeredLayer {
  readonly layerName: string = 'Ranged_Layer';
  readonly restState: string = 'Empty State';
  readonly action: string = AnimAction.RANGED;

  protected readonly triggerKey: string = 'RangedTrigger';

  protected nextState(): string {
    return 'AttackRanged';
  }

  protected override beforePlay(): void {
    this.setVar('AttackRangedDuration', this.tuned(RangedTuning.DURATION_SEC, 1.0));
    this.setVar('AttackRangedCooldown', this.tuned(RangedTuning.COOLDOWN_SEC, 0.5));
  }
}
