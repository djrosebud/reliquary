/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import {AnimLayer, AnimTag, type AnimFrame} from './AnimLayer';

/**
 * The gameplay intents a character can ask its animation for.
 *
 * These name what the character is DOING, never which layer plays it — that indirection is
 * what lets a new layer claim an intent without any caller learning it exists. A new weapon
 * class adds a constant here and a layer that claims it; nothing else changes.
 */
// Values are stable identifiers, not authored graph names.
/* eslint-disable @typescript-eslint/naming-convention */
export class AnimAction {
  static readonly MELEE = 'melee';
  static readonly RANGED = 'ranged';
  static readonly FLINCH = 'flinch';
  /** Persistent rather than one-shot: addressed with setActive, not request. */
  static readonly DEATH = 'death';
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * TriggeredLayer — a layer driven by discrete facts: something happens, the layer plays a
 * state, the state ends and the layer returns to rest. Melee, ranged, the damage flinch, and
 * any future magic or block layer are all this shape.
 *
 * WHY THEY SHARE A CLASS RATHER THAN A CONFIG TABLE. Their flow is identical — refuse while
 * suppressed, replicate, write the graph variables the state needs, transition — and only the
 * authored names differ. Expressing that as a table of rows would force every future variant
 * to become a new column on every row; expressing it as a class means a variant overrides one
 * method and leaves its siblings untouched. {@link nextState} is the hook a combo layer
 * overrides to advance through `Attack_01/02/03`; {@link beforePlay} is the hook a layer with
 * timing variables overrides.
 *
 * WEAPON LAYERS ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION, not by arbitration. Each claims its
 * own {@link action}, so swapping a weapon changes which intent the gameplay side asks for and
 * the other layers simply never hear about it — no layer needs to know its siblings exist, and
 * none of them needs deactivating.
 *
 * The族 defaults to an upper-body mask ramp, because an action taken at a run should leave the
 * legs to locomotion. A full-body triggered layer overrides {@link maskWeight} back to null.
 */
export abstract class TriggeredLayer extends AnimLayer {
  /** Replication channel for "play it". */
  protected abstract readonly triggerKey: string;

  /**
   * Replication channel for "abort it early", or null when the action cannot be cut short.
   * Its own channel rather than a flag on the trigger, so the faster blend survives the trip
   * to remote clients.
   */
  protected readonly interruptKey: string | null = null;

  /**
   * Blend time for an abort. Shorter than an ordinary transition so the abort reads as the
   * action having been cut off rather than easing out on its own schedule.
   */
  protected readonly interruptTransitionTimeSec: number = 0.08;

  /** The death pose owns the whole body; a triggered action layered over it is an artifact. */
  protected readonly suppressedBy: readonly string[] = [AnimTag.DEAD];

  public override get netKeys(): readonly string[] {
    return this.interruptKey === null
      ? [this.triggerKey]
      : [this.triggerKey, this.interruptKey];
  }

  /** Which state to play for this firing. Override to advance a combo. */
  protected abstract nextState(): string;

  /**
   * Write any graph variables the state needs, before the transition.
   *
   * Ordering is load-bearing where a layer gates its own exit on a variable: the attack layers
   * leave on `state_finished AND <cooldown> > 0.1`, so a cooldown still unwritten reads 0 and
   * the character freezes in the last frame of the pose. This runs inside the apply path, not
   * the request path, so a proxy — which reaches the transition through replication and never
   * through {@link request} — writes them too.
   */
  protected beforePlay(): void {
    // A layer whose state times itself has nothing to write.
  }

  protected override maskWeight(frame: AnimFrame): number | null {
    return frame.maskRamp;
  }

  // ===== Host-facing. =====

  /** Ask for the action. Predicted locally and replicated; a no-op while suppressed. */
  public override request(): void {
    if (this.suppressed) {
      return;
    }
    this.host.fireNet(this.triggerKey);
  }

  /**
   * Abort an action already playing. Deliberately NOT gated on suppression — a death that
   * interrupts a swing still wants the swing cut.
   */
  public override interrupt(): void {
    if (this.interruptKey === null) {
      return;
    }
    this.host.fireNet(this.interruptKey);
  }

  public override onNetTrigger(key: string): void {
    if (key === this.triggerKey) {
      // Re-checked here and not only in request(): the trigger and the death flag are
      // independent replication channels with independent ordering, so a killing blow can
      // land the death pose first and only then deliver the action that accompanied it. That
      // late arrival is a stale fact, and applying it would re-park a full-weight pose over
      // the corpse.
      if (this.suppressed) {
        return;
      }
      this.beforePlay();
      this.play(this.nextState());
      return;
    }
    if (key === this.interruptKey) {
      this.rest({transitionTimeSec: this.interruptTransitionTimeSec});
    }
  }
}
