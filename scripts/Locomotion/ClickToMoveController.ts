/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Locomotion Scripts v3

/**
 * ClickToMoveController
 *
 * Component Attachment: a scene service entity (`PlayerInputServices` in space.hstf)
 * Component Networking: Everywhere — each client binds to its own local player
 *   and ignores the server context, so the callbacks only ever reach a
 *   character that client owns.
 *
 * Search aliases: point-and-move, tap-to-move, PointAndClick, SetDestination,
 *                 walk to, navigate to, click to move, click-to-move
 *
 * Captures screen taps via FocusedInteractionService, raycasts to find the
 * ground hit point, snaps it to the NavMesh, computes a NavMesh path, and
 * each frame publishes a camera-relative Vec2 to the 'Move' action on
 * InputActionsManager. ProjectControlsBridge forwards 'Move' to
 * CharacterStateMachine → MovementAbility, so click-to-move shares the
 * same locomotion pipeline as the joystick.
 *
 * Drag-to-rotate publishes to the 'Look' Delta action; ProjectControlsBridge
 * forwards those deltas to CameraManager.addLookDelta(), centralising both
 * TouchCameraLook and click-to-move drag through one camera path.
 *
 * The 'ClickToMove' Button action is held true while a path is active, and
 * PlayerActionController reads it to drop idle Vec2.zero values from the
 * engine axis rather than let them clobber click-to-move steering.
 *
 * Animation and facing work automatically: MovementAbility receives real
 * input through the normal pipeline, AutoFaceRotationAbility reads the
 * resulting movement direction, and CharacterAnimationController drives Speed.
 *
 * FocusedInteractionService (FIS) is always enabled when click-to-move is
 * active — FIS is REQUIRED for tap detection. Without it, the
 * OnFocusedInteractionInputStartedEvent never fires and taps are never detected.
 *
 * When suppressStandardLocomotion is true, FIS also suppresses the standard
 * joystick. When false, the joystick visibility is controlled externally
 * (e.g. by LocomotionSettingsComponent) and the controller only writes
 * movement input while actively following a path, so other input sources
 * (e.g. PlayerActionController) can drive movement at all other times.
 *
 * Hosted on the scene's PlayerInputServices entity alongside PlayerActionController,
 * and bound to the local player's character on spawn.
 *
 * Prerequisite: MovementAbility and CharacterUpdateManager must be on the
 * same entity (PlayerCharacter root). Drag-to-rotate needs a CameraManager
 * in the scene; without one, drags are still classified as drags (no
 * pathfinding) but move no camera.
 */

import {
  Component,
  component,
  property,
  subscribe,
  OnEntityDestroyEvent,
  OnWorldUpdateEvent,
  ExecuteOn,
  FocusedInteractionService,
  OnPlayerCreateEvent,
  OnPlayerCreateEventPayload,
  OnPlayerDestroyEvent,
  OnPlayerDestroyEventPayload,
  NetworkingService,
  OnFocusedInteractionInputStartedEvent,
  OnFocusedInteractionInputMovedEvent,
  OnFocusedInteractionInputEndedEvent,
  PhysicsService,
  CastMode,
  CameraService,
  CollisionLayerMask,
  NavMeshComponent,
  EntityService,
  TransformComponent,
  WorldService,
  NetworkMode,
  TemplateAsset,
  Vec2,
  Vec3,
  type Maybe,
} from 'meta/worlds';
import type {
  OnFocusedInteractionInputEventPayload,
  OnWorldUpdateEventPayload,
  Entity,
  SceneCastOutput,
  SceneHitData,
} from 'meta/worlds';
import {CharacterStateMachine} from '../Character/State/CharacterStateMachine';
import {InputActionsManager} from '../Input/InputActionsManager';

/**
 * Hits gathered per tap raycast. Enough headroom to see past the player
 * hierarchy (the native cast excludes only 4 entities) to the ground behind it.
 */
const kMaxRaycastHits = 8;

@component({
  description:
    'Point-and-click / tap-to-move controller: tap ground to pathfind via NavMesh, ' +
    'drives character via direct addMoveDelta on the KCC. Aliases: point-and-move, ' +
    'tap-to-move, PointAndClick, SetDestination, walk to, navigate to.',
})
export class ClickToMoveController extends Component {
  // ═══════════════════════════════════════════════════════════════════════════
  // @property declarations — exposed for per-instance tuning
  // ═══════════════════════════════════════════════════════════════════════════

  /** XZ distance to consider an intermediate waypoint reached. */
  @property()
  waypointReachDistance: number = 0.4;

  /** XZ distance to consider the final destination reached. */
  @property()
  destinationReachDistance: number = 0.3;

  /** Raycast max distance for tap-to-ground. */
  @property()
  rayMaxDistance: number = 200;

  /** Maximum waypoints returned by findPath. NavMesh guide recommends 256. */
  @property()
  maxPathSize: number = 256;

  /**
   * NavMesh search radius for findPath (start/end snap tolerance).
   * Keep small (e.g. 1.0) to avoid snapping far off-navmesh.
   */
  @property()
  findPathSearchDistance: number = 5.0;

  /**
   * NavMesh search radius for findClosestPoint (tap-point snap).
   * Can be larger (e.g. 10.0) so taps near navmesh edges still register.
   */
  @property()
  findClosestPointSearchDistance: number = 10.0;

  /** Seconds between automatic repath requests while following a path. */
  @property()
  repathIntervalSec: number = 0.5;

  /**
   * Distance over which movement input is ramped down on approach to the
   * final waypoint, preventing overshoot/oscillation.
   */
  @property()
  arrivalRampDistance: number = 2.0;

  /**
   * When true, FocusedInteractionService also suppresses the standard
   * joystick. When false, the joystick visibility is controlled externally
   * (e.g. by LocomotionSettingsComponent). FIS is always enabled when
   * click-to-move is active regardless of this flag — it is required for
   * tap detection.
   */
  @property()
  suppressStandardLocomotion: boolean = true;

  /** Gate ALL diagnostic console.log calls behind this flag. */
  @property()
  debugLogging: boolean = false;

  /**
   * Screen-space distance (in screen units) the finger must move before the
   * gesture is classified as a drag (camera rotation) instead of a tap
   * (pathfinding). Higher = more forgiving for taps on small screens.
   */
  @property()
  dragThreshold: number = 15;

  /**
   * Camera rotation sensitivity during drag-to-rotate.
   * Degrees of yaw/pitch per screen unit of finger movement.
   */
  @property()
  cameraDragSensitivity: number = 0.15;

  /**
   * Optional template spawned at the destination as a persistent marker.
   * Appears on tap, destroyed on arrival or new tap.
   * Leave null for no marker (the generic FocusedInteraction tap VFX still
   * plays if suppressStandardLocomotion is true).
   */
  @property()
  destinationMarkerTemplate: Maybe<TemplateAsset> = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // Cached references
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The local player's character. Null before it spawns and again once it is
   * gone, which makes every handler below a no-op in between — and on a client
   * whose local player is not this one.
   */
  private character: Maybe<Entity> = null;
  private transformComponent: Maybe<TransformComponent> = null;
  private stateMachine: Maybe<CharacterStateMachine> = null;
  private navMeshComponent: Maybe<NavMeshComponent> = null;

  /**
   * Cached camera XZ-forward for the world→camera-relative inverse projection.
   * When the camera pitches near -90° the XZ projection is degenerate; this
   * cache keeps the last valid direction so steering doesn't jitter.
   */
  private lastValidCamFwdX: number = 0;
  private lastValidCamFwdZ: number = -1;

  /**
   * The player hierarchy (root → SimulatedBody → Collider, plus Visuals) must
   * be fully excluded so the tap raycast doesn't hit the player's own capsule
   * or mesh and pathfind to the character's own body. PhysicsService caps
   * `excludeEntities` at 4, so this best-effort tuple (first 4) is passed to the
   * native cast for the common case, while `excludeSet` below holds the FULL set
   * and is the authoritative filter applied to every returned hit — that way a
   * 5th+ hierarchy entity (or one that lands past the first 4 in traversal
   * order) can never be accepted as the ground point. Populated in initReferences.
   */
  private excludeList:
    | [Entity]
    | [Entity, Entity]
    | [Entity, Entity, Entity]
    | [Entity, Entity, Entity, Entity]
    | undefined = undefined;

  /** Full player-hierarchy exclusion set; authoritative post-cast hit filter. */
  private excludeSet: Set<Entity> = new Set<Entity>();

  // ═══════════════════════════════════════════════════════════════════════════
  // Path state
  // ═══════════════════════════════════════════════════════════════════════════

  private waypoints: Vec3[] = [];
  private currentWaypointIndex: number = 0;
  private isFollowingPath: boolean = false;
  /** The true final destination (survives path truncation). */
  private currentDestination: Vec3 = Vec3.zero;
  /** True when findPath returned maxPathSize points — last waypoint is NOT the real destination. */
  private pathWasTruncated: boolean = false;

  // Async guards (last-tap-wins)
  private pathRequestInFlight: boolean = false;
  private pendingDestination: Maybe<Vec3> = null;
  /** True when pendingDestination was set by a user tap (not a repath). */
  private pendingIsUserTap: boolean = false;

  // Repathing timer
  private timeSinceLastRepath: number = 0;

  // Frame counter for periodic diagnostics
  private frameCount: number = 0;

  // Destination marker entity
  private destinationMarkerEntity: Maybe<Entity> = null;
  /** Generation counter to prevent marker spawn races on rapid taps. */
  private markerGeneration: number = 0;

  // Track whether we set up focused interaction
  private focusedInteractionEnabled: boolean = false;

  // Runtime toggle: when false, tap events are ignored (click-to-move disabled)
  private clickToMoveActive: boolean = true;

  // ═══════════════════════════════════════════════════════════════════════════
  // Tap-vs-drag gesture state (per-touch tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Screen position where the current touch started. */
  private touchStartPos: Vec2 = Vec2.zero;
  /** Last screen position during a drag (for computing deltas). */
  private touchLastPos: Vec2 = Vec2.zero;
  /** True once the finger has moved beyond dragThreshold — classified as drag. */
  private isDragging: boolean = false;
  /** True when a touch is active (between Started and Ended). */
  private isTouching: boolean = false;
  /** Saved payload from InputStarted so we can raycast on tap-end. */
  private savedTapPayload: Maybe<OnFocusedInteractionInputEventPayload> = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bind to the local player's character. Gated on `isLocal` so a remote player
   * spawning on this client does not capture the controller, and on the server
   * context, which drives no input.
   *
   * This replaces the OnOwnershipTransferEvent handler the character-hosted
   * version carried. That existed because ownership of the body could arrive
   * after OnEntityStartEvent had already fired; hosted here the bind is driven
   * by the player's own lifecycle instead, so there is no such race. The case it
   * no longer covers is ownership of an existing character transferring without
   * a destroy/create cycle.
   */
  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  onPlayerCreate(payload: OnPlayerCreateEventPayload): void {
    if (NetworkingService.get().isServerContext() || !payload.isLocal) {
      return;
    }
    const playerEntity: Maybe<Entity> = payload.entity;
    if (!playerEntity) {
      console.error(
        '[ClickToMoveController] OnPlayerCreateEvent carried no local entity; click-to-move disabled.',
      );
      return;
    }
    this.character = playerEntity;
    this.initReferences();
  }

  /**
   * Drop the character on despawn and stop listening for taps. Without this the
   * per-frame path follower would keep publishing 'Move' input until the next
   * spawn replaced the character.
   */
  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    if (!payload.isLocal) {
      return;
    }
    this.clearPathAndSignal();
    this.tearDownFocusedInteraction();
    this.destroyMarker();
    this.character = null;
    this.transformComponent = null;
    this.stateMachine = null;
    this.excludeList = undefined;
    this.excludeSet = new Set<Entity>();
  }

  /** Resolve everything this controller drives off the bound character. */
  private initReferences(): void {
    const character = this.character;
    if (!character) {
      return;
    }
    this.transformComponent = character.getComponent(TransformComponent);
    this.stateMachine = character.getComponent(CharacterStateMachine);

    // Cache self + all descendants for raycast exclusion. The native cast is
    // capped at 4 exclusions, so `excludeSet` retains the full set for the
    // authoritative post-cast filter (see raycast in onTouchEnd).
    const allDescendants = this.collectDescendants(character);
    const exclusions: Entity[] = [character, ...allDescendants];
    this.excludeSet = new Set(exclusions);
    if (exclusions.length >= 4) {
      this.excludeList = [exclusions[0], exclusions[1], exclusions[2], exclusions[3]];
    } else if (exclusions.length === 3) {
      this.excludeList = [exclusions[0], exclusions[1], exclusions[2]];
    } else if (exclusions.length === 2) {
      this.excludeList = [exclusions[0], exclusions[1]];
    } else {
      this.excludeList = [exclusions[0]];
    }

    // Loud diagnostics for missing required components
    if (!this.transformComponent) {
      console.error(
        '[ClickToMoveController] MISSING required component: TransformComponent on entity ' +
          character.name +
          '. Click-to-move will not function.',
      );
    }

    // Find NavMesh in the world (auto-discovered, like GotoBehavior).
    const navMeshEntities = EntityService.findEntitiesWithComponent(NavMeshComponent);
    if (navMeshEntities.length > 0) {
      this.navMeshComponent = navMeshEntities[0].getComponent(NavMeshComponent);
      if (this.debugLogging) {
        console.log('[ClickToMoveController] NavMeshComponent found');
      }
    } else {
      console.warn(
        '[ClickToMoveController] No NavMeshComponent found — pathfinding disabled. ' +
          'Direct walk-to-destination will be used as fallback.',
      );
    }

    // FIS is REQUIRED for tap detection — without it, OnFocusedInteractionInputStartedEvent
    // never fires.
    if (this.clickToMoveActive) {
      this.enableFocusedInteraction();
    }

    if (this.debugLogging) {
      console.log('[ClickToMoveController] Initialised (routing through InputActionsManager)');
    }
  }

  /** Recursively collect all descendant entities (for raycast exclusion). */
  private collectDescendants(root: Entity): Entity[] {
    const result: Entity[] = [];
    const children = root.getChildren({includeDisabled: true});
    for (const child of children) {
      result.push(child);
      result.push(...this.collectDescendants(child));
    }
    return result;
  }

  /**
   * Picks the nearest hit that is not part of the player hierarchy. The native
   * cast can only exclude 4 entities, so every returned hit is filtered here
   * against the full `excludeSet` and the closest survivor (by distance) wins.
   * Returns null when nothing was hit or every hit belongs to the player.
   */
  private selectGroundHit(castOutput: SceneCastOutput): Maybe<SceneHitData> {
    if (!castOutput.hasHitSomething || !castOutput.hits) {
      return null;
    }
    let best: Maybe<SceneHitData> = null;
    for (const hit of castOutput.hits) {
      if (this.isPlayerHierarchyHit(hit)) {
        continue;
      }
      if (best === null || hit.distance < best.distance) {
        best = hit;
      }
    }
    return best;
  }

  /** True when a hit's shape or actor entity belongs to the player hierarchy. */
  private isPlayerHierarchyHit(hit: SceneHitData): boolean {
    return (
      (hit.shapeEntity !== null && this.excludeSet.has(hit.shapeEntity)) ||
      (hit.actorEntity !== null && this.excludeSet.has(hit.actorEntity))
    );
  }

  private enableFocusedInteraction(): void {
    if (this.focusedInteractionEnabled) return;
    FocusedInteractionService.get().enableFocusedInteraction({
      interactionStringId: 'click_to_move',
    });
    FocusedInteractionService.get().setTapVfxEnabled(true);
    FocusedInteractionService.get().setTrailVfxEnabled(false);
    this.focusedInteractionEnabled = true;
  }

  private tearDownFocusedInteraction(): void {
    if (!this.focusedInteractionEnabled) return;
    FocusedInteractionService.get().disableFocusedInteraction();
    this.focusedInteractionEnabled = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public Runtime Toggle API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enable or disable click-to-move at runtime. When disabled, tap events
   * are ignored and any active path is cancelled. FIS stays enabled so
   * re-enabling is instant.
   */
  public setClickToMoveEnabled(enabled: boolean): void {
    this.clickToMoveActive = enabled;
    if (!enabled) {
      if (this.isFollowingPath) {
        this.clearPathAndSignal();
        this.destroyMarker();
      }
      this.tearDownFocusedInteraction();
      console.log('[ClickToMoveController] Click-to-move DISABLED — FIS torn down');
    } else {
      this.enableFocusedInteraction();
      console.log('[ClickToMoveController] Click-to-move ENABLED — FIS enabled');
    }
  }

  /** Returns whether click-to-move is currently active. */
  public isClickToMoveEnabled(): boolean {
    return this.clickToMoveActive;
  }

  /**
   * Not routed through `setClickToMoveEnabled(false)`: that rebuilds focused interaction on
   * every toggle, and re-enabling on revive would override `LocomotionSettingsComponent`.
   */
  private isCharacterDead(): boolean {
    return this.stateMachine?.isDead() ?? false;
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    this.tearDownFocusedInteraction();
    this.destroyMarker();
    if (this.debugLogging) {
      console.log('[ClickToMoveController] onDestroy — cleaned up');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Gesture Detection: InputStarted → record; InputMoved → drag (camera);
  //                    InputEnded → if not drag → tap (pathfind)
  // ═══════════════════════════════════════════════════════════════════════════

  @subscribe(OnFocusedInteractionInputStartedEvent, {execution: ExecuteOn.Everywhere})
  onTouchStart(payload: OnFocusedInteractionInputEventPayload): void {
    if (!this.character || !this.clickToMoveActive) {
      return;
    }

    // Record the touch start — do NOT raycast yet. We defer pathfinding
    // until InputEnded so we can distinguish taps from drags.
    this.isTouching = true;
    this.isDragging = false;
    this.touchStartPos = payload.screenPosition;
    this.touchLastPos = payload.screenPosition;
    this.savedTapPayload = payload;

    if (this.debugLogging) {
      console.log(
        '[ClickToMoveController] Touch START at screen:',
        payload.screenPosition.x.toFixed(1),
        payload.screenPosition.y.toFixed(1),
      );
    }
  }

  @subscribe(OnFocusedInteractionInputMovedEvent, {execution: ExecuteOn.Everywhere})
  onTouchMoved(payload: OnFocusedInteractionInputEventPayload): void {
    if (!this.character || !this.clickToMoveActive || !this.isTouching) {
      return;
    }

    const currentPos = payload.screenPosition;

    // Check if finger has moved far enough to classify as a drag
    if (!this.isDragging) {
      const dx = currentPos.x - this.touchStartPos.x;
      const dy = currentPos.y - this.touchStartPos.y;
      const distSq = dx * dx + dy * dy;
      if (distSq >= this.dragThreshold * this.dragThreshold) {
        this.isDragging = true;
        if (this.debugLogging) {
          console.log('[ClickToMoveController] Gesture classified as DRAG (camera rotate)');
        }
      }
    }

    // While dragging, publish look deltas through the input action bus.
    // The ProjectControlsBridge Look subscriber handles the negation and
    // CameraManager forwarding — we publish raw scaled deltas here.
    if (this.isDragging) {
      const deltaX = currentPos.x - this.touchLastPos.x;
      const deltaY = currentPos.y - this.touchLastPos.y;

      InputActionsManager.instance?.addActionDelta(
        'Look',
        new Vec2(deltaX * this.cameraDragSensitivity, deltaY * this.cameraDragSensitivity),
      );
    }

    this.touchLastPos = currentPos;
  }

  @subscribe(OnFocusedInteractionInputEndedEvent, {execution: ExecuteOn.Everywhere})
  async onTouchEnd(_payload: OnFocusedInteractionInputEventPayload): Promise<void> {
    if (!this.character || !this.clickToMoveActive || !this.isTouching) {
      this.isTouching = false;
      this.savedTapPayload = null;
      return;
    }

    const wasDrag = this.isDragging;
    this.isTouching = false;
    this.isDragging = false;

    // If it was a drag (camera rotation), do NOT pathfind.
    if (wasDrag) {
      if (this.debugLogging) {
        console.log('[ClickToMoveController] Drag ended — no pathfinding');
      }
      this.savedTapPayload = null;
      return;
    }

    // It was a TAP — fire the deferred raycast/pathfinding using the saved
    // InputStarted payload (which has the correct worldRay for the tap point).
    const tapPayload = this.savedTapPayload;
    this.savedTapPayload = null;
    if (!tapPayload) {
      return;
    }

    // Gated here rather than at onTouchStart so a drag still rotates the camera while dead.
    if (this.isCharacterDead()) {
      return;
    }

    if (this.debugLogging) {
      console.log(
        '[ClickToMoveController] Tap confirmed at screen:',
        tapPayload.screenPosition.x.toFixed(1),
        tapPayload.screenPosition.y.toFixed(1),
      );
    }

    try {
      // UnsortedHits (not ClosestHit) so the full player hierarchy can be
      // filtered out here: PhysicsService only excludes 4 entities natively, so
      // if the closest hit were the player's own capsule/mesh (a 5th+ hierarchy
      // entity) ClosestHit would return it and we'd pathfind to our own body.
      // Gathering several hits lets selectGroundHit skip every excluded entity
      // and keep the nearest true ground point behind them.
      const castOutput = await PhysicsService.get().rayCast({
        origin: tapPayload.worldRayOrigin,
        dir: tapPayload.worldRayDirection,
        distance: this.rayMaxDistance,
        mode: CastMode.UnsortedHits,
        collisionLayerMask: CollisionLayerMask.AllLayers,
        includeTriggers: false,
        maxUnsortedHits: kMaxRaycastHits,
        excludeEntities: this.excludeList,
      });

      const groundHit = this.selectGroundHit(castOutput);
      if (!groundHit) {
        if (this.debugLogging) {
          console.log(
            '[ClickToMoveController] Raycast found no ground (nothing hit, or only player hierarchy)',
          );
        }
        return;
      }

      const hitPosition = groundHit.position;
      if (this.debugLogging) {
        console.log(
          '[ClickToMoveController] Ground hit at:',
          hitPosition.x.toFixed(2),
          hitPosition.y.toFixed(2),
          hitPosition.z.toFixed(2),
        );
      }

      if (!this.navMeshComponent) {
        if (this.debugLogging) {
          console.log('[ClickToMoveController] No NavMesh — using direct walk to destination');
        }
        void this.spawnOrMoveMarker(hitPosition);
        void this.requestPathTo(hitPosition, true);
        return;
      }

      void this.spawnOrMoveMarker(hitPosition);
      void this.requestPathTo(hitPosition, true);
    } catch (err) {
      console.error('[ClickToMoveController] Raycast error: ' + String(err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NavMesh Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async snapToNavMesh(position: Vec3): Promise<Maybe<Vec3>> {
    if (!this.navMeshComponent) return null;
    try {
      const snapped = await this.navMeshComponent.findClosestPoint(position, {
        maxSearchDistance: this.findClosestPointSearchDistance,
      });
      return snapped ?? null;
    } catch (err) {
      if (this.debugLogging) {
        console.log('[ClickToMoveController] findClosestPoint error: ' + String(err));
      }
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pathfinding
  // ═══════════════════════════════════════════════════════════════════════════

  private async requestPathTo(destination: Vec3, isUserTap: boolean = false): Promise<void> {
    if (!this.transformComponent) {
      console.error('[ClickToMoveController] Cannot pathfind — TransformComponent missing');
      this.destroyMarker();
      return;
    }

    // No-navmesh fallback: direct beeline
    if (!this.navMeshComponent) {
      this.waypoints = [destination];
      this.currentWaypointIndex = 0;
      this.currentDestination = destination;
      this.pathWasTruncated = false;
      this.isFollowingPath = true;
      this.timeSinceLastRepath = 0;
      InputActionsManager.instance?.setButtonState('ClickToMove', true);
      if (this.debugLogging) {
        console.log('[ClickToMoveController] No NavMesh — direct walk to destination');
      }
      return;
    }

    // Last-tap-wins: if a request is in flight, store as pending.
    if (this.pathRequestInFlight) {
      if (this.pendingDestination !== null && this.pendingIsUserTap && !isUserTap) {
        if (this.debugLogging) {
          console.log('[ClickToMoveController] Repath skipped — user tap already queued');
        }
        return;
      }
      this.pendingDestination = destination;
      this.pendingIsUserTap = isUserTap;
      if (this.debugLogging) {
        console.log(
          '[ClickToMoveController] Path request in flight — queuing pending destination' +
            (isUserTap ? ' (user tap)' : ' (repath)'),
        );
      }
      return;
    }

    this.pathRequestInFlight = true;
    try {
      const start = this.transformComponent.worldPosition;
      const path = await this.navMeshComponent.findPath(start, destination, {
        maxPathSize: this.maxPathSize,
        maxSearchDistance: this.findPathSearchDistance,
      });

      if (path && path.length > 0) {
        this.pathWasTruncated = path.length >= this.maxPathSize;

        if (this.debugLogging) {
          console.log(
            `[ClickToMoveController] Path found with ${path.length} waypoints` +
              (this.pathWasTruncated ? ' (TRUNCATED — will request continuation)' : ''),
          );
        }

        this.waypoints = path;
        this.currentWaypointIndex = this.findNearestWaypointAhead(path, start);
        this.currentDestination = destination;
        this.isFollowingPath = true;
        this.timeSinceLastRepath = 0;
        InputActionsManager.instance?.setButtonState('ClickToMove', true);
      } else {
        if (this.debugLogging) {
          console.log(
            '[ClickToMoveController] findPath returned empty — attempting navmesh snap fallback',
          );
        }
        const snapped = await this.snapToNavMesh(destination);
        if (snapped) {
          const retryPath = await this.navMeshComponent.findPath(start, snapped, {
            maxPathSize: this.maxPathSize,
            maxSearchDistance: this.findPathSearchDistance,
          });
          if (retryPath && retryPath.length > 0) {
            this.pathWasTruncated = retryPath.length >= this.maxPathSize;
            this.waypoints = retryPath;
            this.currentWaypointIndex = this.findNearestWaypointAhead(retryPath, start);
            this.currentDestination = snapped;
            this.isFollowingPath = true;
            this.timeSinceLastRepath = 0;
            InputActionsManager.instance?.setButtonState('ClickToMove', true);
            if (this.debugLogging) {
              console.log(
                `[ClickToMoveController] Fallback snap succeeded — path has ${retryPath.length} waypoints`,
              );
            }
          } else {
            this.stopFollowingOnFailedTap(isUserTap);
            if (this.debugLogging) {
              console.log(
                '[ClickToMoveController] Fallback snap: point valid but no path found — giving up',
              );
            }
          }
        } else {
          this.stopFollowingOnFailedTap(isUserTap);
          if (this.debugLogging) {
            console.log(
              '[ClickToMoveController] No valid navmesh point near destination — giving up',
            );
          }
        }
      }
    } catch (err) {
      console.warn('[ClickToMoveController] findPath error — falling back to direct walk: ' + String(err));
      this.waypoints = [destination];
      this.currentWaypointIndex = 0;
      this.currentDestination = destination;
      this.pathWasTruncated = false;
      this.isFollowingPath = true;
      this.timeSinceLastRepath = 0;
      InputActionsManager.instance?.setButtonState('ClickToMove', true);
    } finally {
      this.pathRequestInFlight = false;

      if (this.pendingDestination) {
        const pending = this.pendingDestination;
        const pendingWasUserTap = this.pendingIsUserTap;
        this.pendingDestination = null;
        this.pendingIsUserTap = false;
        void this.requestPathTo(pending, pendingWasUserTap);
      }
    }
  }

  /**
   * A tap that resolves to no reachable navmesh point must halt the character
   * rather than leave the prior path running — otherwise the periodic repath in
   * onUpdate keeps steering toward the stale destination. Only user taps stop an
   * active path; a failed repath keeps the existing (still-valid) path so a
   * transient failure doesn't strand the character mid-route.
   */
  private stopFollowingOnFailedTap(isUserTap: boolean): void {
    if (isUserTap) {
      this.clearPathAndSignal();
    }
    this.destroyMarker();
  }

  /**
   * After a repath, find the index of the nearest waypoint that is ahead of
   * the character's current position (avoids briefly steering backward).
   */
  private findNearestWaypointAhead(path: Vec3[], currentPos: Vec3): number {
    if (path.length <= 1) return 0;

    let bestIndex = 0;
    let bestDistSq = Infinity;

    for (let i = 0; i < path.length; i++) {
      const dx = path[i].x - currentPos.x;
      const dz = path[i].z - currentPos.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestIndex = i;
      }
    }

    if (bestIndex < path.length - 1) {
      const reachSq = this.waypointReachDistance * this.waypointReachDistance;
      if (bestDistSq < reachSq) {
        return bestIndex + 1;
      }
    }

    return bestIndex;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Per-Frame Steering — Publishes camera-relative Vec2 to InputActionsManager
  // ═══════════════════════════════════════════════════════════════════════════

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(payload: OnWorldUpdateEventPayload): void {
    if (!this.transformComponent) return;

    // The Dead state blocks MovementAbility downstream, but a live path would keep
    // republishing a non-zero 'Move' axis - drop the path and zero the bus here.
    if (this.isCharacterDead()) {
      if (this.isFollowingPath) {
        this.clearPathAndSignal();
        this.destroyMarker();
      }
      return;
    }

    // Only drive movement while isFollowingPath. When not following a path,
    // leave everything alone so joystick / PlayerActionController can drive.
    if (!this.isFollowingPath || this.waypoints.length === 0) {
      return;
    }

    const dt = payload.deltaTime;
    this.frameCount++;

    // Periodic repathing
    this.timeSinceLastRepath += dt;
    if (this.repathIntervalSec > 0 && this.timeSinceLastRepath >= this.repathIntervalSec) {
      this.timeSinceLastRepath = 0;
      void this.requestPathTo(this.currentDestination, false);
    }

    const currentPos = this.transformComponent.worldPosition;
    const targetWaypoint = this.waypoints[this.currentWaypointIndex];

    // Compute XZ distance to current waypoint
    const dx = targetWaypoint.x - currentPos.x;
    const dz = targetWaypoint.z - currentPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    // Check if this is the final waypoint in the current path
    const isLastInPath = this.currentWaypointIndex >= this.waypoints.length - 1;
    const isFinalWaypoint = isLastInPath && !this.pathWasTruncated;
    const reachDist = isFinalWaypoint ? this.destinationReachDistance : this.waypointReachDistance;

    if (distXZ < reachDist) {
      if (isFinalWaypoint) {
        // Arrived at destination
        if (this.debugLogging) {
          // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- fires once per completed path, and only when debugLogging is on
          console.log('[ClickToMoveController] Arrived at destination');
        }
        this.clearPathAndSignal();
        this.destroyMarker();
        return;
      } else if (isLastInPath && this.pathWasTruncated) {
        // Reached end of truncated path: request continuation
        if (this.debugLogging) {
          // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- fires once per truncated path segment, and only when debugLogging is on
          console.log(
            '[ClickToMoveController] Reached end of truncated path — requesting continuation',
          );
        }
        this.pathWasTruncated = false;
        void this.requestPathTo(this.currentDestination, false);
        return;
      } else {
        // Advance to next waypoint
        this.currentWaypointIndex++;
        return;
      }
    }

    // Compute world-space direction to waypoint (XZ plane only)
    const invDist = 1 / distXZ;
    const worldDirX = dx * invDist;
    const worldDirZ = dz * invDist;

    // Compute speed scale — ramp down near final destination
    let speedScale = 1.0;
    if (isFinalWaypoint && this.arrivalRampDistance > 0 && distXZ < this.arrivalRampDistance) {
      speedScale = Math.max(distXZ / this.arrivalRampDistance, 0.1);
    }

    // --- Inverse-project world direction into camera-relative Vec2 ---
    // MovementAbility expects camera-relative input; the camera basis
    // conversion happens downstream in MovementAbility.calculateMovementDirection().
    const camFwd3 = CameraService.get().forward;
    let fwdX = camFwd3.x;
    let fwdZ = camFwd3.z;
    const fwdMagSq = fwdX * fwdX + fwdZ * fwdZ;

    if (fwdMagSq > 0.001) {
      // Valid XZ projection — normalise and cache
      const fwdInvMag = 1 / Math.sqrt(fwdMagSq);
      fwdX *= fwdInvMag;
      fwdZ *= fwdInvMag;
      this.lastValidCamFwdX = fwdX;
      this.lastValidCamFwdZ = fwdZ;
    } else {
      // Camera near-overhead — reuse last valid forward
      fwdX = this.lastValidCamFwdX;
      fwdZ = this.lastValidCamFwdZ;
    }

    // Camera right on XZ = forward × up = (-fwdZ, 0, fwdX)
    const rightX = -fwdZ;
    const rightZ = fwdX;

    // Dot the world direction with cam right/forward to get camera-relative input
    const inputX = worldDirX * rightX + worldDirZ * rightZ;
    const inputY = worldDirX * fwdX + worldDirZ * fwdZ;

    // Scale by arrivalRamp — magnitude controls character speed through MovementAbility
    // eslint-disable-next-line mhs-linter/no-allocation-in-update-loop -- Vec2 is immutable, one per frame
    const moveInput = new Vec2(inputX * speedScale, inputY * speedScale);
    InputActionsManager.instance?.setAxis2DValue('Move', moveInput);

    // Facing is handled automatically by AutoFaceRotationAbility, which reads
    // MovementAbility.getMovementDirection() — no manual rotation slerp needed.

    // Periodic diagnostic behind debugLogging and frame counter
    if (this.debugLogging && this.frameCount % 60 === 0) {
      // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- throttled to every 60th frame, and only when debugLogging is on
      console.log(
        `[ClickToMoveController] Following: wpIdx=${this.currentWaypointIndex}` +
          `/${this.waypoints.length}` +
          ` dist=${distXZ.toFixed(2)}` +
          ` moveInput=(${moveInput.x.toFixed(2)}, ${moveInput.y.toFixed(2)})` +
          (this.pathWasTruncated ? ' (truncated)' : ''),
      );
    }
  }

  /**
   * Clear path state and signal the input bus that click-to-move steering
   * has ended. Zeroes the 'Move' axis so the character stops, and releases
   * the 'ClickToMove' button so other systems (e.g. PlayerActionController)
   * know the bus is free.
   */
  private clearPathAndSignal(): void {
    this.isFollowingPath = false;
    this.waypoints.length = 0;
    this.pathWasTruncated = false;
    InputActionsManager.instance?.setAxis2DValue('Move', Vec2.zero);
    InputActionsManager.instance?.setButtonState('ClickToMove', false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Destination Marker
  // ═══════════════════════════════════════════════════════════════════════════

  private async spawnOrMoveMarker(position: Vec3): Promise<void> {
    this.markerGeneration++;
    const gen = this.markerGeneration;

    this.destroyMarker();

    if (!this.destinationMarkerTemplate) return;

    try {
      const spawned = await WorldService.get().spawnTemplate({
        templateAsset: this.destinationMarkerTemplate,
        networkMode: NetworkMode.LocalOnly,
        position: position,
        rotation: null,
        scale: null,
        parent: null,
        serverOwned: false,
      });

      if (gen !== this.markerGeneration) {
        spawned.destroy();
        return;
      }

      this.destinationMarkerEntity = spawned;
    } catch (err) {
      if (this.debugLogging) {
        console.log('[ClickToMoveController] Failed to spawn destination marker: ' + String(err));
      }
    }
  }

  private destroyMarker(): void {
    if (this.destinationMarkerEntity) {
      this.destinationMarkerEntity.destroy();
      this.destinationMarkerEntity = null;
    }
  }
}
