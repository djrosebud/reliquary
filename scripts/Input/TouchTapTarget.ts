/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v1

import {
  component,
  Component,
  property,
  subscribe,
  ExecuteOn,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  CameraService,
  PhysicsService,
  NetworkingService,
  CastMode,
  CollisionLayerMask,
  Vec2,
  Vec3,
} from 'meta/worlds';
import type {
  Entity,
  Maybe,
  EventSubscription,
  RayCastInput,
  SceneCastOutput,
} from 'meta/worlds';
import {TouchHoldMode, TouchRouter} from './TouchRouter';

// ============================================================================
// Tuning constants
// ============================================================================

// A press whose finger travels more than this normalized screen distance
// between down and up is a DRAG, not a tap, and is ignored. Keeping this small
// lets the control sit passThrough over a camera-look drag: the drag turns the
// camera (camera-look owns it beneath), and only a clean tap raycasts.
const TAP_MAX_TRAVEL = 0.03;

// Far-point distance (world units) used to build the pick ray from the camera.
// The ray direction is (screenToWorldPoint(x, y, RAY_FAR) - cameraPos); the
// actual pick length is `maxRayDistance` below.
const RAY_FAR = 1000;

// ============================================================================
// Public hit payload
// ============================================================================

/**
 * Delivered to {@link TouchTapTarget.subscribeTap} consumers when a tap
 * resolves to a world-space hit. This is the rich channel the scalar/vector
 * {@link InputActionsManager} bus cannot carry (an entity + a Vec3 point +
 * a normal), so tap-target has its own subscription rather than a bus action.
 */
export class TapHitEvent {
  /** Router finger index that produced the tap. */
  readonly interactionIndex: number;
  /** Normalized tap position (0..1, +Y down). */
  readonly screenPosition: Vec2;
  /** World-space point where the pick ray hit. */
  readonly worldPoint: Vec3;
  /** Normalized surface normal at the hit. */
  readonly normal: Vec3;
  /** Physics body hit. May be null even on a hit — check {@link shapeEntity}. */
  readonly actorEntity: Maybe<Entity>;
  /** Collider shape hit. Avatar parts often appear here with a null actor. */
  readonly shapeEntity: Maybe<Entity>;
  /** Distance from the camera to the hit, world units. */
  readonly distance: number;

  constructor(
    interactionIndex: number,
    screenPosition: Vec2,
    worldPoint: Vec3,
    normal: Vec3,
    actorEntity: Maybe<Entity>,
    shapeEntity: Maybe<Entity>,
    distance: number,
  ) {
    this.interactionIndex = interactionIndex;
    this.screenPosition = screenPosition;
    this.worldPoint = worldPoint;
    this.normal = normal;
    this.actorEntity = actorEntity;
    this.shapeEntity = shapeEntity;
    this.distance = distance;
  }
}

/** Callback signature for {@link TouchTapTarget.subscribeTap}. */
export type TapHitCallback = (event: TapHitEvent) => void;

// ============================================================================
// Component
//
// A screen-tap -> world-raycast control. It has no XAML (a world tap has no
// on-screen widget). Touch is delivered by the shared TouchRouter; this control
// registers a descriptor instead of subscribing to the raw OnTouchInput* events
// itself. On a clean TAP (not a drag) it builds a pick ray from the active
// camera via CameraService.screenToWorldPoint + position, runs
// PhysicsService.rayCast, and delivers the hit (entity/point/normal) to
// subscribeTap consumers. This is the project-owned replacement for
// FocusedInteractionService's "tap the world" use on mobile/character_template;
// it deliberately ships NO tap/trail VFX.
//
// LAYERING: registers at zPriority 40 (below HUD buttons 100 and the joystick
// 50, above camera-look 0) with passThrough:true, so a drag still reaches the
// camera-look drag beneath while a tap raycasts. hitTest is the whole screen by
// default; higher-z buttons/joystick own and consume their own regions first.
//
// CLIENT-ONLY: CameraService and PhysicsService are client-only. Touches only
// originate client-side, but the raycast path guards isServerContext() anyway.
// ============================================================================

@component()
export class TouchTapTarget extends Component {
  /** Global access point so consumers can subscribe: `TouchTapTarget.instance?.subscribeTap(...)`. */
  public static instance: Maybe<TouchTapTarget> = null;

  /** Router layer. Below buttons (100) and joystick (50); above camera-look (0). */
  @property()
  zPriority: number = 40;

  /** Max pick-ray length in world units. */
  @property()
  maxRayDistance: number = 10000;

  private subscribers: {id: number; cb: TapHitCallback}[] = [];
  private nextSubId: number = 0;
  // Touch-down position per finger index, to classify tap vs drag at release.
  private downByIndex: Map<number, Vec2> = new Map();
  // Set in onDestroy so an in-flight async rayCast that resolves after teardown
  // does not dispatch to torn-down subscribers.
  private destroyed: boolean = false;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    TouchTapTarget.instance = this;
    TouchRouter.register({
      id: 'tapTarget',
      zPriority: this.zPriority,
      // Let a drag also reach camera-look beneath; we act only on a clean tap.
      passThrough: true,
      // Keep the finger so onEnd always fires with the release position, even
      // if it drifts, so drag classification is correct.
      holdMode: TouchHoldMode.HoldUntilRelease,
      hitTest: (_pos: Vec2) => true,
      handlers: {
        onStart: (index: number, pos: Vec2) =>
          this.downByIndex.set(index, new Vec2(pos.x, pos.y)),
        onEnd: (index: number, pos: Vec2) => this.handleEnd(index, pos),
      },
    });
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    this.destroyed = true;
    TouchRouter.unregister('tapTarget');
    this.downByIndex.clear();
    this.subscribers = [];
    if (TouchTapTarget.instance === this) {
      TouchTapTarget.instance = null;
    }
  }

  // --------------------------------------------------------------------------
  // Subscribe
  // --------------------------------------------------------------------------

  /**
   * Register a callback fired whenever a tap resolves to a world hit.
   * @returns A handle with a `disconnect()` method — call it in `onDestroy()`.
   */
  public subscribeTap(cb: TapHitCallback): EventSubscription {
    const id = this.nextSubId;
    this.nextSubId += 1;
    this.subscribers.push({id, cb});
    return {
      disconnect: () => {
        const at = this.subscribers.findIndex(s => s.id === id);
        if (at >= 0) {
          this.subscribers.splice(at, 1);
        }
      },
    };
  }

  // --------------------------------------------------------------------------
  // Router handler
  // --------------------------------------------------------------------------

  private handleEnd(index: number, pos: Vec2): void {
    const down = this.downByIndex.get(index);
    this.downByIndex.delete(index);
    if (down == null) {
      return;
    }
    const dx = pos.x - down.x;
    const dy = pos.y - down.y;
    if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_TRAVEL) {
      return; // a drag, not a tap — leave it to the camera-look drag beneath.
    }
    if (NetworkingService.get().isServerContext()) {
      return; // CameraService / PhysicsService are client-only.
    }

    const cam = CameraService.get();
    const origin = cam.position;
    const far = cam.screenToWorldPoint(new Vec3(pos.x, pos.y, RAY_FAR));
    const dir = far.sub(origin).normalize();

    const input: RayCastInput = {
      mode: CastMode.ClosestHit,
      origin,
      dir,
      distance: this.maxRayDistance,
      collisionLayerMask: CollisionLayerMask.AllLayers,
      includeTriggers: false,
      maxUnsortedHits: 1,
    };

    // rayCast is asynchronous: the hit arrives a beat after the tap. Snapshot
    // the tap position so the resolved event reports where the finger lifted.
    const tapPos = new Vec2(pos.x, pos.y);
    PhysicsService.get()
      .rayCast(input)
      .then((out: SceneCastOutput) => {
        if (this.destroyed) {
          return; // component torn down while the raycast was in flight.
        }
        if (!out.hasHitSomething || out.hits == null || out.hits.length === 0) {
          return; // tapped empty space (e.g. the sky): no hit to deliver.
        }
        const hit = out.hits[0];
        const event = new TapHitEvent(
          index,
          tapPos,
          hit.position,
          hit.normal,
          hit.actorEntity,
          hit.shapeEntity,
          hit.distance,
        );
        // Snapshot the subscriber list so a callback that disconnects
        // mid-dispatch cannot shift indices out from under the loop.
        for (const s of this.subscribers.slice()) {
          s.cb(event);
        }
      })
      .catch((err: unknown) => {
        console.error('[TouchTapTarget] rayCast failed', err);
      });
  }
}
