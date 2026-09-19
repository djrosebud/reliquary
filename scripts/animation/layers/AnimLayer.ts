/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import {
  AnimStateRequestInfo,
  type AnimatorComponent,
  type Entity,
  type EventData,
  type EventSubscription,
  type IEvent,
} from 'meta/worlds';
import type {ReplicatedValue} from '../../Character/WorldsCharacterStateReplication';

/**
 * AnimLayer — one animation layer, owning everything about itself: its authored names, its
 * state, its event subscriptions, its network channels and its weight policy.
 *
 * The host ({@link CharacterAnimationController}) knows this base class and nothing else. It
 * never names a layer, a state or an action, so adding a layer is a new file plus a line in
 * `layers/index.ts` — no host change, no gameplay change.
 *
 * THREE THINGS EACH SUBCLASS DECIDES, AND HOW:
 *   - WHAT IT IS CALLED   — `layerName` / `restState` fields. These are the authored names in
 *     the `.animgraph`, and they live with the layer that owns them rather than in a shared
 *     name table, so a layer is self-contained. `attach` fades the layer as its first act,
 *     and the SDK THROWS on a layer name that is not mounted on the AnimatorComponent — so a
 *     misspelled layer fails loudly at start instead of silently playing nothing.
 *   - HOW IT BLENDS       — override {@link maskWeight}. Returning null (the default) means
 *     "this layer has no skeleton mask"; returning a number makes the base class prime the
 *     mask and ramp it every frame. It is deliberately a method, not a `masked: boolean`
 *     field: new blend policies become new overrides rather than new flags, which is what
 *     stops this class turning into a config bag.
 *   - WHEN IT YIELDS      — `suppressedBy` lists tags that force the layer back to rest. The
 *     death pose owning the body is the only rule today, but stagger-cancels-attack and
 *     cast-blocks-reload are the same shape.
 */
export abstract class AnimLayer {
  /** Authored layer name, as mounted in `AnimatorPlatformComponent.additionalLayers`. */
  abstract readonly layerName: string;

  /**
   * The layer's pass-through state — what it holds when it has nothing to contribute.
   *
   * ⚠️ This is spelled THREE different ways across this project's assets (`empty state`,
   * `Empty State`, `empty_state`) and they are not interchangeable. Each layer declaring its
   * own is what makes that survivable: the spelling sits next to the layer it belongs to
   * instead of in a shared table where the wrong row is one line away.
   */
  abstract readonly restState: string;

  /**
   * Replication keys this layer handles. The host builds its dispatch table from these, which
   * is what replaces a hand-written `if (key === ...)` chain — several layers may claim the
   * same key and all of them are notified.
   *
   * A getter rather than a field: a subclass that computes its keys must be able to override
   * it, and a base-class field initializer would install an own property that shadows a
   * subclass getter on the prototype.
   */
  public get netKeys(): readonly string[] {
    return [];
  }

  /**
   * The gameplay intent this layer answers to, or null for a layer nothing asks for directly
   * (the airborne pass follows the jump; nobody calls it).
   *
   * This is the whole of the host's routing knowledge: it maps an intent to a layer and
   * forwards, so it never learns that "melee" is played by a layer called `Attack_Layer`.
   */
  readonly action: string | null = null;

  /** Tags that force this layer back to {@link restState} and make it refuse new requests. */
  protected readonly suppressedBy: readonly string[] = [];

  /** Blend time for an ordinary state change on this layer. */
  protected readonly transitionTimeSec: number = 0.15;

  protected host!: AnimLayerHost;

  /** Last mask weight requested; suppresses redundant per-frame requests. */
  private lastMaskWeight: number | null = null;
  private suppressedNow: boolean = false;

  // ===== Host-facing lifecycle. Not for subclasses to call or override. =====

  /**
   * Mount the layer. Runs on every client, owner and proxy alike — a proxy plays these layers
   * from the replication callbacks, so it needs the same weights.
   */
  public attach(host: AnimLayerHost): void {
    this.host = host;
    // Throws if `layerName` is not mounted on the animator. That throw IS the validation:
    // there is no API to enumerate configured layers, so this is the only point at which a
    // registered-but-unmounted layer can be caught.
    host.animator.requestLayerFade(this.layerName, 1.0);
    // The animator treats an UNWEIGHTED mask as fully applied, so a masked layer must be
    // primed to 0 or a fresh spawn enters the world already masked to the upper body — the
    // opposite of the intended rest posture. Unmasked layers skip this: a mask fade on a
    // layer with no skeletonMask is a silent no-op.
    if (this.maskWeight(restingFrame) !== null) {
      host.animator.requestLayerMaskFade(this.layerName, 0, {fadeTimeSec: 0});
      this.lastMaskWeight = 0;
    }
    this.onAttach();
  }

  /**
   * Owner-side, once the character's two entities are known. A layer that reads the physics
   * simulation resolves its dependencies here; most layers need nothing.
   */
  public onCharacterReady(_characterRootEntity: Entity, _characterSimulatedEntity: Entity): void {
    // Most layers hold no reference to the character.
  }

  /**
   * Per-frame on the OWNER only, inside the character's ordered update — after ground
   * detection and force integration, so a layer reading sampled velocity or ground distance
   * sees this frame's values rather than last frame's. Layers that only react to replicated
   * facts use {@link tick} instead.
   */
  public ownerTick(frame: AnimFrame): void {
    if (this.suppressedNow) {
      return;
    }
    this.onOwnerUpdate(frame);
  }

  /** Per-frame, every client. */
  public tick(frame: AnimFrame): void {
    // The mask ramp runs even while suppressed: it is a client-local visual driven by speed,
    // and freezing it would strand a half-faded mask on a character that later revives.
    this.applyMask(frame);
    if (this.suppressedNow) {
      return;
    }
    this.onUpdate(frame);
  }

  /**
   * Recompute suppression. Called by the host synchronously whenever a tag changes, NOT once
   * per frame — the ordering matters. A killing blow must rest the flinch layer in the same
   * call that enters the death pose, or the flinch blends over the corpse for a frame.
   */
  public refreshSuppression(): void {
    const suppressed = this.suppressedBy.some((tag) => this.host.hasTag(tag));
    if (suppressed === this.suppressedNow) {
      return;
    }
    this.suppressedNow = suppressed;
    if (suppressed) {
      this.onSuppressed();
    } else {
      this.onReleased();
    }
  }

  public onNetValue(_key: string, _value: ReplicatedValue, _replayed: boolean): void {
    // Only a layer that claimed a value key reacts.
  }

  public onNetTrigger(_key: string): void {
    // Only a layer that claimed a trigger key reacts.
  }

  // ===== The three verbs the host can address a layer with, by intent alone. =====
  // A one-shot layer implements `request` / `interrupt`; a layer holding a persistent pose
  // implements `setActive` / `isActive`. The host calls whichever the caller asked for and
  // never needs to know which kind it is holding.

  /** Play the action once. */
  public request(): void {
    // A layer nothing asks for, or one that holds a pose instead, ignores this.
  }

  /** Cut an action short, faster than it would end on its own. */
  public interrupt(): void {
    // Not every action can be aborted.
  }

  /** Enter or leave a persistent pose. */
  public setActive(_active: boolean): void {
    // Only a layer holding a persistent pose reacts.
  }

  public get isActive(): boolean {
    return false;
  }

  // ===== Subclass hooks. =====

  /** Subscribe to the gameplay facts this layer cares about. The host never learns them. */
  protected onAttach(): void {
    // A layer driven purely by replicated keys needs no subscriptions.
  }

  protected onUpdate(_frame: AnimFrame): void {
    // A layer whose graph state machine runs itself needs no per-frame work.
  }

  /** See {@link ownerTick}. */
  protected onOwnerUpdate(_frame: AnimFrame): void {
    // Only a layer reading the physics simulation needs the ordered tick.
  }

  /**
   * Skeleton-mask weight for this frame, or null when the layer has no mask. Overriding this
   * is what makes a layer "masked" — there is deliberately no boolean to set.
   */
  protected maskWeight(_frame: AnimFrame): number | null {
    return null;
  }

  /** Default: drop whatever is playing. Override to hold a pose through suppression. */
  protected onSuppressed(): void {
    this.rest();
  }

  protected onReleased(): void {
    // Coming out of suppression leaves the layer at rest; a revive plays nothing by itself.
  }

  // ===== Primitives for subclasses. =====

  protected get suppressed(): boolean {
    return this.suppressedNow;
  }

  /**
   * Per-entity tuning, set by whichever gameplay component owns the number.
   *
   * A layer is a plain class, so it has no `@property` of its own and cannot carry a value
   * that differs between the player and an NPC. The component that DOES own the number — the
   * weapon, the attack controller — pushes it here from an `ExecuteOn.Everywhere` handler, so
   * every client holds the same value before the first replicated trigger arrives. Untuned
   * keys fall back to the layer's own default, which is what a character with no such
   * component gets.
   */
  public tune(key: string, value: number): void {
    this.tuning.set(key, value);
  }

  protected tuned(key: string, fallback: number): number {
    return this.tuning.get(key) ?? fallback;
  }

  private readonly tuning: Map<string, number> = new Map<string, number>();

  protected play(state: string, options: PlayOptions = {}): void {
    const request = new AnimStateRequestInfo();
    request.stateName = state;
    request.layerName = this.layerName;
    request.startPhase = options.startPhase ?? 0.0;
    request.transitionTimeSec = options.transitionTimeSec ?? this.transitionTimeSec;
    this.host.animator.requestTransitionToState(request);
  }

  protected rest(options: PlayOptions = {}): void {
    this.play(this.restState, options);
  }

  protected setVar(name: string, value: number | boolean): void {
    this.host.animator.setGraphVariable(name, value);
  }

  /** Subscribe for this layer's lifetime. See {@link AnimLayerHost.subscribeEvent}. */
  protected on<T extends EventData>(event: IEvent<T>, callback: (payload: T) => unknown): void {
    this.host.subscribeEvent(event, callback);
  }

  private applyMask(frame: AnimFrame): void {
    const target = this.maskWeight(frame);
    if (target === null || target === this.lastMaskWeight) {
      return;
    }
    // The epsilon gate suppresses redundant per-frame requests at a steady speed, but it must
    // not suppress the last step onto an endpoint: ramping down from 0.005 to 0 is a
    // sub-epsilon move, so gating it would strand the mask at 0.005 forever and the character
    // would never regain a true full-body action at rest. Same in reverse at 1.0.
    const atEndpoint = target <= 0 || target >= 1;
    if (
      !atEndpoint &&
      this.lastMaskWeight !== null &&
      Math.abs(target - this.lastMaskWeight) < maskWeightEpsilon
    ) {
      return;
    }
    this.host.animator.requestLayerMaskFade(this.layerName, target, {
      fadeTimeSec: this.maskFadeTimeSec,
    });
    this.lastMaskWeight = target;
  }

  /** Seconds the animator takes to reach a newly requested mask weight. */
  protected readonly maskFadeTimeSec: number = 0.15;
}

/** What a layer is allowed to ask of the character it is mounted on. */
export interface AnimLayerHost {
  readonly animator: AnimatorComponent;
  readonly entity: Entity;

  /**
   * Subscribe on the layer's behalf. `Component.subscribe` is protected, so a layer cannot
   * reach it directly; routing through the host also means the host can re-establish every
   * layer's subscriptions after a script hot-reload, which manual `subscribe` calls do not
   * survive on their own.
   */
  subscribeEvent<T extends EventData>(
    event: IEvent<T>,
    callback: (payload: T) => unknown,
  ): EventSubscription;

  /**
   * Fire a one-shot across the network (predicted locally, replicated to every client), or
   * apply it locally when the character has no replication component. Comes back to the
   * claiming layer(s) through {@link AnimLayer.onNetTrigger}.
   */
  fireNet(key: string): void;

  /** Same, for a persistent value. Comes back through {@link AnimLayer.onNetValue}. */
  setNet(key: string, value: ReplicatedValue): void;

  /** Raise or clear a cross-layer tag. Propagates to every layer synchronously. */
  setTag(tag: string, raised: boolean): void;
  hasTag(tag: string): boolean;
}

/** Per-frame inputs every layer shares, computed once by the host. */
export interface AnimFrame {
  readonly deltaTime: number;
  /** Horizontal locomotion speed, m/s. */
  readonly speed: number;
  /**
   * `speed` normalised to 0..1 against the character's full-mask speed. Masked layers ramp on
   * this, so an action at rest plays full-body while one taken at a run is confined to the
   * upper body and the legs stay with the locomotion underneath.
   */
  readonly maskRamp: number;
}

export interface PlayOptions {
  readonly startPhase?: number;
  readonly transitionTimeSec?: number;
}

/** Cross-layer tags. A layer raises one; others list it in `suppressedBy`. */
/* eslint-disable @typescript-eslint/naming-convention -- constants-only class */
export class AnimTag {
  /** The character is in the death pose, which owns the whole body. */
  static readonly DEAD = 'anim.dead';
}
/* eslint-enable @typescript-eslint/naming-convention */

/** Mask-weight delta below which a per-frame re-request is skipped. */
const maskWeightEpsilon: number = 0.01;

/**
 * The frame handed to {@link AnimLayer.maskWeight} during `attach`, purely to ask whether the
 * layer has a mask at all. A layer must not read anything but the shape from it.
 */
const restingFrame: AnimFrame = {deltaTime: 0, speed: 0, maskRamp: 0};
