/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import {AnimAction, TriggeredLayer} from './TriggeredLayer';

/** Tuning keys this layer accepts from the gameplay component that owns the swing. */
/* eslint-disable @typescript-eslint/naming-convention -- constants-only class */
export class AttackTuning {
  /** Seconds the swing plays for. */
  static readonly DURATION_SEC = 'attack.durationSec';
  /**
   * Seconds before another swing is allowed. Must stay above 0.1 — the layer leaves on
   * `state_finished AND AttackCooldown > 0.1`, so a 0 freezes the character in the last frame
   * of the swing.
   */
  static readonly COOLDOWN_SEC = 'attack.cooldownSec';
}
/* eslint-enable @typescript-eslint/naming-convention */

/** The one-handed melee swing, on the upper body so locomotion keeps running underneath. */
export class AttackLayer extends TriggeredLayer {
  readonly layerName: string = 'Attack_Layer';
  readonly restState: string = 'Empty State';
  readonly action: string = AnimAction.MELEE;

  protected readonly triggerKey: string = 'AttackTrigger';
  protected readonly interruptKey: string | null = 'AttackInterruptTrigger';

  protected nextState(): string {
    return 'Attack';
  }

  protected override beforePlay(): void {
    this.setVar('attackDuration', this.tuned(AttackTuning.DURATION_SEC, 1.0));
    this.setVar('AttackCooldown', this.tuned(AttackTuning.COOLDOWN_SEC, 0.5));
  }
}
