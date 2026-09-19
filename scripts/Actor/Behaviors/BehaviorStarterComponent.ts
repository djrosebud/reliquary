/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v1

import {
  component,
  Component,
  OnEntityStartEvent,
  property,
  subscribe,
  type Entity,
  ExecuteOn,
} from 'meta/worlds';
import {
  ActorSdkLogicComponent,
  ActorMovementControllerTypeId,
  ActorBehavior,
  PickupItemSlot,
} from 'meta/worlds';

@component()
export class BehaviorStarterComponent extends Component {
  @property()
  controlledActor: Entity | null = null;

  @property()
  autoStart: boolean = true;

  @property()
  removeDuplicates: boolean = true;

  // CRITICAL: Only initialize behaviors on owner (server) since that's where NPC logic runs
  // Client views don't need to initialize behaviors - they receive replicated transforms
  @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
  onStart() {
    // Resolve the actor before consulting autoStart. autoStart means "do not
    // start yourself", not "do not prepare" — a starter left off can still be
    // driven later by another component, and startBehavior() early-returns on a
    // null controlledActor, so gating the resolve on autoStart leaves such a
    // starter permanently unable to run at all.
    if (!this.controlledActor && this.entity.getComponent(ActorSdkLogicComponent)) {
      this.controlledActor = this.entity;
    }

    if (!this.autoStart) {
      return;
    }

    if (this.controlledActor) {
      this.warnIfNoMovementController();
      this.startBehavior();
    }
  }

  /**
   * Override in starters whose behavior drives locomotion, returning the
   * subclass name. A non-null value both opts into the missing-movement-
   * controller check and labels its diagnostic, so opt-in and label cannot
   * drift apart. Null (the default) is for starters that never move the actor
   * — look and speak. Note that item starters DO move: `UseItemBehavior` and
   * `SearchAndPickupBehavior` both drive `GotoBehavior` internally.
   *
   * The name is supplied explicitly rather than read from `constructor.name`,
   * which is not stable under minification.
   */
  protected locomotionStarterName(): string | null {
    return null;
  }

  /**
   * A locomotion actor with no registered ActorMovementController holds its
   * target and never closes; the request is dropped silently, so the only
   * downstream symptom misattributes to navmesh/collider radii.
   * CharacterAnimationController does NOT register one — it only drives animation.
   *
   * Runs before startBehavior(), which early-returns on every subclass when a
   * required property is unset, so the message states only what is true either
   * way: the actor cannot be moved. Diagnostic only — startBehavior() still
   * runs. warn, not error: error severity reaches APP ERROR / hzw_hsr_errors
   * and fails smoketest.
   */
  private warnIfNoMovementController(): void {
    const starterName = this.locomotionStarterName();
    if (starterName === null || !this.controlledActor) {
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      return;
    }
    if (actorLogic.getControllers(ActorMovementControllerTypeId).length > 0) {
      return;
    }
    console.warn(
      `[${starterName}] No ActorMovementController is registered on this ` +
      'actor — a locomotion behavior on it cannot move it. Add ' +
      "ActorTransformMoveComponent to the actor's root entity " +
      '(CharacterAnimationController only drives animation).',
    );
  }

  /**
   * Resolves a scene-authored hand slot, falling back to RightHand.
   *
   * The pickup starters type their slot as `number` rather than
   * `PickupItemSlot` because an enum `@property` does not survive scene
   * serialisation, so a template instance zero-inits it to `None`. That value
   * IS rejected by `ActorPickupItemComponent.pickupItem`, but only once the
   * actor has already walked to the item, so the failure reads as a pickup that
   * quietly does nothing. Checking at configuration time names the real cause.
   *
   * warn, not error: error severity reaches APP ERROR / hzw_hsr_errors and
   * fails smoketest, and this path recovers.
   *
   * Recovering rather than rejecting is deliberate, and it is a behaviour
   * change: an unset slot used to mean no pickup at all. An actor that carries
   * the item in the wrong hand is visibly wrong and easy to trace from the
   * warning; one that walks to the item and then does nothing reads as a broken
   * behaviour tree and cost a debugging cycle to attribute. The two bad inputs
   * are reported differently so a typo is not mistaken for the zero-init trap.
   */
  protected resolveHandSlot(slot: number, starterName: string): PickupItemSlot {
    if (slot === PickupItemSlot.RightHand || slot === PickupItemSlot.LeftHand) {
      return slot as PickupItemSlot;
    }
    const cause =
      slot === PickupItemSlot.None
        ? 'likely unset on the instance — a template instance zero-inits this property to None'
        : 'not a PickupItemSlot value, so this looks like a typo';
    console.warn(
      `[${starterName}] hand slot is ${slot}, ${cause}. Expected ` +
        `${PickupItemSlot.RightHand} (RightHand) or ${PickupItemSlot.LeftHand} (LeftHand). ` +
        'Falling back to RightHand so the actor still picks up; set the slot explicitly to ' +
        'choose the hand.',
    );
    return PickupItemSlot.RightHand;
  }

  /**
   * Returning the behavior lets a caller observe when it finishes.
   * `ActorSdkLogicComponent` exposes `addBehavior` / `removeBehavior` but no way
   * to read the behavior list, so the returned instance is the only handle on
   * completion — which is what a component driving a repeating starter needs.
   *
   * The rule is about capability, not guarantee: a starter returns its behavior
   * unless that behavior can never finish. Of the behaviors these starters
   * create, `AttentionBehavior` is the only one that never assigns `isFinished`,
   * so `StartAttentionBehaviorComponent` alone returns nothing — a handle to it
   * could only invite a caller to wait forever. Every other starter returns.
   *
   * None of the behaviors that do finish are unconditional about it.
   * `SimpleFetchBehavior` finishes after its drop, `LeadBehavior` on arrival,
   * `UseItemBehavior` on use completion or when it gives up (a destroyed or
   * transform-less target, or no item held in the use slot), and
   * `SearchAndPickupBehavior` after its pickup — but only while `persistent` is
   * off, because a persistent search is meant to keep looking. So a returned
   * handle means "this can complete", never "this will": a caller that loops on
   * completion has to tolerate a behavior that never reports one.
   *
   * The union return type is what makes that split expressible: a
   * `startBehavior(): void` override stays valid.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  startBehavior(): ActorBehavior | void { }
}
