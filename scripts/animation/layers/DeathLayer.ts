/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import {AnimLayer, AnimTag} from './AnimLayer';
import {AnimAction} from './TriggeredLayer';
import type {ReplicatedValue} from '../../Character/WorldsCharacterStateReplication';

/**
 * The death pose.
 *
 * Not a {@link TriggeredLayer}: death is a persistent fact rather than a one-shot, so it rides
 * the replication layer's VALUE channel and is replayed to a late joiner — a client that
 * materialises after the character died should come up already down rather than watch the
 * death play out. It also owns the whole body, so it declares no mask.
 *
 * This is the layer that raises {@link AnimTag.DEAD}. Every other layer that must yield to the
 * death pose lists that tag in `suppressedBy` and needs no knowledge of this class — which is
 * why there is no arbitration code anywhere naming "death".
 */
export class DeathLayer extends AnimLayer {
  readonly layerName: string = 'Death_Layer';
  readonly restState: string = 'empty_state';
  /** Public alongside the other two so the authored name is assertable, like theirs. */
  readonly deathState: string = 'death_state';
  readonly action: string = AnimAction.DEATH;

  private static readonly netKey: string = 'IsDead';

  public override get netKeys(): readonly string[] {
    return [DeathLayer.netKey];
  }

  private dead: boolean = false;

  public override get isActive(): boolean {
    return this.dead;
  }

  /** Enter or leave the death pose. Predicted locally and replicated. */
  public override setActive(isDead: boolean): void {
    this.host.setNet(DeathLayer.netKey, isDead);
  }

  public override onNetValue(key: string, value: ReplicatedValue, replayed: boolean): void {
    if (key !== DeathLayer.netKey) {
      return;
    }
    const isDead = Boolean(value);
    if (this.dead === isDead) {
      return;
    }
    this.dead = isDead;

    // Raise the tag BEFORE the pose blends in. The host propagates suppression synchronously,
    // so any action layer holding a pose — a character killed by the same hit that staggered
    // it — is back at rest by the time the next line runs. Deferring this to the next frame
    // would blend a full-weight flinch over the corpse for that frame.
    this.host.setTag(AnimTag.DEAD, isDead);

    if (!isDead) {
      this.rest();
      return;
    }
    // `replayed` marks the snapshot a late joiner receives on connect: jump straight to the
    // end of the clip with no blend, rather than playing a death that already happened.
    this.play(this.deathState, replayed ? {startPhase: 1.0, transitionTimeSec: 0} : {});
  }
}
