/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Interaction Scripts v1

/**
 * InteractionController -- owner-scoped interaction input for the interactor.
 *
 * INPUT-AGNOSTIC by design. This portable component owns interaction DETECTION
 * (candidate selection + LoS gating via the WSDK, the direct-tap raycast path)
 * and exposes `activate()`, but it does NOT own the on-screen button. It imports
 * ONLY `meta/worlds` + same-skill files; it never imports another skill's files.
 *
 * // INPUT: the on-screen interact button and its press-to-activate wiring are
 * supplied by PROJECT GLUE, not by this file. A small `InteractionControlsBridge`
 * script (see the skill .md) -- written into the world's `scripts/` -- imports
 * the installed `InputActionsManager` + `TouchControlsHud` from
 * `building-on-screen-controls` and this controller, then: (a) subscribes the
 * `Interact` action and calls `activate()` on press; (b) shows/hides the
 * `Interact` HUD button on the candidacy events this component emits
 * (`OnInteractCandidateEnterEvent` / `OnInteractCandidateExitEvent`). The
 * deprecated engine path (`PlayerInputService.subscribePlayerInputAction` +
 * `InputVisualConfigAsset`) is not used: Worlds is mobile-only.
 *
 * This component owns two interaction entry points:
 *
 * 1. On-screen button (via glue). On candidacy enter/exit it emits
 *    `OnInteractCandidateEnterEvent` / `OnInteractCandidateExitEvent` (local
 *    events, `ExecuteOn.Owner`) so the project glue can toggle the `Interact` HUD
 *    button; the glue drives the `Interact` action, and on press calls this
 *    component's public `activate()` ->
 *    `triggerInteract(this.entity, InteractionSource.Button)`.
 * 2. Direct tap on the object (`OnTouchInputStartedEvent`), gated by the
 *    `enableTapToInteract` @property. On a tap it raycasts and, only if the
 *    tap lands on the current candidate's object, calls
 *    `triggerInteract(this.entity, InteractionSource.Touch)`.
 *
 * Attach to the INTERACTOR child entity (the one carrying
 * `InteractorComponent`), NOT a separate handler entity.
 *
 * PRECONDITION: the same interactor child MUST carry `InteractorComponent` --
 * the WSDK interactor marker, which itself owns the PhysX -> WSDK trigger-event
 * bridge that feeds the candidate set. Without it the candidate set stays
 * empty, candidacy events never fire, and both the button and tap paths no-op
 * -- a partial install (this controller but no `InteractorComponent`) looks
 * correct but does nothing. Skill step A3 installs all four interactor
 * components together; do not ship this one without the marker.
 *
 * Why the tap path raycasts (it is NOT optional):
 *   A naive "any tap fires triggerInteract" handler fires the interaction on
 *   every screen tap, even taps far from the object. The raycast hit-test
 *   restricts the tap path to taps that actually land on the candidate's
 *   object. Two independent gates apply to the tap path: this component's
 *   `enableTapToInteract` (does this interactor accept taps at all) and the
 *   per-interactable `InteractionTargetComponent.directTouchEnabled`
 *   (enforced inside the WSDK `triggerInteract`, so a tap on a button-only
 *   object no-ops there).
 */

import {
  CandidateSelectionService,
  CastMode,
  Component,
  component,
  EventService,
  ExecuteOn,
  InteractionSource,
  LocalEvent,
  OnCandidacyEnterEvent,
  OnCandidacyExitEvent,
  OnEntityDestroyEvent,
  OnTouchInputStartedEvent,
  PhysicsService,
  property,
  serializable,
  subscribe,
} from 'meta/worlds';
import type {
  CandidacyChangedPayload,
  Entity,
  Maybe,
  TouchInputEventPayload,
} from 'meta/worlds';
import {SimpleInteractablePromptComponent} from './SimpleInteractablePromptComponent';

const TOUCH_CAST_MAX_DISTANCE = 100;

// Depth cap for the object-root walk (guards against pathological / cyclic
// parent chains). Real object hierarchies are far shallower than this.
const OBJECT_ROOT_WALK_MAX_DEPTH = 32;

// Candidacy signals for external project glue. This portable component is
// input-agnostic: it emits these local events on candidacy enter/exit so a
// project-glue bridge (see the skill .md, `InteractionControlsBridge`) can toggle
// an on-screen HUD button WITHOUT this file importing any other skill's files.
// Both are dispatched from `ExecuteOn.Owner` handlers, so they fire only on the
// local client that owns this interactor.
@serializable()
export class InteractCandidatePayload {}
export const OnInteractCandidateEnterEvent = new LocalEvent(
  'Interact-CandidateEnter',
  InteractCandidatePayload,
);
export const OnInteractCandidateExitEvent = new LocalEvent(
  'Interact-CandidateExit',
  InteractCandidatePayload,
);

/**
 * Walk up to the topmost ancestor of `entity` (its rig root), depth-bounded
 * against pathological / cyclic parent chains. The WSDK's LoS pass applies an
 * equivalent rig-root self-filter internally with a WSDK-internal helper that
 * is NOT on the durable surface, so a template needing this walk inlines its
 * own.
 */
function rigRootOf(entity: Entity): Entity {
  let cursor: Entity = entity;
  let parent: Maybe<Entity> = cursor.parent;
  let depth = 0;
  while (parent != null && depth < OBJECT_ROOT_WALK_MAX_DEPTH) {
    cursor = parent;
    parent = cursor.parent;
    depth += 1;
  }
  return cursor;
}

/**
 * True when `node` is `ancestor` or a descendant of it: a bounded walk up from
 * `node` looking for `ancestor`. `isSameOrDescendant` is WSDK-internal (not on
 * the durable surface), so a template needing a subtree check inlines its own.
 */
function isSameOrDescendant(node: Entity, ancestor: Entity): boolean {
  let cursor: Maybe<Entity> = node;
  let depth = 0;
  while (cursor != null && depth < OBJECT_ROOT_WALK_MAX_DEPTH) {
    if (cursor === ancestor) return true;
    cursor = cursor.parent;
    depth += 1;
  }
  return false;
}

@component({
  description:
    'InteractionController: owner-scoped, input-agnostic interaction. Emits candidacy events for external glue to toggle an on-screen button, owns the direct-tap path, and exposes activate(); both surfaces call triggerInteract.',
})
export class InteractionController extends Component {
  /**
   * When `true`, a direct tap on the current candidate's object also
   * triggers the interaction (in addition to the on-screen button). Set
   * `false` to make this interactor button-only. Per-object tap suppression
   * is a separate control on the interactable marker (`directTouchEnabled`).
   */
  @property() public enableTapToInteract: boolean = true;

  private destroyedFlag: boolean = false;

  /**
   * Candidacy signal for external project glue. On candidacy enter, emit
   * `OnInteractCandidateEnterEvent` so the `InteractionControlsBridge` glue can
   * show the `Interact` HUD button; on exit, emit `OnInteractCandidateExitEvent`
   * so it hides it. `payload.interactor` is the interactor entity that
   * gained/lost a candidate; guard on `=== this.entity` so one player's candidacy
   * does not toggle another's button. This component does NOT touch the HUD or
   * any input bus itself -- that is the glue's job (see the skill .md).
   */
  @subscribe(OnCandidacyEnterEvent, {execution: ExecuteOn.Owner})
  private onCandidacyEnter(payload: CandidacyChangedPayload): void {
    if (payload.interactor !== this.entity) return;
    EventService.sendLocally(OnInteractCandidateEnterEvent, {});
  }

  @subscribe(OnCandidacyExitEvent, {execution: ExecuteOn.Owner})
  private onCandidacyExit(payload: CandidacyChangedPayload): void {
    if (payload.interactor !== this.entity) return;
    EventService.sendLocally(OnInteractCandidateExitEvent, {});
  }

  /**
   * Trigger the interaction on the interactor's current WSDK candidate, as an
   * on-screen button press would. Public entry point for the project glue: the
   * `InteractionControlsBridge` calls this when the `Interact` action fires. No-op
   * when there is no current candidate (the WSDK guards this inside
   * `triggerInteract`).
   */
  activate(): void {
    if (this.destroyedFlag) return;
    const system = CandidateSelectionService.get();
    if (system == null) return;
    system.triggerInteract(this.entity, InteractionSource.Button);
  }

  /**
   * Direct-tap path. Raycasts the tap and fires `triggerInteract(...,
   * InteractionSource.Touch)` only when the tap lands on the current candidate's
   * OWN object. "Its object" is the subtree rooted at the ancestor carrying
   * `SimpleInteractablePromptComponent` (the interactable root): a hit on that
   * root or ANY descendant (visuals, colliders, sub-meshes, the sensor itself)
   * counts, so multi-mesh objects are fully tappable, while a hit on a
   * collidable ANCESTOR the object is merely parented under (e.g. a floor or
   * terrain) does NOT. See {@link isHitOnCandidateObject}. The WSDK
   * additionally enforces the candidate's `directTouchEnabled` flag inside
   * `triggerInteract`, so a tap on a button-only object is a no-op there.
   */
  @subscribe(OnTouchInputStartedEvent, {execution: ExecuteOn.Owner})
  private async onTouchStart(payload: TouchInputEventPayload): Promise<void> {
    if (!this.enableTapToInteract) return;
    const system = CandidateSelectionService.get();
    if (system == null) return;
    const candidate = system.getCurrentCandidate(this.entity);
    if (candidate == null) return;
    // Exclude the player's own rig so a body collider does not occlude the
    // tap ray before it reaches the object. `rigRootOf` walks to the
    // interactor's top-level rig root (a non-nullable `Entity`; the WSDK's
    // LoS pass applies an equivalent rig-root self-filter internally). NOTE: if
    // `excludeEntities` is not subtree-aware and the rig's colliders live on
    // descendants, a body part can still occlude -- widen this list to those
    // collider entities if a real self-occlusion is observed at runtime.
    const rigRoot = rigRootOf(this.entity);
    try {
      const result = await PhysicsService.get().rayCast({
        origin: payload.worldRayOrigin,
        dir: payload.worldRayDirection,
        distance: TOUCH_CAST_MAX_DISTANCE,
        mode: CastMode.ClosestHit,
        // ~0 = all layers. The candidate's own physical/visual collider is the
        // intended hit; an object closer to the camera (including another
        // object's interaction sensor) legitimately occludes the tap. The
        // isSameOrDescendant(candidate, hitActor) gate below means a
        // non-candidate hit can only MISS the tap, never fire the wrong object.
        collisionLayerMask: ~0,
        includeTriggers: false,
        // `rigRootOf` is non-nullable, so the exclude list is always the
        // 2-tuple [interactor, rigRoot], which matches the rayCast param's
        // tuple type directly (no nullable ternary needed).
        excludeEntities: [this.entity, rigRoot],
      });
      // The await above can resolve after this interactor was destroyed
      // (world travel / player despawn). Bail before touching the system or
      // entity so we never act on a dead entity.
      if (this.destroyedFlag) return;
      // Re-resolve the candidate AFTER the await. `triggerInteract(...,
      // InteractionSource.Touch)` acts on the interactor's CURRENT candidate; if candidacy changed
      // during the raycast we would hit-test object A but fire on object B.
      // Require the candidate to still be the one the hit-test below validates.
      if (system.getCurrentCandidate(this.entity) !== candidate) return;
      if (!result.hasHitSomething) return;
      const hits = result.hits ?? [];
      if (hits.length === 0) return;
      const hitActor = hits[0].actorEntity;
      if (hitActor == null) return;
      if (!this.isHitOnCandidateObject(candidate, hitActor)) return;
      system.triggerInteract(this.entity, InteractionSource.Touch);
    } catch (err) {
      console.warn('[InteractionController] tap rayCast rejected -- ignoring', err);
    }
  }

  /**
   * True when the tap's hit landed on the candidate's OWN object - the object
   * root (the nearest ancestor of the sensor carrying
   * `SimpleInteractablePromptComponent`) or any of its descendants (visuals,
   * colliders, sub-meshes, the sensor itself). This scopes the tap to the
   * interactable's subtree, so a hit on a collidable ANCESTOR the object is
   * merely parented under (a floor / terrain / group with its own collider)
   * does NOT match, and a multi-mesh object is tappable on any of its meshes
   * regardless of where the collider sits relative to the sensor.
   *
   * Falls back to the candidate-or-ancestor test when no object root marker is
   * found (an interactable without `SimpleInteractablePromptComponent`), so
   * such objects stay tappable on their sensor / own collider.
   */
  private isHitOnCandidateObject(candidate: Entity, hitActor: Entity): boolean {
    const objectRoot = this.resolveObjectRoot(candidate);
    if (objectRoot == null) {
      return isSameOrDescendant(candidate, hitActor);
    }
    return isSameOrDescendant(hitActor, objectRoot);
  }

  /**
   * Walk up from the candidate sensor to the nearest ancestor (inclusive)
   * carrying `SimpleInteractablePromptComponent` - the interactable's object
   * root. Depth-bounded against pathological / cyclic parent chains. Returns
   * null when no such marker exists on the chain.
   */
  private resolveObjectRoot(candidate: Entity): Maybe<Entity> {
    let cursor: Maybe<Entity> = candidate;
    let depth = 0;
    while (cursor != null && depth < OBJECT_ROOT_WALK_MAX_DEPTH) {
      if (cursor.getComponent(SimpleInteractablePromptComponent) != null) {
        return cursor;
      }
      cursor = cursor.parent;
      depth += 1;
    }
    return null;
  }

  // Marks this interactor destroyed so the async tap raycast bails before
  // touching a dead entity. The interact button is owned by the project glue
  // (`InteractionControlsBridge`), which disconnects its own action subscription
  // and hides the button on the glue entity's destroy; this component holds no
  // input subscription of its own to clean up.
  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Owner})
  private onDestroy(): void {
    this.destroyedFlag = true;
  }
}
