/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 * @format
 */

// Interaction Scripts v2

/**
 * AttachableObject - the BEHAVIOUR a world object runs AFTER the player
 * interacts with it: parent to a body socket on grab, show a drop button while
 * held, detach + drop in place on release (or holster).
 *
 * This skill owns ONLY post-interaction behaviour. Detection, candidate
 * selection, line-of-sight, the grab/activation button, and tap input are owned
 * by the `interacting-with-world-objects` skill + the WSDK interaction runtime
 * (`meta/worlds`). This component does NOT poll for
 * proximity or read raw grab input - it subscribes to the WSDK `OnInteractionEvent`
 * and acts on it. The only input it owns is the DROP button shown while held.
 *
 * Component Attachment: object ROOT (the entity that carries the
 *   `PhysicsBodyComponent`; the mesh may be on the root or on a `Visuals` child
 *   and the object's collider on a `Collider` child - the standard
 *   `creating-gameplay-objects` layout. Its interaction SENSOR child carries the
 *   WSDK `InteractionTargetComponent`, installed by interacting-with-world-objects).
 * Component Networking: Networked (parenting + physics state synced across clients).
 * Component Ownership: transferred to the interacting client on grab.
 *
 * Held-object rule (no custom ranking selector): a held object must leave the
 * candidate pool so the player does not keep "interacting" with the thing in
 * their hand. On grab this DISABLES the interaction SENSOR child that carries
 * the object's `InteractionTargetComponent` (the built-in selector drops any
 * candidate whose marker is not `isEffectivelyEnabled()`, and this SDK exposes
 * the enable setter on `Entity`, not `Component`); on drop it re-enables it. Drop
 * is NOT a second interact - it is a separate on-screen button rendered via the
 * building-on-screen-controls skill, gated on {@link OnHeldStateChangedEvent}
 * and calling `release()` on press. This component fires the event and exposes
 * `release()`; it does NOT render the button.
 */

import {
  component,
  Component,
  EventService,
  ExecuteOn,
  InteractionTargetComponent,
  isMyInteractionTarget,
  LocalEvent,
  MeshComponent,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnInteractionEvent,
  PhysicsBodyComponent,
  PhysicsBodyDriveMode,
  property,
  Quaternion,
  subscribe,
  TransformComponent,
  Vec3,
  type Entity,
  type Maybe,
  type OnInteractionEventPayload,
} from 'meta/worlds';

// Local inline of the WSDK-internal characterRootOf (not on the durable
// meta/worlds surface): bounded walk up the parent chain to the top-level
// rig root. Depth cap guards pathological / cyclic parent chains.
const CHARACTER_ROOT_WALK_MAX_DEPTH = 32;
function characterRootOf(entity: Entity): Entity {
  let cursor: Entity = entity;
  let depth = 0;
  while (cursor.parent != null && depth < CHARACTER_ROOT_WALK_MAX_DEPTH) {
    cursor = cursor.parent;
    depth += 1;
  }
  return cursor;
}

/**
 * Body-socket targets an AttachableObject can attach to. `Default` uses a hand
 * anchor on the player rig (plain grab/drop pickups); set Head/Spine/etc. for
 * worn items. Numeric enums render as a dropdown in the editor. Each value maps
 * to a socket ENTITY NAME on the player rig in `socketEntityName()` below.
 */
export enum AttachSocket {
  Default,
  RightHand,
  LeftHand,
  Head,
  Spine,
  RightShoulder,
  LeftShoulder,
  Hips,
  RightFoot,
  LeftFoot,
}

/**
 * How the while-held release button (and `release()`) lets go of the object.
 * `Drop` (default) releases the object where it is: detach and restore its
 * physics so it falls naturally, with NO added force. `Holster` puts it away
 * instead: detach and hide it (kept intact, inert), to be shown again by a
 * later `attachTo()` - a generic "sheathe / pocket / put away" mechanic that
 * does NOT imply or require an inventory. `Drop` is value 0 so the editor's
 * zero-default for an un-set @property yields drop-in-place. There is NO
 * built-in throw; a game that wants throwing adds it in its own gameplay code.
 */
export enum ReleaseMode {
  Drop,
  Holster,
}

/**
 * Payload for {@link OnHeldStateChangedEvent}: which object changed held-state,
 * whether it is now held, and whether it permits a drop button.
 */
export class HeldStateChangedPayload {
  /** The grabbable object's root entity. */
  object: Maybe<Entity> = null;
  /** True when grabbed, false when dropped or holstered. */
  isHeld: boolean = false;
  /** Mirrors AttachableObject.canDrop - whether a drop button is wanted. */
  canDrop: boolean = true;
}

/**
 * Fired (local, on the owning client) when an object is grabbed (isHeld=true)
 * or released/holstered (isHeld=false). Subscribe to this to show/hide an
 * on-screen DROP button rendered via the building-on-screen-controls skill -
 * this component does NOT render the button itself. On press, call
 * `AttachableObject.heldBy(characterRoot)?.release()`.
 */
export const OnHeldStateChangedEvent = new LocalEvent<HeldStateChangedPayload>(
  'AttachableObject-HeldStateChanged',
  HeldStateChangedPayload,
);

/**
 * Maps an {@link AttachSocket} to the socket ENTITY NAME on the player rig.
 * Returns `null` for `Default` (and any unmapped value), meaning "use a hand
 * anchor".
 */
function socketEntityName(slot: AttachSocket): string | null {
  switch (slot) {
    case AttachSocket.RightHand:
      return 'RightHand';
    case AttachSocket.LeftHand:
      return 'LeftHand';
    case AttachSocket.Head:
      return 'Head';
    case AttachSocket.Spine:
      return 'Spine';
    case AttachSocket.RightShoulder:
      return 'RightShoulder';
    case AttachSocket.LeftShoulder:
      return 'LeftShoulder';
    case AttachSocket.Hips:
      return 'Hips';
    case AttachSocket.RightFoot:
      return 'RightFoot';
    case AttachSocket.LeftFoot:
      return 'LeftFoot';
    default:
      return null;
  }
}

@component({
  description:
    'Post-interaction behaviour for a grabbable/attachable object: on the WSDK OnInteractionEvent it attaches to a player body socket and leaves the candidate pool; a drop button (shown while held) detaches and drops it in place (or holsters). Detection/selection/grab-input is owned by interacting-with-world-objects.',
})
export class AttachableObject extends Component {
  /**
   * Per-client registry of the object currently held against each character
   * root, so player-side visuals (e.g. `AimDirectionIndicator`) can ask "is my
   * player holding something". Local (not networked) - each client tracks only
   * what its own player holds.
   */
  private static readonly heldByCharacter: Map<Entity, AttachableObject> =
    new Map();

  /** The object this character is currently holding, if any. */
  static heldBy(characterRoot: Entity): Maybe<AttachableObject> {
    return AttachableObject.heldByCharacter.get(characterRoot) ?? null;
  }

  /** @deprecated use heldBy – kept for old worlds */
  static heldFor(characterRoot: Entity): Maybe<AttachableObject> {
    return AttachableObject.heldBy(characterRoot);
  }

  /** This object's grip point; aligned to the socket anchor when held. */
  @property()
  anchorPoint: Maybe<Entity> = null;

  /**
   * Which body socket this object attaches to. `Default` = a hand anchor on the
   * player rig (plain grab/drop pickups); set Head/Spine/etc. for worn items.
   */
  @property()
  targetSocket: AttachSocket = AttachSocket.Default;

  /**
   * Whether this object can be dropped once held. Surfaced on
   * {@link OnHeldStateChangedEvent} so the deferred drop button (built via
   * building-on-screen-controls) hides itself for a permanently-held / one-way
   * pickup (`false`). Does not gate `drop()` / `release()` directly.
   */
  @property()
  canDrop: boolean = true;

  /**
   * What the while-held release button does: `Drop` (default - release in place,
   * physics restored, NO added force) or `Holster` (detach and hide, kept for a
   * later `attachTo()`). There is no built-in throw. See {@link ReleaseMode}.
   */
  @property()
  releaseMode: ReleaseMode = ReleaseMode.Drop;

  /** Whether this object is currently held by a player. */
  @property()
  isHeld: boolean = false;

  /** Target local position for the held object, derived from its anchorPoint. */
  private heldLocalPosition: Vec3 = Vec3.zero;

  private originalParent: Maybe<Entity> = null;
  private physicsBody: Maybe<PhysicsBodyComponent> = null;
  private originalCollisionEnabled: boolean = true;

  // While held the body is switched to Kinematic so its physics representation
  // tracks the (parented) TransformComponent each frame. Left dynamic, the
  // solver - not the hand socket - would own the world pose and the object would
  // lag / drift away from the hand during movement.
  private originalDriveMode: PhysicsBodyDriveMode = PhysicsBodyDriveMode.None;

  // attach() awaits requestOwnership() for networked objects, so there is a
  // window where the grab is in flight but `isHeld` is still false and the
  // object is not yet parented. These guard a release landing mid-flight so
  // attach() aborts on resume instead of parenting AFTER the detach.
  private attachInFlight: boolean = false;
  private detachRequestedDuringAttach: boolean = false;

  // The held object's own WSDK marker (on its interaction sensor child) and the
  // character holding it - cached on grab so release can re-enable the marker
  // and clear the held registry. The marker is disabled while held so the
  // built-in candidate selector drops it (no custom selector needed).
  private heldMarker: Maybe<InteractionTargetComponent> = null;
  private heldCharacterRoot: Maybe<Entity> = null;

  private destroyed: boolean = false;

  // OnEntityStartEvent re-fires on ownership handoff, and attach() requests
  // ownership - a second capture would record the hand socket as the original.
  private parentCaptured: boolean = false;

  /**
   * Capture the runtime parent on every client so detach() can always reparent
   * back. Must NOT be gated on isOwned(): a networked object is server-owned at
   * startup, so the grabbing client would otherwise never record its parent.
   */
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (this.parentCaptured) {
      return;
    }
    this.originalParent = this.entity.parent ?? null;
    this.parentCaptured = true;
  }

  /**
   * WSDK interaction fired for this object. Because a held object is removed
   * from candidacy (its marker is disabled on grab), this only ever fires for a
   * NOT-held object - i.e. it always means "grab". Drop is the separate button
   * (see `drop()`), never a re-interact.
   *
   * `payload.interactable` is this object's interaction SENSOR child (matched by
   * ancestry via `isMyInteractionTarget`); its
   * `InteractionTargetComponent` is exactly the marker we disable on grab.
   */
  @subscribe(OnInteractionEvent, {execution: ExecuteOn.Everywhere})
  private onInteract(payload: OnInteractionEventPayload): void {
    if (!isMyInteractionTarget(payload.interactable, this.entity)) {
      return;
    }
    if (this.isHeld || this.attachInFlight) {
      return;
    }
    const interactor = payload.interactor;
    if (!interactor) {
      return;
    }
    const characterRoot = characterRootOf(interactor);
    const marker =
      payload.interactable?.getComponent(InteractionTargetComponent) ?? null;
    void this.attach(characterRoot, marker);
  }

  /**
   * Drop the held object in place: detach, restore physics so it falls
   * naturally (NO added force), and return it to the candidate pool. Called by
   * the drop button while held (the default release), and exposed for gameplay
   * code that needs to force a release. No-op when nothing is held.
   */
  drop(): void {
    if (this.attachInFlight) {
      // Release pressed before attach() finished: record it so attach() aborts.
      this.detachRequestedDuringAttach = true;
      return;
    }
    if (!this.isHeld) {
      return;
    }
    this.detach(ReleaseMode.Drop);
  }

  /**
   * Let go of the held object per `releaseMode`: drop it in place (`Drop`,
   * default) or put it away (`Holster`). This is what the while-held release
   * button calls. Exposed so gameplay code can trigger a release the same way
   * the button does.
   */
  release(): void {
    if (this.releaseMode === ReleaseMode.Holster) {
      this.holster();
    } else {
      this.drop();
    }
  }

  /**
   * Put the held object away: detach from the hand and hide it (kept intact and
   * inert), so it can be shown again later via `attachTo()`. Generic "stow /
   * sheathe / pocket" mechanic - it does NOT destroy the object and does NOT
   * touch any inventory. No-op when nothing is held. Use `drop()` to release it
   * in place instead.
   */
  holster(): void {
    if (this.attachInFlight) {
      this.detachRequestedDuringAttach = true;
      return;
    }
    if (!this.isHeld) {
      return;
    }
    this.detach(ReleaseMode.Holster);
  }

  /**
   * Programmatically attach this object to `characterRoot` WITHOUT a WSDK
   * interaction (no `OnInteractionEvent` needed). Generic mechanic for scripted
   * equips, cutscenes, or an external controller (e.g. an optional
   * equipment/inventory bridge). Pass `socket` to override `targetSocket` for
   * this attach. Re-shows the object if it was previously holstered. Knows
   * nothing about inventory or why it is being attached. No-op if already held.
   */
  async attachTo(
    characterRoot: Maybe<Entity>,
    socket?: AttachSocket,
  ): Promise<void> {
    if (this.isHeld || this.attachInFlight) {
      return;
    }
    // A one-off socket override must NOT persist onto the networked @property --
    // it would leak into the next natural grab and replicate to other clients.
    const savedSocket = this.targetSocket;
    if (socket !== undefined) {
      this.targetSocket = socket;
    }
    try {
      // Resolve the interaction marker from the sensor child so a programmatic
      // attach also leaves the candidate pool while held (parity with a natural
      // grab); without it the player can still "interact" with the held object.
      const sensor = this.entity.getChildrenWithComponent(
        InteractionTargetComponent,
        true,
      )[0];
      const marker = sensor
        ? sensor.getComponent(InteractionTargetComponent)
        : null;
      await this.attach(characterRoot, marker);
    } finally {
      if (socket !== undefined) {
        this.targetSocket = savedSocket;
      }
    }
  }

  /**
   * Toggle the object's mesh visibility. Used by holster (hide) and attach
   * (show). The mesh may live on the root OR on a child (e.g. the `Visuals`
   * child that `creating-gameplay-objects` emits), so toggle every
   * `MeshComponent` in the object's subtree.
   */
  private setVisible(visible: boolean): void {
    const rootMesh = this.entity.getComponent(MeshComponent);
    if (rootMesh) {
      rootMesh.isVisibleSelf = visible;
    }
    for (const child of this.entity.getChildrenWithComponent(
      MeshComponent,
      true,
    )) {
      const mesh = child.getComponent(MeshComponent);
      if (mesh) {
        mesh.isVisibleSelf = visible;
      }
    }
  }

  /**
   * Parent this object to the socket resolved from `targetSocket` on the
   * character, align its grip, disable physics while held, remove it from the
   * candidate pool by disabling its own interaction marker, and show the drop
   * button.
   */
  private async attach(
    characterRoot: Maybe<Entity>,
    marker: Maybe<InteractionTargetComponent>,
  ): Promise<void> {
    if (!characterRoot) {
      return;
    }

    const anchor = this.resolveAttachAnchor(characterRoot, this.targetSocket);
    if (!anchor) {
      return;
    }

    const transform = this.entity.getComponent(TransformComponent);
    if (!transform) {
      return;
    }

    this.attachInFlight = true;
    try {
      // Take ownership for networked objects so physics/parent edits replicate.
      if (this.entity.networked) {
        await this.entity.requestOwnership();
      }

      // A release pressed during the ownership await, or destruction mid-attach
      // (world unload / consumed item / despawn), asks us to abort before we
      // mutate transform/parent/physics on a possibly-dead entity.
      if (this.detachRequestedDuringAttach || this.destroyed) {
        return;
      }

      this.entity.setParent(anchor);

      // Align the object's grip (anchorPoint) with the socket anchor: negate the
      // grip offset so the grip sits on the anchor, and invert its rotation.
      if (this.anchorPoint) {
        const grip = this.anchorPoint.getComponent(TransformComponent);
        if (grip) {
          this.heldLocalPosition = grip.localPosition
            .componentMul(transform.localScale)
            .mul(-1);
          transform.localRotation = grip.localRotation.inverse();
        } else {
          this.heldLocalPosition = Vec3.zero;
          transform.localRotation = Quaternion.identity;
        }
      } else {
        this.heldLocalPosition = Vec3.zero;
        transform.localRotation = Quaternion.identity;
      }

      // Switch to kinematic + disable gravity/collision while held.
      this.handleInteraction();

      // Ensure visible, in case this object was previously holstered.
      this.setVisible(true);

      // Leave the candidate pool: disable our own interaction marker so the
      // built-in selector stops ranking us (isEffectivelyEnabled() -> false). No
      // custom ranking selector required. Re-enabled in detach().
      // WHY the marker's ENTITY rather than the component: this SDK's
      // `Component` exposes `isEffectivelyEnabled()` but no enable SETTER —
      // `enabledSelf` is on `Entity`. The marker lives alone on the interaction
      // sensor child (marker + trigger body + collider), so disabling that
      // child is equivalent and also stops the trigger overlap that feeds
      // candidacy.
      this.heldMarker = marker;
      if (marker) {
        marker.entity.enabledSelf = false;
      }
      // Only the owning client publishes into the registry, matching the
      // owner-gated isHeld / fireHeldStateChanged below: heldByCharacter tracks
      // only what THIS client's local player holds (see class header). Setting it
      // on non-owning clients would leave isHeld=false with a populated map,
      // which can double-grab on re-interact.
      if (this.entity.isOwned()) {
        this.heldCharacterRoot = characterRoot;
        AttachableObject.heldByCharacter.set(characterRoot, this);
      }

      transform.localPosition = this.heldLocalPosition;

      // Signal held-state so a deferred on-screen drop button (built via
      // building-on-screen-controls) can show itself. We do NOT render it here.
      this.fireHeldStateChanged(true);
    } finally {
      this.attachInFlight = false;
      this.detachRequestedDuringAttach = false;
    }
  }

  /**
   * Unparent back to `originalParent`, hide the drop button, and apply the
   * release `mode`: `Drop` (restore physics, release in place, no added force)
   * or `Holster` (hide + stay inert for a later `attachTo()`).
   */
  private detach(mode: ReleaseMode = ReleaseMode.Drop): void {
    const transform = this.entity.getComponent(TransformComponent);
    if (!transform) {
      return;
    }

    // Preserve world pose across the reparent.
    const worldPos = transform.worldPosition;
    const worldRot = transform.worldRotation;

    // Unconditional: a scene-root object has a null originalParent, and
    // setParent(null) is what returns it to the root.
    this.entity.setParent(this.originalParent);
    transform.worldPosition = worldPos;
    transform.worldRotation = worldRot;

    // Signal released held-state so the deferred drop button hides itself.
    this.fireHeldStateChanged(false);

    if (this.heldCharacterRoot) {
      AttachableObject.heldByCharacter.delete(this.heldCharacterRoot);
      this.heldCharacterRoot = null;
    }

    if (mode === ReleaseMode.Holster) {
      // Put away without dropping: hide and stay inert (still kinematic, gravity
      // and collision off from the held state), keeping the entity intact for a
      // later attachTo(). Leave the interaction marker disabled - a stowed object
      // is not a candidate. Any inventory/equipment record is the caller's job.
      this.isHeld = false;
      this.setVisible(false);
    } else {
      // Drop: return to the candidate pool and restore the dynamic body
      // (gravity + collision) with NO applied force, so the object releases
      // where it is and falls naturally.
      if (this.heldMarker) {
        this.heldMarker.entity.enabledSelf = true;
        this.heldMarker = null;
      }
      this.handleRelease();
    }

    this.heldLocalPosition = Vec3.zero;
  }

  /**
   * Fire {@link OnHeldStateChangedEvent} on the owning client so a deferred
   * on-screen drop button (rendered via the building-on-screen-controls skill)
   * can show (on grab) or hide (on release/holster). This component never
   * renders the button itself.
   */
  private fireHeldStateChanged(isHeld: boolean): void {
    if (!this.entity.isOwned()) {
      return;
    }
    const payload = new HeldStateChangedPayload();
    payload.object = this.entity;
    payload.isHeld = isHeld;
    payload.canDrop = this.canDrop;
    EventService.sendLocally(OnHeldStateChangedEvent, payload);
  }

  /**
   * Resolve the entity to parent to: for a named socket, the socket's
   * `AnchorPoint` child (falling back to the socket entity itself); for
   * `Default`/unmapped or a missing socket, a hand `AnchorPoint` on the player.
   */
  private resolveAttachAnchor(
    characterRoot: Entity,
    slot: AttachSocket,
  ): Maybe<Entity> {
    const name = socketEntityName(slot);
    if (name) {
      const anchor = this.findSocketAnchor(characterRoot, name);
      if (anchor) {
        return anchor;
      }
      console.log(
        `[AttachableObject] Socket '${name}' not found on character; using hand anchor.`,
      );
    }
    return this.resolveHandAnchor(characterRoot);
  }

  /** Default attach point: the RightHand (then LeftHand) anchor on the player. */
  private resolveHandAnchor(characterRoot: Entity): Maybe<Entity> {
    return (
      this.findSocketAnchor(characterRoot, 'RightHand') ??
      this.findSocketAnchor(characterRoot, 'LeftHand') ??
      characterRoot
    );
  }

  /**
   * Find a socket entity by name under `characterRoot` and return its
   * `AnchorPoint` child, falling back to the socket entity itself. Tries the
   * bare name and the `_Socket`-suffixed form (the FBX animation-socket
   * convention). Returns null if the socket does not exist.
   */
  private findSocketAnchor(characterRoot: Entity, name: string): Maybe<Entity> {
    let sockets = characterRoot.findChildrenWithName(name, true);
    if (sockets.length === 0) {
      sockets = characterRoot.findChildrenWithName(`${name}_Socket`, true);
    }
    if (sockets.length === 0) {
      return null;
    }
    const anchors = sockets[0].findChildrenWithName('AnchorPoint', false);
    return anchors.length > 0 ? anchors[0] : sockets[0];
  }

  /**
   * Switch the body to Kinematic (so it follows the hand socket via its parented
   * transform) and disable gravity/collision while held.
   */
  private handleInteraction(): void {
    if (!this.entity.isOwned()) {
      return;
    }

    this.isHeld = true;

    if (!this.physicsBody) {
      this.physicsBody = this.entity.getComponent(PhysicsBodyComponent);
    }

    if (this.physicsBody) {
      this.originalDriveMode = this.physicsBody.driveMode;
      this.physicsBody.driveMode = PhysicsBodyDriveMode.Kinematic;

      this.physicsBody.isAffectedByGravity = false;

      this.originalCollisionEnabled = this.physicsBody.collisionEnabled;
      this.physicsBody.collisionEnabled = false;

      // Clear residual velocity so a body with leftover velocity from a prior
      // drop/fall does not drift away from the attach point.
      this.physicsBody.linearVelocity = Vec3.zero;
      this.physicsBody.angularVelocity = Vec3.zero;
    }
  }

  /**
   * Restore the original drive mode, gravity, and collision on release.
   */
  private handleRelease(): void {
    if (!this.entity.isOwned()) {
      return;
    }

    this.isHeld = false;

    if (!this.physicsBody) {
      this.physicsBody = this.entity.getComponent(PhysicsBodyComponent);
    }

    if (this.physicsBody) {
      // Restore the dynamic drive mode so the released object falls under
      // gravity (a Kinematic body would stay frozen in place).
      this.physicsBody.driveMode = this.originalDriveMode;
      this.physicsBody.isAffectedByGravity = true;
      this.physicsBody.collisionEnabled = this.originalCollisionEnabled;
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  private onDestroy(): void {
    this.destroyed = true;
    // If destroyed while held (e.g. consumed on use, like a deposited log),
    // clean the static registry so heldBy() cannot return this dead component,
    // and tell the deferred drop button to hide. No-op when it was never held.
    if (this.heldCharacterRoot) {
      AttachableObject.heldByCharacter.delete(this.heldCharacterRoot);
      this.heldCharacterRoot = null;
      this.fireHeldStateChanged(false);
    }
  }
}
