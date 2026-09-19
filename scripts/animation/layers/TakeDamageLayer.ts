/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import {AnimAction, TriggeredLayer} from './TriggeredLayer';

/**
 * The damage flinch. Upper-body while moving so a hit does not stop the legs, full-body at
 * rest — the same speed ramp every masked action layer uses.
 *
 * It carries no duration or cooldown: the layer's own state machine times the reaction and
 * returns to rest on its own, so there is nothing to write before the transition and
 * `beforePlay` stays unoverridden.
 */
export class TakeDamageLayer extends TriggeredLayer {
  readonly layerName: string = 'Take_Damage_Layer';
  readonly restState: string = 'empty_state';
  readonly action: string = AnimAction.FLINCH;

  protected readonly triggerKey: string = 'TakeDamageTrigger';

  protected nextState(): string {
    return 'TakeDamage';
  }
}
