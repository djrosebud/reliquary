/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v2

import { Vec3, PlayerService, TransformComponent, WorldTextComponent } from 'meta/worlds';
import type { Entity } from 'meta/worlds';
import { ActorBehavior } from 'meta/worlds';
import { GotoBehavior } from './GotoBehavior';
import type { ActorController } from 'meta/worlds';
import type { ActorBehaviorManager } from 'meta/worlds';
import { ActorBodyDirectionControllerTypeId, type ActorBodyDirectionController, ActorBodyDirectionParams } from 'meta/worlds';
import type { TargetInfo } from './TargetingBehavior';

// Upper bound on `stuckSettleHardMultiplier`. Bounded on both sides because the
// failure modes are symmetric: below 1 the escape fires before the normal
// fallback and defeats the gate; a large value deletes the escape. A large
// FINITE value does that just as effectively as `Infinity`, so a finiteness
// check alone is not enough.
const MAX_HARD_STUCK_MULTIPLIER = 60;

// Floor on the settled-exit debounce (s). Selected whenever `stuckSettleTime`
// sanitizes below 0.2s -- including the 0 that negative and non-finite values
// map to; keeps the edge debounced even then.
const MIN_SETTLE_EXIT_DEBOUNCE_S = 0.2;

// Ceiling on the settled-exit debounce (s). `stuckSettleTime` is author-settable
// and sanitized only against non-finite/non-positive values, so without this a
// large FINITE value holds a jostled actor at zero speed outside its attack band
// for that whole interval -- the parking the exit clause exists to fix. Chosen
// against two fixed points rather than as a multiple of the floor, so retuning
// the floor cannot drag it: 1s is above the 0.5 default `stuckSettleTime`, so no
// shipped caller moves, and well under the 5s at which
// `EngageCombatBehavior.updatePursuitStallWarning` calls being held outside the
// band a configuration error.
const MAX_SETTLE_EXIT_DEBOUNCE_S = 1.0;

// Per-second decay applied to a gate timer while the actor is on the FAVOURABLE
// side of the edge. Decay rather than reset: a hard reset lets an actor
// oscillating across the gate zero the timer every other frame and stay parked
// out of attack range forever. Below 1x, any duty cycle spending more than a
// third of its time on the unfavourable side still converges, while true
// single-frame jitter cannot trip the edge.
const GATE_TIMER_DECAY_RATE = 0.5;

// Cap on how many STEPS the park interval grows over consecutive failed
// retries. Distinct from the fraction cap below: this bounds the step count,
// that bounds the resulting DURATION.
const MAX_PARK_BACKOFF = 8;

// Cap on the park interval as a fraction of the pursue window. This, not the
// step cap, is what holds the asymmetry — the park scales with
// `consecutiveParks` while the pursue window does not, so an unconditional step
// cap of 8 against the default multiplier of 6 would make a saturated park
// LONGER than the pursue window. A step cap derived as `floor(multiplier) - 1`
// still yields park == pursue at multiplier 1, which is the clamp floor every
// zero-init / negative / NaN / Infinity value lands on.
const MAX_PARK_FRACTION_OF_PURSUE = 0.8;

/**
 * FollowBehavior - A behavior that follows a target entity.
 *
 * Navigates to the target's actual position via the NavMesh (routing around
 * walls) and stops `followRange` short of the target measured along the path,
 * parking there while the target is still.
 *
 * Supports two modes:
 * - **Composite mode** (`targetInfo` provided): Reads `predictedPosition`
 *   from the shared TargetInfo written by TargetingBehavior. With the parent
 *   `velocityPredictionTime > 0`, the actor navigates toward where the target
 *   will be in `velocityPredictionTime` seconds — leading the chase. Set
 *   `velocityPredictionTime = 0` on the parent to revert to pure
 *   current-position tracking.
 * - **Standalone mode** (`targetInfo` is null): Uses the raw target position.
 *   When `followPlayer` is true, the closest player is resolved dynamically.
 *
 * ## Hysteresis (motion state machine + arrival deceleration)
 *
 * To avoid stop-go cycles AND smoothly handle target stops without any
 * dependency on velocity smoothing, the behavior combines a two-state
 * motion machine with arrival-style speed control:
 *
 * - **`pursuing`**: actor drives toward the follow point at a speed that
 *   linearly decelerates with distance — full `followSpeed` at or beyond
 *   `hysteresisRadius` from the follow point, ramping to 0 at the center.
 * - **`settled`**: actor parks (`desiredSpeed = 0`); body direction still
 *   tracks the target. With `hysteresisRadius > 0` this is entered only when
 *   the target is essentially still (`targetSpeedXZ ≤ targetMovingThreshold`);
 *   with `hysteresisRadius = 0` it is entered purely on arrival at the follow
 *   point, regardless of target motion.
 *
 * **Arrival speed (Reynolds-style)**:
 * ```
 *   t           = min(1, distToFollow / hysteresisRadius)  // 0 at center
 *   desiredSpeed = followSpeed * t                           // smooth ramp
 * ```
 * Self-equilibrates when the target moves at constant speed: the actor
 * naturally cruises at an offset behind the follow point such that
 * `followSpeed * (offset / hysteresisRadius) ≈ targetSpeed`. For a
 * player walking at 2 m/s with `followSpeed = 5` and `hysteresisRadius =
 * 1.5`, the actor settles ~0.6 m behind the follow point and matches
 * pace — no burst-and-brake cycle, no transient when the target stops
 * (since `desiredSpeed` depends only on distance, never on a smoothed
 * velocity that lags).
 *
 * **Trade-off**: while the target is moving, the actor sits *behind* the
 * follow point by an offset proportional to target speed (rather than
 * exactly *at* the follow point). Acceptable for chase / tail-following;
 * if you need tighter tracking, shrink `hysteresisRadius` (smaller soft
 * zone → smaller equilibrium offset, but less hysteresis benefit).
 *
 * **Transitions** (XZ-plane distances):
 * - `pursuing → settled` when actor is **inside** `hysteresisRadius` AND
 *   (arrived within `distanceToStop` of the follow point, OR stuck-but-close
 *   fallback fires, OR the hard-stuck escape fires) AND target is essentially
 *   still.
 * - `settled → pursuing` the moment actor is **outside** `hysteresisRadius`,
 *   or — for a follower with a finite `stuckSettleMaxDistance` — when it is
 *   pushed beyond that gate without having arrived within `distanceToStop`.
 *   A target that starts moving while its follow point still sits inside
 *   the hysteresis zone is intentionally ignored — the actor waits until
 *   the player has walked far enough to drag the follow point out.
 *   With the default `Infinity` gate only the hysteresis clause can fire, so
 *   non-combat followers keep the original exit rule exactly.
 *
 * Set `hysteresisRadius = 0` to disable arrival deceleration (pure pursuit at
 * `followSpeed`); the actor still parks at `followRange` on arrival (within
 * `distanceToStop`) regardless of target motion — the original
 * stop-at-followRange behavior, without the soft-zone smoothing.
 *
 * **Tuning note**: when using composite mode with velocity prediction, set
 * `hysteresisRadius` ≳ `velocityPredictionTime * expectedTargetSpeed` so
 * that the predicted-point snap-back when a moving target stops stays
 * inside the soft zone (no backpedal). The radius can be changed at any
 * time; the state machine reads it every frame.
 */
export class FollowBehavior extends ActorBehavior {
  override name: string = 'FollowBehavior';

  /**
   * Target entity to follow.
   * In composite mode, this is overridden by targetInfo.targetEntity.
   */
  targetEntity: Entity | null = null;

  /**
   * Desired follow distance from target in meters
   */
  followRange: number = 1.0;

  /**
   * Movement speed
   */
  followSpeed: number = 5.0;

  // GotoBehavior pass-through parameters
  repathInterval: number = 0.2;
  distanceToStop: number = 0.1;

  /**
   * Controls which direction the actor faces while following.
   *   'faceTarget'   — face toward the target entity
   *   'faceMovement' — face the direction the actor is moving (its travel heading)
   *   'matchTarget'  — face the same direction as the target
   *   'none'         — do not control body direction (actor keeps its facing)
   */
  bodyDirectionMode: 'faceTarget' | 'faceMovement' | 'matchTarget' | 'none' = 'faceTarget';

  /**
   * Angular speed in radians per second for body direction rotation.
   */
  bodyDirectionAngularSpeed: number = 3.14;

  /**
   * Shared target info from a parent CompositeBehavior.
   * When provided, position/velocity/prediction data is read from here.
   * When null, standalone mode is used (raw target position, no prediction).
   */
  targetInfo: TargetInfo | null = null;

  /**
   * When true, the behavior dynamically resolves the closest player as the
   * target every `playerSearchInterval` seconds. This handles the case where
   * the player spawns after the NPC: the behavior keeps searching until a
   * player appears, then follows them. If the followed player disconnects,
   * it will re-acquire the next closest player.
   */
  followPlayer: boolean = false;

  /**
   * How often (in seconds) to search for the closest player when
   * `followPlayer` is true. Lower values are more responsive but slightly
   * more expensive. Only used in standalone + followPlayer mode.
   */
  playerSearchInterval: number = 0.5;

  protected gotoBehavior: GotoBehavior | null = null;
  protected actorTransform: TransformComponent | null = null;

  /**
   * Internal timer for throttling player searches in followPlayer mode.
   */
  protected playerSearchTimer: number = 0;

  /**
   * The direction the actor should face (towards target).
   * Null if body direction is not being controlled by this behavior.
   */
  protected desiredBodyDirection: Vec3 | null = null;

  // ── Hysteresis ────────────────────────────────────────────────────

  /**
   * Soft-zone radius (meters, XZ plane) around the follow point. When the
   * actor is inside this radius AND has arrived (or is stuck-but-close),
   * the actor settles and stops issuing movement requests until the follow
   * point drifts outside the radius.
   *
   * Set to 0 to disable hysteresis (pure pursuit — original behavior).
   * May be changed dynamically; read every frame.
   */
  hysteresisRadius: number = 0;

  /**
   * Actor XZ speed (m/s) below which the actor is considered "stuck" — i.e.
   * unable to make further progress toward the follow point (e.g. blocked
   * by collision, peer actor crowding).
   */
  stuckSpeedThreshold: number = 0.1;

  /**
   * Sustained time (seconds) the actor must remain "stuck" while inside
   * `hysteresisRadius` before the motion state is force-settled. Prevents
   * unreachable-point thrashing. Set to 0 to disable the fallback — which
   * also disables the `stuckSettleHardMultiplier` escape that backstops it.
   *
   * A finite `stuckSettleMaxDistance` narrows where this fallback may park
   * the actor; `stuckSettleHardMultiplier` is what preserves the
   * anti-thrashing guarantee outside that zone.
   */
  stuckSettleTime: number = 0.5;

  /**
   * Maximum along-path distance to the follow point (meters) at which the
   * stuck fallback is allowed to force-settle the actor. Beyond this the actor
   * stays `pursuing` even while stuck, so it keeps issuing move requests and
   * can resume closing the gap the moment the blockage clears (e.g. peer
   * crowding at a shared objective) instead of permanently parking short of
   * goal.
   *
   * Defaults to `Infinity` — the legacy rule where the stuck fallback settles
   * anywhere inside `hysteresisRadius`. Combat followers tighten this to their
   * attack band so a jostled actor stopped just OUTSIDE attack range does not
   * park there for good (see `EngageCombatBehavior`). Only the stuck branch is
   * gated; genuine arrival (within `distanceToStop`) still settles regardless.
   */
  stuckSettleMaxDistance: number = Number.POSITIVE_INFINITY;

  /**
   * Multiple of `stuckSettleTime` after which a follower held out of the
   * `stuckSettleMaxDistance` zone parks anyway, and — having parked — waits
   * before retrying.
   *
   * Gating the stuck fallback removes the only quiescence path for a follow
   * point that is permanently unreachable (blocked geometry rather than
   * transient crowding): such an actor would otherwise pursue and repath
   * forever. This bounds that to an ASYMMETRIC duty cycle — pursue for
   * `stuckSettleTime * clamped`, then park for
   * `stuckSettleTime * consecutiveParks` (backing off over consecutive failed
   * retries), retry — so an unreachable goal costs bounded LOCOMOTION while a
   * crowd that clears is still closed on. It bounds only LOCOMOTION, and no
   * other per-frame cost: `GotoBehavior` gates `findPath` on `repathInterval`
   * and a minimum tick count, never on motion state, so a parked actor keeps
   * repathing — and keeps arbitrating its movement controller and building
   * move params — at exactly the rate it pursued at.
   *
   * `clamped` is this value clamped to `[1, MAX_HARD_STUCK_MULTIPLIER]`, with
   * any non-finite value collapsing to 1 — so `Infinity` yields the SHORTEST
   * pursue window and the most eager escape. Note the deliberate contrast with
   * `stuckSettleMaxDistance`, where `Infinity` is the inert value.
   *
   * The park is deliberately the SHORT half: a parked actor cannot shorten its
   * own path, so the park duration is the worst-case added attack latency. It
   * is bounded by whichever of two caps binds first — `MAX_PARK_BACKOFF`
   * steps, or `MAX_PARK_FRACTION_OF_PURSUE` of the pursue window — leaving it
   * always strictly shorter than the pursue half, never equal to it. At the
   * default 6 the fraction binds (80% of the window); above 10 the step cap
   * binds instead, so the park becomes a progressively smaller share of an
   * ever-longer pursue window (13% at the ceiling of 60).
   *
   * Three separate conditions leave this inert. `stuckSettleMaxDistance` at
   * `Infinity` (its default), because the actor then always parks via the
   * normal fallback. `stuckSettleTime` at 0, which disables the fallback the
   * escape is derived from. And `hysteresisRadius <= 0` — the default of this
   * class and of `FollowTaggedEntityBehavior` — which returns before any of
   * this runs, so the duty cycle exists only for a caller that opts into a
   * soft zone. `EngageCombatBehavior` is the one that does.
   */
  stuckSettleHardMultiplier: number = 6;

  /**
   * XZ speed (m/s) below which the target is considered "essentially still".
   *
   * - When target speed is **below** this, the actor is allowed to enter
   *   `settled` (full stop) on arrival inside hysteresis.
   * - When target speed is **at or above** this, the actor stays in
   *   `pursuing` and uses arrival deceleration instead — naturally
   *   cruising at an equilibrium offset behind the follow point.
   *
   * Composite mode only (uses `targetInfo.smoothedVelocity`). In standalone
   * mode this has no effect.
   */
  targetMovingThreshold: number = 0.1;

  /**
   * Internal motion state. Drives whether follow issues move requests
   * (`pursuing`) or parks the actor (`settled`).
   */
  protected motionState: 'pursuing' | 'settled' = 'pursuing';

  /**
   * Actor world position recorded last frame. Used to compute the actor's
   * actual XZ speed for stuck detection.
   */
  protected prevActorPos: Vec3 | null = null;

  /**
   * Time (seconds) the actor has been below `stuckSpeedThreshold`
   * continuously. Reset on adequate movement or on transition out of
   * `settled`.
   */
  protected stuckTimer: number = 0;

  /**
   * True while `settled` was entered by the hard-stuck escape rather than by
   * arrival or the in-zone stuck fallback. Suppresses the
   * `stuckSettleMaxDistance` exit clause that would otherwise evict the actor
   * on the very next frame, and marks it for the retry release.
   */
  protected settledOutOfZone: boolean = false;

  /**
   * Time (s) the actor has been continuously beyond `stuckSettleMaxDistance`
   * while settled. The settled-exit edge is debounced in TIME rather than by a
   * distance margin: a distance margin would move the threshold off the attack
   * edge and re-open the out-of-range parking the gate exists to close.
   */
  protected settleExitDebounceTimer: number = 0;

  /**
   * Time (s) the actor has been continuously held BEYOND the settle gate while
   * pursuing, with the target still. Drives ENTRY to the hard-stuck park.
   *
   * Deliberately not `stuckTimer`: that measures "not moving" and resets on any
   * frame above `stuckSpeedThreshold`, which a jostling crowd clears
   * continuously — so a `stuckTimer`-driven entry never fires in exactly the
   * crowded scenario the escape exists for.
   */
  protected pursuingOutOfRangeTimer: number = 0;

  /**
   * Time (s) since the actor was parked out-of-zone by the hard-stuck escape.
   * Drives the RETRY release. Separate from the entry timer because a parked
   * actor cannot shorten its own path, so only elapsed time can re-engage it.
   */
  protected parkedRetryTimer: number = 0;

  /**
   * Consecutive hard-stuck parks without the actor reaching its gate in
   * between. Lengthens the park so a genuinely unreachable goal decays into a
   * slower duty cycle, while transient crowding still re-engages promptly.
   */
  protected consecutiveParks: number = 0;

  // ── Debug ──────────────────────────────────────────────────────────

  /**
   * Optional in-world text entity for live debug output. Each frame, a
   * line containing the motion state, desiredSpeed and distance to the
   * follow point is appended to a circular buffer of `debugMaxFrames`
   * entries; the buffer is then written into the entity's
   * `WorldTextComponent.text` (newline-separated, oldest first).
   *
   * If null or the entity has no `WorldTextComponent`, debug output
   * is skipped entirely (no buffering, no overhead beyond the null check).
   */
  debugTextEntity: Entity | null = null;

  /**
   * Maximum number of frames retained in the rolling debug log.
   */
  debugMaxFrames: number = 10;

  /** Internal: rolling log of debug lines (newest at the end). */
  protected debugLog: string[] = [];

  /** Internal: monotonic frame counter prefixed onto each log entry. */
  protected debugFrameCounter: number = 0;

  /** Internal: snapshot of the desiredSpeed sent to goto this frame. */
  protected debugLastDesiredSpeed: number = 0;

  /** Internal: snapshot of distance from actor to follow point this frame. */
  protected debugLastDistToFollow: number = 0;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);

    this.actorTransform = this.getEntity().getComponent(TransformComponent);

    const currentPos = this.actorTransform?.worldPosition ?? new Vec3(0, 0, 0);
    this.gotoBehavior = new GotoBehavior();
    this.gotoBehavior.basePriority = this.basePriority;
    this.gotoBehavior.desiredSpeed = this.followSpeed;
    this.gotoBehavior.targetPosition = currentPos;
    this.gotoBehavior.repathInterval = this.repathInterval;
    this.gotoBehavior.distanceToStop = this.distanceToStop;
    // Follower reassigns the target every frame; repath on the interval only.
    this.gotoBehavior.repathOnTargetChange = false;
    // FollowBehavior owns body direction (see updateBodyDirection); the nested
    // goto must not also claim the body-direction controller and fight it.
    this.gotoBehavior.shouldFaceDirection = false;
    this.gotoBehavior.initialize(this.behaviorManager!);
  }

  override update(deltaTime: number): void {
    if (!this.gotoBehavior || !this.actorTransform) {
      return;
    }

    const targetPos = this.resolveTargetPosition(deltaTime);
    if (targetPos === null) {
      return;
    }

    this.followTarget(targetPos, deltaTime);
  }

  /**
   * Decides *what* to follow this frame and returns its world position.
   *
   * - Composite mode (`targetInfo` set): reads `predictedPosition` from the
   *   shared TargetInfo (smoothed position projected forward by
   *   `velocityPredictionTime`). When the parent's `velocityPredictionTime`
   *   is 0, this equals `smoothedPosition`.
   * - Standalone mode (`targetInfo` null): reads `worldPosition` from
   *   `targetEntity`. When `followPlayer` is true, the closest player is
   *   resolved into `targetEntity` first.
   *
   * Returns null when no valid target is available this frame.
   */
  protected resolveTargetPosition(_deltaTime: number): Vec3 | null {
    if (this.targetInfo) {
      return this.targetInfo.isValid ? this.targetInfo.predictedPosition : null;
    }

    if (this.followPlayer) {
      this.resolvePlayerTarget(_deltaTime);
    }

    if (!this.targetEntity || this.targetEntity.isDestroyed()) {
      return null;
    }

    const targetTransform = this.targetEntity.getComponent(TransformComponent);
    return targetTransform ? targetTransform.worldPosition : null;
  }

  /**
   * Decides *how* to follow: navigates to the target's actual position via
   * the NavMesh (routing around walls) and stops `followRange` short of the
   * target measured ALONG THE PATH. Mode-agnostic.
   *
   * Precondition: `gotoBehavior` and `actorTransform` are non-null
   * (verified by `update()`).
   */
  protected followTarget(targetPos: Vec3, deltaTime: number): void {
    const actorPos = this.actorTransform!.worldPosition;

    // Along-path distance to the standoff point: remaining route length minus
    // `followRange` (0 once within `followRange` of the target). Drives the
    // motion state machine and the arrival speed ramp.
    // Note: pre-first-repath getRemainingPathLength() is 0 (empty path), so
    // distToFollow is 0 and a hysteresis follower may settle for the first
    // spawn frame; benign — movement is gated on pathReady and it self-corrects
    // once a path exists.
    const remainingPathLength = this.gotoBehavior!.getRemainingPathLength();
    const distToFollow = Math.max(0, remainingPathLength - this.followRange);

    // Target XZ speed — gates settled entry only (a slow-but-moving target
    // shouldn't briefly settle each cycle); speed itself is distance-derived.
    let targetSpeedXZ = 0;
    if (this.targetInfo && this.targetInfo.isValid) {
      const sv = this.targetInfo.smoothedVelocity;
      targetSpeedXZ = Math.sqrt(sv.x * sv.x + sv.z * sv.z);
    }
    const isTargetMoving = targetSpeedXZ > this.targetMovingThreshold;

    // Drive the hysteresis state machine (decides pursue vs. park)
    this.updateMotionState(actorPos, deltaTime, distToFollow, isTargetMoving);

    // Update body direction (always — even when settled). Runs after the
    // motion state is resolved so faceMovement can gate its release on the
    // same settled state the motion machine uses this frame.
    this.updateBodyDirection(actorPos, targetPos);

    // Keep goto aimed at the target even when settled; retargeting actorPos
    // zeroes getRemainingPathLength() and traps the actor in `settled`.
    this.gotoBehavior!.targetPosition = targetPos;
    const computedDesiredSpeed =
      this.motionState === 'settled' ? 0 : this.computePursuitSpeed(distToFollow);
    this.gotoBehavior!.desiredSpeed = computedDesiredSpeed;
    this.gotoBehavior!.update(deltaTime);

    // Snapshot for debug, then push a frame entry into the rolling log.
    this.debugLastDistToFollow = distToFollow;
    this.debugLastDesiredSpeed = computedDesiredSpeed;
    this.updateDebugText();

    this.renderDebug();
  }

  /**
   * Pushes a frame entry into the rolling debug log and writes the log
   * to the configured `WorldTextComponent` on `debugTextEntity`. No-ops
   * cheaply when no debug entity is configured.
   *
   * Line format: `#<frame> <state> v=<desiredSpeed> d=<distToFollow>`
   * Example:    `#1247 pursuing v=2.43 d=0.85`
   */
  protected updateDebugText(): void {
    if (!this.debugTextEntity || this.debugTextEntity.isDestroyed()) {
      return;
    }

    this.debugFrameCounter++;
    const line =
      `#${this.debugFrameCounter} ${this.motionState} ` +
      `v=${this.debugLastDesiredSpeed.toFixed(2)} ` +
      `d=${this.debugLastDistToFollow.toFixed(2)}`;
    this.debugLog.push(line);
    while (this.debugLog.length > this.debugMaxFrames) {
      this.debugLog.shift();
    }

    const textComp = this.debugTextEntity.getComponent(WorldTextComponent);
    if (textComp) {
      textComp.text = this.debugLog.join('\n');
    }
  }

  /**
   * Hysteresis state machine. Reads `hysteresisRadius` and
   * `targetMovingThreshold` every frame so they can change dynamically.
   *
   * `distToFollow` is the remaining NavMesh path distance to the follow
   * point (not straight-line), so a follow point behind a wall keeps the
   * actor pursuing until it has detoured around the obstacle.
   *
   * - `pursuing → settled` when inside hysteresis AND (arrived at center
   *   within `distanceToStop`, or stuck-but-close fallback fires, or the
   *   hard-stuck escape fires) AND the target is essentially still. While the
   *   target is moving the actor stays in `pursuing` and arrival deceleration
   *   self-equilibrates the actor at an offset behind the follow point — no
   *   settle, no cycle.
   * - `settled → pursuing` when the actor falls outside the hysteresis
   *   radius, or when it is beyond `stuckSettleMaxDistance` without having
   *   arrived within `distanceToStop`. A moving target whose follow point
   *   still sits inside the soft zone is intentionally ignored so small
   *   player movements do not wake a parked actor.
   *
   * The arrival exemption on the second bullet is load-bearing: it keeps the
   * exit edge from being stricter than the entry edge, which would flap the
   * state every frame for any caller whose gate is below `distanceToStop`.
   *
   * `hysteresisRadius <= 0` disables the soft zone: full-speed pursuit that
   * still settles once the actor arrives at the follow point (within
   * `distanceToStop`), so `followRange` is honored.
   */
  /**
   * Clears every accumulator and latch the stuck/settle machinery owns.
   *
   * Extracted so the reset sites cannot drift apart: each previously cleared
   * its own subset, and the `hysteresisRadius <= 0` early return cleared only
   * `stuckTimer` — leaving `settledOutOfZone` latched, so re-enabling
   * hysteresis resumed in a park the actor could not leave.
   *
   * `consecutiveParks` is cleared here too, and the `settledOutOfZone` retry
   * release in `updateMotionState()` carries it across this call: the backoff
   * must survive a retry to accumulate at all. A future field with that same
   * retry-surviving property needs BOTH halves of that treatment — carried
   * across this call there, and cleared on the gate-reached edge — or it
   * accumulates for as long as the actor stays inside hysteresis.
   */
  protected resetStuckState(): void {
    this.stuckTimer = 0;
    this.settledOutOfZone = false;
    this.settleExitDebounceTimer = 0;
    this.pursuingOutOfRangeTimer = 0;
    this.parkedRetryTimer = 0;
    this.consecutiveParks = 0;
  }

  protected updateMotionState(
    actorPos: Vec3,
    deltaTime: number,
    distToFollow: number,
    isTargetMoving: boolean,
  ): void {
    // Every numeric this state machine reads is a public field an author can
    // set to anything, and `deltaTime` feeds an accumulator. Sanitize once,
    // here, and use the local copies below.
    //
    // A non-finite `deltaTime` would make `stuckTimer` NaN, and every
    // `NaN >= threshold` comparison is false — so the actor would never settle
    // via the fallback again, for its whole lifetime.
    const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    // Non-finite or negative reads as 0, which is exactly what an author-set 0
    // already means (fallback disabled).
    const settleTime =
      Number.isFinite(this.stuckSettleTime) && this.stuckSettleTime > 0
        ? this.stuckSettleTime
        : 0;

    if (this.hysteresisRadius <= 0) {
      // No soft zone: pursuit aims goto at the target itself, so settle at the
      // follow point (followRange out) instead of walking all the way in.
      this.motionState =
        distToFollow <= this.distanceToStop ? 'settled' : 'pursuing';
      // Route through the helper rather than clearing `stuckTimer` alone.
      // Disabling hysteresis mid-engagement previously left `settledOutOfZone`
      // latched, so a subsequent re-enable resumed in a hard-stuck park the
      // actor could not leave.
      this.resetStuckState();
      this.prevActorPos = actorPos;
      return;
    }

    const inHysteresis = distToFollow <= this.hysteresisRadius;
    const arrivedAtCenter = distToFollow <= this.distanceToStop;

    // Stuck detection: actual XZ speed of the actor over the last frame.
    if (this.prevActorPos !== null && dt > 0) {
      const adx = actorPos.x - this.prevActorPos.x;
      const adz = actorPos.z - this.prevActorPos.z;
      const actualSpeed = Math.sqrt(adx * adx + adz * adz) / dt;
      if (actualSpeed < this.stuckSpeedThreshold) {
        this.stuckTimer += dt;
      } else {
        this.stuckTimer = 0;
      }
    }
    this.prevActorPos = actorPos;

    const stuckFallback = settleTime > 0 && this.stuckTimer >= settleTime;
    // Gate the stuck fallback on proximity to the follow point. A stuck actor
    // only parks when it is within `stuckSettleMaxDistance` of the goal;
    // stuck-but-still-far (e.g. jostled just outside an attack band) keeps
    // pursuing so it can re-close once the blockage clears. Default Infinity
    // keeps the legacy "settle anywhere inside hysteresis" behavior.
    // ONLY a positive value is a gate. 0 (the zero-init case a `@property`
    // template instance gets), negatives and NaN all read as the `Infinity`
    // default — each would otherwise make every `distToFollow <= gate` test
    // false and DELETE the fallback rather than narrow it. A genuine
    // `Infinity` is honoured: "do not narrow" is coherent and equals
    // pre-change behaviour.
    // `Infinity` itself is not finite, so it takes the same branch as the bad
    // values and yields `Infinity` — which is exactly what it means.
    const settleGate =
      Number.isFinite(this.stuckSettleMaxDistance) &&
      this.stuckSettleMaxDistance > 0
        ? this.stuckSettleMaxDistance
        : Number.POSITIVE_INFINITY;
    const withinStuckSettleZone = distToFollow <= settleGate;
    const forcedSettle = inHysteresis && stuckFallback && withinStuckSettleZone;
    // Hard-stuck escape: bounds the pursue-repath loop for a permanently
    // unreachable follow point, which gating `forcedSettle` would otherwise
    // leave with no quiescence path at all. See `stuckSettleHardMultiplier`.
    // Clamped on BOTH sides, because the two failure modes are symmetric:
    // below 1 the escape fires before the normal fallback and defeats the gate,
    // while a large value deletes the escape entirely — and a large FINITE
    // value (1e9) does that just as effectively as `Infinity`, so a
    // `Number.isFinite` guard alone closes one door and leaves the other open.
    // Any non-finite value reads as the floor of 1. Note the deliberate
    // contrast with `settleGate` above: there `Infinity` is the SAFE state,
    // here it is the unsafe one.
    const hardMultiplier = Number.isFinite(this.stuckSettleHardMultiplier)
      ? Math.min(
          Math.max(this.stuckSettleHardMultiplier, 1),
          MAX_HARD_STUCK_MULTIPLIER,
        )
      : 1;
    // Held beyond the gate, with the target essentially still. `!isTargetMoving`
    // is part of the ENTRY condition, not just of the settle: arrival
    // deceleration deliberately holds a chasing actor at an equilibrium offset
    // behind the follow point (`hysteresisRadius * targetSpeed / followSpeed`),
    // which exceeds a combat-derived gate for any target above ~1.5 m/s at the
    // shipped defaults. Without this term a healthy pace-matching chase — the
    // DEFAULT case, not a corner case — arms the escape for its whole duration
    // and parks the actor the first frame the target stops.
    const heldOutOfRange =
      inHysteresis && !withinStuckSettleZone && !arrivedAtCenter && !isTargetMoving;
    // Reaching the gate clears the backoff in EITHER motion state, so a
    // transient jam cannot lengthen the park for an unrelated later one.
    if (withinStuckSettleZone || arrivedAtCenter) {
      this.consecutiveParks = 0;
    }
    if (this.motionState === 'pursuing') {
      if (heldOutOfRange) {
        this.pursuingOutOfRangeTimer += dt;
      } else {
        // Decay, not reset — same reason as the settled-exit edge. A hard reset
        // lets an actor that dips inside the gate one frame in five hold the
        // timer at zero, and since `forcedSettle` is already gated off for such
        // an actor that leaves it with NO quiescence path at all.
        this.pursuingOutOfRangeTimer = Math.max(
          0,
          this.pursuingOutOfRangeTimer - dt * GATE_TIMER_DECAY_RATE,
        );
      }
    }
    const hardStuck =
      settleTime > 0 &&
      this.pursuingOutOfRangeTimer >= settleTime * hardMultiplier;

    if (this.motionState === 'pursuing') {
      // Only park when the target is essentially still. While the target
      // is moving, pace matching handles things smoothly inside pursuing
      // (entering settled here would cause stop-go cycles).
      if (
        inHysteresis &&
        (arrivedAtCenter || forcedSettle || hardStuck) &&
        !isTargetMoving
      ) {
        this.motionState = 'settled';
        // Spend the debounce charge at the single ENTRY site rather than at
        // each of the ways out: exits are easy to add and forget.
        this.settleExitDebounceTimer = 0;
        // Only a hard-stuck park is out-of-zone: arrival and `forcedSettle`
        // both imply the actor is somewhere the settled branch will hold it.
        this.settledOutOfZone =
          !arrivedAtCenter && !withinStuckSettleZone && hardStuck;
        // Spend the entry charge at the single ENTRY site. The timer is frozen
        // while settled (only the pursuing branch above touches it), so a
        // charge carried across the settled state would trip the escape within
        // a frame or two of the actor next being evicted and park it straight
        // back out of range, instead of granting a full pursue window.
        this.pursuingOutOfRangeTimer = 0;
        if (this.settledOutOfZone) {
          // Start the park clock. The retry release below waits a full
          // interval rather than firing immediately.
          this.parkedRetryTimer = 0;
          this.consecutiveParks = Math.min(
            this.consecutiveParks + 1,
            MAX_PARK_BACKOFF,
          );
        }
      }
    } else {
      // settled — exit on hysteresis exit, OR when the actor is pushed back
      // out past `stuckSettleMaxDistance` (jostled beyond the settle zone).
      // The second clause mirrors the pursuing-side gate: a combat actor that
      // settled in-band and is then bumped outside its attack range must
      // resume pursuing to re-close, not stay parked out of range — the same
      // failure this change targets, reached via settle-then-jostle instead of
      // stall-then-settle. Default Infinity `stuckSettleMaxDistance` makes the
      // second clause a no-op, preserving the legacy "exit only on hysteresis
      // exit" behavior for non-combat followers. A moving target whose follow
      // point still sits inside both zones is intentionally ignored: we wait
      // for it to walk far enough that the follow point escapes the soft zone.
      //
      // `arrivedAtCenter` exempts the zone clause so this edge can never be
      // STRICTER than the pursuing-side entry edge: the actor physically parks
      // anywhere within `distanceToStop`, so a caller whose gate is tighter
      // than that would otherwise settle on arrival and be evicted on the very
      // next frame, flapping at tick rate forever. `EngageCombatBehavior`
      // floors its derived gate at `distanceToStop` for the same reason; this
      // clause makes the state machine robust to any caller that does not.
      if (!inHysteresis) {
        this.motionState = 'pursuing';
        this.resetStuckState();
      } else if (this.settledOutOfZone) {
        // Parked by the hard-stuck escape. Wake either when the actor is back
        // inside its gate (the blockage cleared and something moved it), or
        // after the park interval elapses.
        //
        // The park is the SHORT half of the duty cycle on purpose: a parked
        // actor cannot shorten its own path, so a crowd that clears is only
        // noticed on the retry — which makes the park duration the worst-case
        // added attack latency in exactly the case this exists to fix.
        //
        // Driven by its own timer, not `stuckTimer`: `stuckTimer` resets on any
        // frame above `stuckSpeedThreshold`, so an actor shoved by a crowd
        // while parked would never satisfy it and would stay parked forever.
        this.parkedRetryTimer += dt;
        // Backed off over consecutive failed retries, but capped as a FRACTION
        // of the pursue window so the park can never grow to match or exceed
        // it. The step cap alone does not hold that: at the multiplier clamp
        // floor of 1 a step-capped park equals the pursue window exactly.
        const parkInterval = Math.min(
          settleTime * Math.max(1, this.consecutiveParks),
          settleTime * hardMultiplier * MAX_PARK_FRACTION_OF_PURSUE,
        );
        if (
          withinStuckSettleZone ||
          arrivedAtCenter ||
          this.parkedRetryTimer >= parkInterval
        ) {
          this.motionState = 'pursuing';
          // Carried across the helper's clear: the backoff must survive a retry
          // or it can never accumulate, which would make the park interval fixed.
          const backoff = this.consecutiveParks;
          this.resetStuckState();
          this.consecutiveParks = backoff;
        }
      } else if (!withinStuckSettleZone && !arrivedAtCenter) {
        // DEBOUNCED, not instantaneous. Once `EngageCombatBehavior`'s derived
        // gate equals `distanceToStop` — which it does at every band where the
        // outer inset binds, since both come from `getArrivalTolerance()` —
        // settle-entry (`<= gate`) and this exit (`> gate`) sit on ONE shared
        // threshold, and contact jitter alone would flap `desiredSpeed`
        // between 0 and full pursuit at tick rate. That is worse than the
        // out-of-range parking this clause exists to fix, and it would also
        // zero `stuckTimer` on every flip.
        // The interval is clamped on BOTH sides. `settleTime` derives from the
        // author-settable `stuckSettleTime`, which is sanitized only against
        // non-finite/non-positive values, so a large FINITE value (30s) would
        // hold a jostled actor in `settled` for that whole interval and
        // re-create the out-of-range parking this clause exists to fix —
        // exactly the asymmetry `MAX_HARD_STUCK_MULTIPLIER` above exists to
        // close. This bounds THIS edge only; the `settledOutOfZone` park above
        // has its own interval and its own bound.
        // Floor applied LAST, so it wins if the two constants ever cross. The
        // opposite order lets a ceiling below the floor delete the floor for
        // every caller, and the flap that guards against is the worse failure
        // of the two (see above). Identical at the shipped constants.
        this.settleExitDebounceTimer += dt;
        if (
          this.settleExitDebounceTimer >=
          Math.max(
            Math.min(settleTime, MAX_SETTLE_EXIT_DEBOUNCE_S),
            MIN_SETTLE_EXIT_DEBOUNCE_S,
          )
        ) {
          this.motionState = 'pursuing';
          this.resetStuckState();
        }
      } else {
        // Back on the favourable side: DECAY the charge rather than clearing
        // it. A hard reset here lets an actor oscillating across the gate zero
        // the timer every other frame and stay parked out of range forever.
        this.settleExitDebounceTimer = Math.max(
          0,
          this.settleExitDebounceTimer - dt * GATE_TIMER_DECAY_RATE,
        );
      }
    }
  }

  /**
   * Arrival-style pursuit speed (Reynolds steering).
   *
   * `desiredSpeed = followSpeed * clamp(distToFollow / hysteresisRadius, 0, 1)`
   *
   * `distToFollow` here is the remaining NavMesh path distance (see
   * `GotoBehavior.getRemainingPathLength`), so deceleration ramps down over
   * the actual route rather than the straight-line gap.
   *
   * - At or beyond `hysteresisRadius`: full `followSpeed` (max chase).
   * - Inside the zone: linearly ramps to 0 at the follow-point center.
   *
   * Depends only on distance — no target-velocity input — so there is
   * no transient when the target's smoothed velocity is mid-decay. When
   * the target moves at a steady speed the actor self-equilibrates at an
   * offset behind the follow point (offset ≈ `hysteresisRadius *
   * targetSpeed / followSpeed`), automatically pace-matching without any
   * explicit pace-match formula.
   *
   * `hysteresisRadius <= 0` disables arrival deceleration entirely —
   * pursuit always uses `followSpeed`.
   */
  protected computePursuitSpeed(distToFollow: number): number {
    if (this.hysteresisRadius <= 0) {
      return this.followSpeed;
    }
    const t = Math.min(1, distToFollow / this.hysteresisRadius);
    return this.followSpeed * t;
  }

  /**
   * Updates the actor's body direction based on bodyDirectionMode.
   *   faceTarget:   actor faces toward the target entity
   *   faceMovement: actor faces its travel heading (toward its path waypoint)
   *   matchTarget:  actor faces the same direction as the target entity
   *   none:         body direction is left uncontrolled (facing held)
   */
  protected updateBodyDirection(actorPos: Vec3, targetPos: Vec3): void {
    if (this.bodyDirectionMode === 'none') {
      this.desiredBodyDirection = null;
      return;
    }

    if (this.bodyDirectionMode === 'faceMovement') {
      // Face the current path waypoint (target as pre-path fallback) so facing
      // follows the route around corners instead of pointing through a wall.
      // Gate release on the settled state — not a separate distance test — so
      // facing and motion agree at the arrival boundary; the magnitude guard
      // skips a degenerate heading when the actor sits on the waypoint.
      const movePoint = this.gotoBehavior?.getCurrentWaypoint() ?? targetPos;
      const toMove = movePoint.sub(actorPos);
      const moveXZ = new Vec3(toMove.x, 0, toMove.z);
      if (this.motionState !== 'settled' && moveXZ.magnitude() > this.distanceToStop) {
        this.desiredBodyDirection = moveXZ.normalize();
      } else {
        this.desiredBodyDirection = null;
      }
      return;
    }

    if (this.bodyDirectionMode === 'matchTarget') {
      const entity = this.targetInfo?.targetEntity ?? this.targetEntity;
      if (!entity || entity.isDestroyed()) return;
      const transform = entity.getComponent(TransformComponent);
      if (!transform) return;
      const forward = transform.worldRotation.mulVec3(Vec3.forward);
      const forwardXZ = new Vec3(forward.x, 0, forward.z);
      if (forwardXZ.magnitude() > 0.001) {
        this.desiredBodyDirection = forwardXZ.normalize();
      }
      return;
    }

    // faceTarget (default)
    const toTarget = targetPos.sub(actorPos);
    const directionXZ = new Vec3(toTarget.x, 0, toTarget.z);
    if (directionXZ.magnitude() > 0.001) {
      this.desiredBodyDirection = directionXZ.normalize();
    }
  }

  /**
   * Renders debug visualization. Override to add custom debug rendering.
   */
  protected renderDebug(): void {
    // No-op by default
  }

  /**
   * Searches for the closest player and sets it as targetEntity.
   * Called every frame in followPlayer mode but only performs the actual
   * PlayerService query at playerSearchInterval intervals (or immediately
   * when there is no valid target).
   */
  protected resolvePlayerTarget(deltaTime: number): void {
    const needsTarget = !this.targetEntity || this.targetEntity.isDestroyed();

    // Same sanitization as the motion accumulators: one non-finite frame makes
    // `NaN < interval` false forever, so the O(players) scan would run every
    // frame for the rest of the actor's life.
    this.playerSearchTimer +=
      Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    if (!needsTarget && this.playerSearchTimer < this.playerSearchInterval) {
      return;
    }
    this.playerSearchTimer = 0;

    const actorPos = this.actorTransform!.worldPosition;
    const players = PlayerService.get().getAllPlayers();

    let nearestPlayer: Entity | null = null;
    let nearestDistance = Infinity;

    for (const playerEntity of players) {
      if (!playerEntity || !playerEntity.valid) continue;

      const playerTransform = playerEntity.getComponent(TransformComponent);
      if (!playerTransform) continue;

      const distance = actorPos.distance(playerTransform.worldPosition);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPlayer = playerEntity;
      }
    }

    if (nearestPlayer) {
      this.targetEntity = nearestPlayer;
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    const hasTarget = this.targetInfo
      ? this.targetInfo.isValid
      : (this.targetEntity && !this.targetEntity.isDestroyed());

    if (!hasTarget || !this.gotoBehavior) {
      return super.getControllerUsePriority(controllerType);
    }

    if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredBodyDirection) {
      return this.basePriority;
    }

    return this.gotoBehavior.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredBodyDirection) {
      (controller as ActorBodyDirectionController).rotateBodyTo(
        new ActorBodyDirectionParams(this.desiredBodyDirection, this.bodyDirectionAngularSpeed),
      );
    }

    if (this.gotoBehavior) {
      this.gotoBehavior.useController(controllerType, controller);
    }
  }
}
