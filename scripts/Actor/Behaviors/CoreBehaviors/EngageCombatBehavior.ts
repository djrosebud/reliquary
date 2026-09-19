/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v3

import {
  TransformComponent, type Entity, ColliderCapsuleComponent, ColliderSphereComponent,
  ColliderBoxComponent, ColliderConvexMeshComponent, ColliderMeshComponent,
  MeshComponent, EntityService, NavMeshComponent, PhysicsBodyComponent,
  PhysicsBodyType, Vec3,
} from 'meta/worlds';
import type { ActorBehaviorManager } from 'meta/worlds';
import { AttackEntityInRangeBehavior } from './AttackEntityInRangeBehavior';
import { CompositeBehavior } from '../CompositeBehavior';
import { FollowTaggedEntityBehavior } from '../../Tagging/FollowTaggedEntityBehavior';
import type { FollowRuntimeRanges } from '../../Tagging/FollowTaggedEntityBehavior';

// PROTOTYPE (direction-aware footprint): snap tolerance for the navmesh reach
// probes — absorbs float error when the query snaps the actor origin / target
// pivot to the nearest navmesh polygon. NOT a search budget.
const NAVMESH_SNAP_TOLERANCE_M = 2;

// PROTOTYPE: slack (m) allowed when validating that a navmesh raycast hit is
// the target's own wall and not an intervening obstacle. The hit point must sit
// within (staticReach + this) of the pivot AND yield a reach no larger than
// (staticReach + this); staticReach is the Chebyshev outer bound, so anything
// past it is not the target. Keeps a bad hit from parking the actor short.
const DIRECTIONAL_REACH_SANITY_TOL_M = 1.0;

/**
 * A footprint measurement, and whether a 0 radius is the ANSWER.
 *
 * The cached getters clear their memo on a 0 rather than storing it, because a
 * mesh collider reports 0 until its asset streams in and freezing that would
 * leave an attacker measuring to a building's interior pivot for the rest of
 * the encounter. That reasoning does not reach a 0 produced by excluding
 * triggers: an entity whose only collider is a sensor has no footprint and
 * never will, so re-deriving it every frame buys nothing and costs three
 * recursive hierarchy descents plus a mesh-AABB union per frame.
 */
type FootprintXZ = {radius: number; zeroIsFinal: boolean};

// Depth cap for the collider -> owning-PhysicsBody walk. Guards a cyclic or
// pathological parent chain; matches the caps the Interaction scripts use.
const PHYSICS_BODY_WALK_MAX_DEPTH = 32;

// Time constant (s) for the vertical-gap low-pass. The gap sizes the settle
// gate, so it must not track animation: a target jumping in place would
// otherwise modulate the threshold at hop frequency.
const VERTICAL_GAP_SMOOTHING_TIME_CONSTANT_S = 0.4;

/**
 * Compound combat behavior that wraps FollowTaggedEntityBehavior and
 * AttackEntityInRangeBehavior with a detection range gate.
 *
 * All distance parameters use **surface-to-surface** semantics —
 * the framework reads each actor's collider radius automatically, so
 * authors never need to account for body size. Set {@link maxAttackDistance}
 * to the weapon's reach (e.g. 0 = bite, 0.3 = sword, 1.0 = spear,
 * 10 = bow) and the composite derives all internal follow/attack/
 * hysteresis values so the NPC is guaranteed to park inside its own
 * attack band.
 *
 * Extends CompositeBehavior so that sub-behavior controller routing
 * is handled automatically — the attack behavior (higher internal
 * priority) wins the movement controller when in range, stopping
 * the actor from moving while attacking.
 *
 * Target acquisition is handled by {@link FollowTaggedEntityBehavior},
 * which resolves the closest entity matching {@link targetTags} from the
 * ActorTaggingBlackboard. The resolved target is automatically synced
 * to the attack behavior each frame.
 *
 * Use {@link ActorSdkTagPlayerService} to auto-tag players with "player",
 * and {@link ActorSdkTagComponent} to tag other entities.
 */
export class EngageCombatBehavior extends CompositeBehavior {
  override name: string = 'EngageCombatBehavior';

  /**
   * The tags to target (e.g. ["player"], ["player", "enemy"]).
   *
   * ⚠️ Consumer half only. Non-player targets must ALSO carry a matching
   * `ActorSdkTagComponent` tag (same case-sensitive string) or none is acquired.
   */
  targetTags: string[] = ['player'];

  /**
   * Maximum surface-to-surface distance (meters) at which the actor can
   * attack. This is the weapon's reach — the framework adds both actors'
   * collider radii automatically.
   *
   * Examples: 0 = bite/unarmed, 0.3 = sword, 1.0 = spear, 10 = bow.
   */
  maxAttackDistance: number = 1.5;

  /**
   * Minimum surface-to-surface distance (meters) at which the actor can
   * attack. Creates a dead zone when the target is too close (e.g. for
   * ranged NPCs that should flee or switch to melee when crowded).
   * Default 0 (no dead zone).
   */
  minAttackDistance: number = 0;

  /**
   * Preferred surface-to-surface distance (meters) the NPC closes to before it
   *
   * settles. Clamped at runtime to sit one arrival tolerance INSIDE the band
   * edges rather than on one, because the actor parks anywhere within one
   * tolerance of the follow point and a follow point ON an edge puts half that
   * spread outside the band. On the shipped band a kiter requesting the outer
   * edge therefore parks at 1.32 m rather than 1.5 m. The inner inset applies
   * only to a real dead zone (`minAttackDistance > 0`), and a band too
   * degenerate to hold the insets falls back to the band midpoint.
   *
   * {@link getPreferredStandDistance} is the single source of truth for the
   * exact bounds and for which regime a given band lands in — do not restate
   * its conditions here, or the two drift.
   *
   * Default `0` presses to the INNER band edge: a melee actor drives up to the
   * target's collider surface (or to one arrival tolerance outside
   * `minAttackDistance` for a dead-zone weapon)
   * instead of hanging back at the outer edge. This is a COMBAT knob, distinct
   * from a companion follow-distance — in melee you close the distance, you do
   * not trail the target by a fixed gap. Set a positive value only for a kiter
   * that should deliberately hold range inside the band (e.g. a ranged NPC).
   * A `@property`-driven template instance zero-inits this to `0`, which now
   * MATCHES the intended press-in default — no explicit set required.
   */
  preferredAttackDistance: number = 0;

  /**
   * Maximum surface-to-surface distance (meters) at which the actor acquires
   * and retains a target. A positive value ignores targets beyond it (a
   * dormant enemy that wakes only when a target comes within range).
   *
   * `<= 0` means UNLIMITED: the actor acquires the nearest tagged target at any
   * distance and hunts it from wherever it spawns. That is the default, and it
   * matches `ActorCombatStarterComponent`: an enemy dropped away from its target
   * (e.g. a spawner that scatters enemies across an arena) never sees the target
   * under a finite range and idles at its spawn point. Note `@property`-driven
   * template instances zero-init this field, so an unset combat template is
   * unlimited too.
   */
  engagementRange: number = 0;

  /** Movement speed in meters per second when following a target. */
  followSpeed: number = 5.0;

  /** Damage value passed to the attack controller. */
  attackDamage: number = 1;

  /** Minimum time in seconds between attacks. */
  attackFrequency: number = 1.0;

  protected followTaggedBehavior: FollowTaggedEntityBehavior | null = null;
  protected attackBehavior: AttackEntityInRangeBehavior | null = null;

  private pursuitStallTimer: number = 0;
  private hasWarnedStall: boolean = false;
  // Latches the per-frame attack-band validation warning; see
  // `sanitizeAttackBand`. Self-healing is idempotent, so without this the
  // error would re-fire every frame for the actor's lifetime.
  private hasWarnedAttackBand: boolean = false;

  // Per-frame geometry, resolved once by `updateFrameGeometry()`. Read by BOTH
  // `updatePursuitStallWarning()` and `updateDerivedRanges()`, the latter to
  // project the follow point and the settle gate onto the horizontal — which is
  // why the resolve is not gated on the stall latch: see `update()`.
  //
  // The vertical gap is low-passed because it feeds a distance threshold: an
  // unsmoothed per-frame read would let a target jumping in place modulate the
  // gate at animation frequency. `verticalGapSeeded` makes the FIRST reading
  // for a target seed the filter outright instead of ramping from the zero
  // initializer — ramping spends the first ~1-2 s deriving against a gap the
  // code already knows is wrong.
  private smoothedVerticalGap: number = 0;
  private verticalGapSeeded: boolean = false;
  private frameDistXZ: number = 0;
  private frameGeometryValid: boolean = false;

  // Held and mutated rather than re-allocated: `updateDerivedRanges` runs every
  // frame for every combat actor, and a fresh literal there is a per-frame
  // allocation (`no-allocation-in-update-loop`). The callee copies the values
  // out synchronously and retains no reference, so reuse is safe.
  private readonly runtimeRanges: FollowRuntimeRanges = {
    followRange: 0,
    maxRange: 0,
    hysteresisRadius: 0,
    distanceToStop: 0,
    stuckSettleMaxDistance: undefined,
  };

  // Cached footprints. Recomputed lazily; auto-invalidated on target swap
  // and on world XZ-scale change of the relevant entity (root scale only).
  // Authors call `invalidateFootprintCache()` explicitly for rig swap,
  // equipment change, or child-collider scale animations that the root-scale
  // probe cannot see. Steady state: 0 footprint recomputes per frame.
  // `null` scale sentinel forces first-call recompute and remains null
  // when the entity lacks a TransformComponent — `NaN === NaN` is false,
  // which would otherwise defeat the cache every frame.
  private selfFootprintXZ: number | null = null;
  private selfScaleAtCache: number | null = null;
  private targetFootprintXZ: number | null = null;
  private targetScaleAtCache: number | null = null;
  private cachedTarget: Entity | null = null;

  // PROTOTYPE (direction-aware footprint). Lazily-resolved navmesh entity,
  // mirroring ActorSpawner.resolveNavMeshComponent(). The direction-aware reach
  // measured last frame (pivot -> near wall along the approach ray), shared with
  // updatePursuitStallWarning so it does not re-raycast. And a throttle key so
  // the temporary per-frame reach logging only fires on transitions.
  private cachedNavMeshEntity: Entity | null = null;
  private lastTargetReach: number = 0;
  private lastReachLogKey: string = '';

  /**
   * Updates the follow speed at runtime - called by debuff systems (e.g. slow perk effects)
   * to apply speed modifiers to the live behavior. Propagates to FollowTaggedEntityBehavior
   * immediately so the enemy slows down this frame.
   */
  public setFollowSpeed(speed: number): void {
    this.followSpeed = speed;
    if (this.followTaggedBehavior) {
      this.followTaggedBehavior.setFollowSpeed(speed);
    }
  }

  /**
   * Sets or clears a forced target override. When set, the enemy ignores the
   * normal closest-tagged-entity resolution and exclusively targets the given
   * entity. Pass null to revert to default targeting.
   */
  setTargetOverride(entity: Entity | null): void {
    if (this.followTaggedBehavior) {
      this.followTaggedBehavior.setTargetOverride(entity);
    }
  }

  override initialize(behaviorManager: ActorBehaviorManager): void {
    if (this.minAttackDistance > this.maxAttackDistance) {
      console.error(
        `[EngageCombat] minAttackDistance (${this.minAttackDistance}) > maxAttackDistance ` +
        `(${this.maxAttackDistance}) — creates an impossible attack band. ` +
        `Swapping values.`,
      );
      const tmp = this.minAttackDistance;
      this.minAttackDistance = this.maxAttackDistance;
      this.maxAttackDistance = tmp;
    }

    // A positive engagementRange must cover the attack band, otherwise the
    // actor drops the target before it can attack (target-acquire/drop
    // oscillation). `<= 0` is the "unlimited" sentinel — an unlimited actor
    // never drops a target for range, so oscillation is impossible and the
    // floor does not apply.
    if (this.engagementRange > 0 && this.engagementRange < this.maxAttackDistance) {
      console.error(
        `[EngageCombat] engagementRange (${this.engagementRange}) < maxAttackDistance ` +
        `(${this.maxAttackDistance}) — actor will lose its target while still in attack range. ` +
        `Clamping engagementRange to maxAttackDistance.`,
      );
      this.engagementRange = this.maxAttackDistance;
    }

    const standDist = this.getPreferredStandDistance();
    const bandW = this.maxAttackDistance - this.minAttackDistance;

    this.followTaggedBehavior = new FollowTaggedEntityBehavior();
    this.followTaggedBehavior.basePriority = 1;
    this.followTaggedBehavior.targetTags = this.targetTags;
    // 0 passes through to FollowTaggedEntityBehavior as "no range gate"
    // (unlimited acquisition). updateDerivedRanges() re-derives this each frame.
    this.followTaggedBehavior.maxRange = this.engagementRange > 0 ? this.engagementRange : 0;
    this.followTaggedBehavior.followSpeed = this.followSpeed;
    this.followTaggedBehavior.followRange = standDist;
    this.followTaggedBehavior.hysteresisRadius = Math.max(0.15, bandW * 0.4);
    this.followTaggedBehavior.distanceToStop = this.getArrivalTolerance();

    this.attackBehavior = new AttackEntityInRangeBehavior();
    this.attackBehavior.basePriority = 2;
    this.attackBehavior.minAttackDistance = this.minAttackDistance;
    this.attackBehavior.maxAttackDistance = this.maxAttackDistance;
    this.attackBehavior.damage = this.attackDamage;
    this.attackBehavior.attackFrequency = this.attackFrequency;

    this.subBehaviors = [this.followTaggedBehavior, this.attackBehavior];

    // CompositeBehavior.initialize() calls initialize on all sub-behaviors
    super.initialize(behaviorManager);

    // Replace the surface-to-surface seeding above with derived
    // center-to-center values so the first frame is consistent with the
    // steady state. Self footprint is computed once here and cached;
    // target footprint is 0 (no target yet) and the next update() will
    // populate it on acquisition.
    this.updateDerivedRanges(null);
  }

  /**
   * Returns the current target entity resolved by the tagging system,
   * or null if no valid target exists.
   */
  getTarget(): Entity | null {
    if (!this.followTaggedBehavior) return null;
    const info = this.followTaggedBehavior.getTargetInfo();
    return info.isValid ? info.targetEntity : null;
  }

  override update(deltaTime: number): void {
    if (this.followTaggedBehavior && this.attackBehavior) {
      const info = this.followTaggedBehavior.getTargetInfo();
      const targetEntity = info.isValid ? info.targetEntity : null;
      this.attackBehavior.targetEntity = targetEntity;
      // Forward the smoothed target velocity so the attack controller can lead
      // a moving target. The targeting stack already computes this for the
      // follow path; null it out when there is no valid target.
      this.attackBehavior.targetVelocity = info.isValid ? info.smoothedVelocity : null;

      // Invalidate target footprint when the target changes — collider
      // geometry differs per entity. Self + target footprints also
      // auto-invalidate on root XZ scale change inside the cached getters.
      // For child-collider scale animations or rig/equipment swaps the
      // root probe cannot see, authors call `invalidateFootprintCache()`.
      if (targetEntity !== this.cachedTarget) {
        this.targetFootprintXZ = null;
        this.targetScaleAtCache = null;
        this.cachedTarget = targetEntity;
        // The vertical-gap low-pass is target-relative, so a swap must re-seed
        // it. Carrying the previous target's elevation would size the follow
        // point and the settle gate against a target that is no longer there.
        this.verticalGapSeeded = false;
      }

      // WHY: gated on the target alone, NOT on `hasWarnedStall`. This once also
      // skipped a latched actor, on the premise that only the stall warning read
      // the geometry — but `updateDerivedRanges` below now derives the follow
      // point and the settle gate from `smoothedVerticalGap` every frame. Under
      // the old gate a latched warning froze this helper, and the follower then
      // steered off whatever vertical gap happened to be cached at latch time
      // for the rest of the engagement. The gate did not even buy the native
      // reads it was written for: `updateDerivedRanges` -> `getTargetReach`
      // resolves both transforms on the next line unconditionally, so gating
      // here only ever froze the gap.
      if (targetEntity) {
        this.updateFrameGeometry(targetEntity, deltaTime);
      }
      this.updateDerivedRanges(targetEntity);
      this.updatePursuitStallWarning(deltaTime);
    }

    // CompositeBehavior.update() drives sub-behaviors in priority order
    // and handles controller routing automatically
    super.update(deltaTime);
  }

  /**
   * Invalidates the cached collider footprints so the next frame recomputes
   * them. Call this when the actor's or target's collider geometry / world
   * scale changes at runtime (e.g. scale animation, rig swap, equipment change).
   * Target-change invalidation is automatic.
   */
  public invalidateFootprintCache(scope: 'self' | 'target' | 'all' = 'all'): void {
    if (scope === 'self' || scope === 'all') this.selfFootprintXZ = null;
    if (scope === 'target' || scope === 'all') this.targetFootprintXZ = null;
  }

  /** Reads an entity's root XZ world scale; returns null when unavailable. */
  private getRootScaleXZ(entity: Entity): number | null {
    const t = entity.getComponent(TransformComponent);
    return t ? Math.max(Math.abs(t.worldScale.x), Math.abs(t.worldScale.z)) : null;
  }

  /**
   * Returns the cached self footprint, recomputing if the root XZ scale
   * changed since the last cache or if the cache was invalidated. Returns
   * 0 without caching when `getEntity()` is null (pre-init / teardown),
   * so the cache is not poisoned and the next frame retries. When the
   * entity has no TransformComponent the scale snapshot is null on both
   * sides of the compare, so the cache holds (avoids per-frame recompute
   * from a `NaN === NaN` mismatch).
   *
   * A computed 0 is deliberately NOT cached: a 0 footprint is either a
   * genuinely collider-less entity (cheap to re-derive) or a mesh collider
   * whose asset has not streamed in yet (transient — see getMeshFootprintXZ).
   * Caching the transient 0 would freeze the actor at a point-target band for
   * the rest of its life. Recompute is O(few components); paying it each frame
   * until a real footprint resolves is the safe trade.
   *
   * The 0 case CLEARS the memo rather than merely skipping the write. Skipping
   * would leave the previous (value, scale) pair intact, so a scale that moves
   * away and returns — S1 caches N, S2 recomputes 0, back to S1 — would hit the
   * stale N instead of re-deriving. Clearing makes the next call a genuine miss
   * at every scale.
   */
  private getSelfFootprintXZCached(): number {
    const selfEntity = this.getEntity();
    if (!selfEntity) return 0;
    const currentScale = this.getRootScaleXZ(selfEntity);
    if (this.selfFootprintXZ !== null && currentScale === this.selfScaleAtCache) {
      return this.selfFootprintXZ;
    }
    const {radius, zeroIsFinal} = this.getFootprintXZ(selfEntity);
    if (radius > 0 || zeroIsFinal) {
      this.selfFootprintXZ = radius;
      this.selfScaleAtCache = currentScale;
    } else {
      this.selfFootprintXZ = null;
    }
    return radius;
  }

  /**
   * Returns the cached target footprint, recomputing if the target's root
   * XZ scale changed since the last cache or if the cache was invalidated.
   * Target identity changes are auto-invalidated upstream in `update()`.
   *
   * As with the self footprint, a computed 0 CLEARS the memo rather than being
   * cached. This is the exact castle case that motivated the mesh-collider
   * path: a building imported as a TriangleMesh reports 0 until its asset
   * streams in, and freezing that 0 would leave every attacker measuring to the
   * castle's interior pivot for the rest of the encounter.
   */
  private getTargetFootprintXZCached(targetEntity: Entity | null): number {
    if (!targetEntity) return 0;
    const currentScale = this.getRootScaleXZ(targetEntity);
    if (this.targetFootprintXZ !== null && currentScale === this.targetScaleAtCache) {
      return this.targetFootprintXZ;
    }
    const {radius, zeroIsFinal} = this.getFootprintXZ(targetEntity);
    if (radius > 0 || zeroIsFinal) {
      this.targetFootprintXZ = radius;
      this.targetScaleAtCache = currentScale;
    } else {
      this.targetFootprintXZ = null;
    }
    return radius;
  }

  /**
   * Target reach used in `sumR`. Prefers the direction-aware measure (distance
   * from the target pivot to the near wall the actor is approaching) and falls
   * back to the static Chebyshev footprint when no confident directional value
   * is available. For a primitive-collider target the two agree, so only a
   * large off-center-pivot mesh prop (the castle) is affected.
   */
  private getTargetReach(targetEntity: Entity | null): number {
    const staticReach = this.getTargetFootprintXZCached(targetEntity);
    if (!targetEntity) return staticReach;
    const selfEntity = this.getEntity();
    if (!selfEntity) return staticReach;
    const selfPos = selfEntity.getComponent(TransformComponent)?.worldPosition;
    const targetPos = targetEntity.getComponent(TransformComponent)?.worldPosition;
    if (!selfPos || !targetPos) return staticReach;
    const directional = this.getDirectionalTargetReach(
      targetEntity, selfPos, targetPos, staticReach,
    );
    return directional != null ? directional : staticReach;
  }

  /**
   * Direction-aware target reach: the distance from the target pivot to the
   * near wall the actor faces, replacing the static Chebyshev footprint (which
   * measures pivot-to-FARTHEST-AABB-edge and over-reaches badly for a large
   * prop whose pivot sits inside its geometry — the castle, where it parks
   * attackers 15-20m outside the wall). Returns null when no directional
   * measure is confident so the caller keeps the static footprint.
   *
   * Ladder, both clamped to [0, staticReach]:
   *  1. NAVMESH RAYCAST actor -> pivot. The first non-walkable navmesh edge is
   *     the wall; reach = distToPivot - hitDistance. Conforms to the true baked
   *     geometry and ignores dynamic actors (they are not navmesh holes).
   *  2. AABB SLAB. Distance from the pivot to the AABB face the approach ray
   *     crosses — the directional analogue of the Chebyshev max, used when no
   *     navmesh exists or the raycast could not confirm the target.
   *
   * The clamp to staticReach (the Chebyshev outer bound, the largest legitimate
   * reach) means a bad hit on an intervening obstacle can only ever pull the
   * actor CLOSER than today's behavior, never further out — the safe direction.
   *
   * PROTOTYPE: the extra logging in the helpers is intentional and temporary.
   */
  private getDirectionalTargetReach(
    target: Entity,
    selfPos: Vec3,
    targetPos: Vec3,
    staticReach: number,
  ): number | null {
    // Nothing to refine: a point/primitive target already measures to a
    // meaningful surface, and only mesh props exhibit the pivot over-reach.
    if (staticReach <= 0) return null;
    if (!this.targetHasMeshCollider(target)) return null;

    const dx = targetPos.x - selfPos.x;
    const dz = targetPos.z - selfPos.z;
    const distToPivot = Math.sqrt(dx * dx + dz * dz);
    // Actor sitting on the pivot — approach direction undefined; keep static.
    if (distToPivot < 1e-3) return null;

    const navReach = this.tryNavMeshDirectionalReach(
      selfPos, targetPos, distToPivot, staticReach,
    );
    if (navReach != null) return navReach;

    const slabReach = this.tryAabbSlabReach(
      target, targetPos, dx, dz, distToPivot, staticReach,
    );
    if (slabReach != null) return slabReach;

    return null;
  }

  /**
   * Primary reach: cast a navmesh ray from the actor toward the target pivot.
   * The first non-walkable edge crossed is the target wall (the castle is a
   * carved-out navmesh hole). reach = distToPivot - hitDistance. Returns null
   * on no navmesh, a clear ray, a failed query, or a hit that fails the
   * hit-is-target sanity check.
   */
  private tryNavMeshDirectionalReach(
    selfPos: Vec3,
    targetPos: Vec3,
    distToPivot: number,
    staticReach: number,
  ): number | null {
    const navMesh = this.resolveNavMeshComponent();
    if (!navMesh) return null;

    const inv = 1 / distToPivot;
    const dir = new Vec3(
      (targetPos.x - selfPos.x) * inv,
      0,
      (targetPos.z - selfPos.z) * inv,
    );
    const origin = new Vec3(selfPos.x, selfPos.y, selfPos.z);

    // PROTOTYPE probe: is the target pivot carved out of the navmesh (a
    // non-walkable hole)? Confirms the castle-is-an-obstacle assumption from a
    // headless eval log. 0=Walkable 1=NotWalkable 2=Jump -1=off-navmesh.
    let pivotArea = -99;
    try {
      pivotArea = navMesh.getAreaTypeOnPoint(
        new Vec3(targetPos.x, targetPos.y, targetPos.z),
        {maxSearchDistance: NAVMESH_SNAP_TOLERANCE_M},
      );
    } catch {
      // Non-fatal: the probe is diagnostic only.
    }

    let hit;
    try {
      hit = navMesh.raycast(origin, dir, distToPivot, {
        maxSearchDistance: NAVMESH_SNAP_TOLERANCE_M,
      });
    } catch (e) {
      console.debug(`[EngageCombat][reach] navmesh raycast threw: ${String(e)}`);
      return null;
    }

    if (!hit.hit) {
      // Ray reached the pivot without crossing a non-walkable edge: the target
      // is not a navmesh hole here (unbaked / different layer) or the origin
      // was off-navmesh (distance === 0). Fall back to the slab.
      this.logReach('nav-miss', staticReach, staticReach, pivotArea, hit.distance);
      return null;
    }

    const reach = distToPivot - hit.distance;
    const hdx = hit.position.x - targetPos.x;
    const hdz = hit.position.z - targetPos.z;
    const hitToPivot = Math.sqrt(hdx * hdx + hdz * hdz);
    const tol = DIRECTIONAL_REACH_SANITY_TOL_M;

    // Hit-is-target sanity: the wall must sit near the target (inside the
    // Chebyshev bound) and give a positive reach no larger than that bound. A
    // closer hit (another prop between actor and target) fails this and falls
    // back rather than parking the actor short of the real target.
    if (reach <= 0 || reach > staticReach + tol || hitToPivot > staticReach + tol) {
      this.logReach('nav-reject', staticReach, reach, pivotArea, hit.distance);
      return null;
    }

    const clamped = Math.min(reach, staticReach);
    this.logReach('nav', staticReach, clamped, pivotArea, hit.distance);
    return clamped;
  }

  /**
   * Fallback reach: intersect the approach ray with the target's mesh world
   * AABB and return the pivot-to-near-face distance along that ray — the
   * directional analogue of {@link getMeshFootprintXZ}'s Chebyshev max. Assumes
   * the pivot is inside the AABB (normal for a building FBX); a pivot outside
   * yields a non-positive / non-finite `t` and falls back to the static reach.
   */
  private tryAabbSlabReach(
    target: Entity,
    targetPos: Vec3,
    dx: number,
    dz: number,
    distToPivot: number,
    staticReach: number,
  ): number | null {
    const aabb = this.getMeshWorldAabbXZ(target);
    if (aabb == null) return null;

    // Unit direction pivot -> actor. The ray exits the AABB at the near face.
    const inv = 1 / distToPivot;
    const ox = -dx * inv;
    const oz = -dz * inv;
    const eps = 1e-6;
    let t = Infinity;
    if (ox > eps) {
      t = Math.min(t, (aabb.maxX - targetPos.x) / ox);
    } else if (ox < -eps) {
      t = Math.min(t, (aabb.minX - targetPos.x) / ox);
    }
    if (oz > eps) {
      t = Math.min(t, (aabb.maxZ - targetPos.z) / oz);
    } else if (oz < -eps) {
      t = Math.min(t, (aabb.minZ - targetPos.z) / oz);
    }
    if (!Number.isFinite(t) || t <= 0) return null;

    const clamped = Math.min(t, staticReach);
    this.logReach('slab', staticReach, clamped, -99, -1);
    return clamped;
  }

  /**
   * PROTOTYPE-ONLY visibility for the direction-aware reach. Throttled to
   * source + rounded-reach transitions so a headless eval log shows the
   * measurement changing, not one line per frame. Remove before landing.
   */
  private logReach(
    source: string,
    staticReach: number,
    usedReach: number,
    pivotArea: number,
    hitDist: number,
  ): void {
    const key = `${source}:${usedReach.toFixed(1)}`;
    if (key === this.lastReachLogKey) return;
    this.lastReachLogKey = key;
    console.log(
      `[EngageCombat][reach] src=${source} used=${usedReach.toFixed(2)}m ` +
      `staticChebyshev=${staticReach.toFixed(2)}m pivotArea=${pivotArea} ` +
      `navHitDist=${hitDist.toFixed(2)}m`,
    );
  }

  /**
   * Lazily resolves the NavMesh component, re-discovering it if the cache went
   * stale or the entity outlived its component. Returns null when the world has
   * no navmesh. Mirrors ActorSpawner.resolveNavMeshComponent().
   */
  private resolveNavMeshComponent(): NavMeshComponent | null {
    if (this.cachedNavMeshEntity != null && !this.cachedNavMeshEntity.valid) {
      this.cachedNavMeshEntity = null;
    }
    if (this.cachedNavMeshEntity != null) {
      const cached = this.cachedNavMeshEntity.getComponent(NavMeshComponent);
      if (cached != null) {
        return cached;
      }
      this.cachedNavMeshEntity = null;
    }
    const entities = EntityService.findEntitiesWithComponent(NavMeshComponent);
    if (entities.length === 0) {
      return null;
    }
    this.cachedNavMeshEntity = entities[0];
    return this.cachedNavMeshEntity.getComponent(NavMeshComponent);
  }

  /**
   * True when the rig carries a mesh collider (root or any descendant) — the
   * only case where the pivot-to-farthest-edge footprint over-reaches and the
   * directional measure is worth computing.
   */
  private targetHasMeshCollider(root: Entity): boolean {
    return (
      root.getComponent(ColliderMeshComponent) != null ||
      root.getComponent(ColliderConvexMeshComponent) != null ||
      root.getChildrenWithComponent(ColliderMeshComponent, true).length > 0 ||
      root.getChildrenWithComponent(ColliderConvexMeshComponent, true).length > 0
    );
  }

  /**
   * Re-validate the attack band every frame. `initialize()` checks it once, but
   * both bounds are public fields an author can mutate at runtime.
   *
   * A non-finite bound is the one bad input that breaks every consumer at
   * once, because `NaN` compares false against everything. Most of them fail
   * CLOSED: `AttackEntityInRangeBehavior`'s
   * `distance >= min && distance <= max` never admits, so the actor never
   * attacks; and in `FollowBehavior` both settle predicates fail together —
   * `distToFollow <= stuckSettleMaxDistance` and the `inHysteresis` test
   * against the equally-`NaN` `hysteresisRadius` — so no park path survives,
   * not even the `hardStuck` escape. That is stricter than passing 0: a 0 gate
   * still admits `distToFollow === 0`, whereas `NaN` admits nothing.
   *
   * But one consumer fails OPEN, in the opposite direction, which is why the
   * band has to be healed at the source instead of clamped at each reader:
   * `maxAttackDistance` reaches the `engagementRange` clamp below through
   * `Math.max`, so a `NaN` bound also NaNs `maxRange`, and
   * `TargetTaggedEntityBehavior` reads that as
   * `maxRange > 0 ? maxRange * maxRange : Infinity` — an actor the author gave
   * a POSITIVE acquisition range becomes unlimited-aggro. Worse, that clamp
   * writes its result back to the public `engagementRange`, so the `NaN`
   * outlives the bad band: once poisoned, `engagementRange <= 0` stays false
   * and `Math.max` stays `NaN` even after the author repairs the band, and the
   * cleared latch means nothing logs again. Healing the band before the clamp
   * reads it is what prevents that one-way corruption.
   *
   * None of these sub-behaviours can see the band, so the guard has to live
   * here.
   *
   * The warning is latched because this runs per frame — an unlatched
   * `console.error` here spams the log at tick rate for the actor's lifetime,
   * the same reason `updatePursuitStallWarning` latches — and the latch clears
   * once the band reads valid again, so a later, distinct corruption is still
   * reported rather than healed under a stale warning.
   *
   * Healing resets the offending bound to 0 and then re-applies `initialize()`'s
   * min > max swap: resetting only one bound can itself invert the band (a legit
   * `min = 1.5` with a mutated `max = NaN` heals to `min = 1.5, max = 0`), and
   * the swap keeps the heal from manufacturing the very inversion it is cleaning
   * up. Note the swap moves the SURVIVING bound: `min = 1.5, max = NaN` ends
   * up as `min = 0, max = 1.5`, so an author's dead-zone floor becomes the
   * outer edge. This is NOT a general per-frame swap — it fires only when a
   * bound was already non-finite/negative — so an author-set inversion of two
   * finite bounds still degrades visibly rather than being silently reordered
   * each frame (negative `bandW` is absorbed by the `Math.max(0.15, ...)`
   * hysteresis floor and by the midpoint fallback in
   * `getPreferredStandDistance`, which a negative `bandW` always reaches
   * because it forces `innerFloor > outerCap`).
   */
  private sanitizeAttackBand(): void {
    const badMax =
      !Number.isFinite(this.maxAttackDistance) || this.maxAttackDistance < 0;
    const badMin =
      !Number.isFinite(this.minAttackDistance) || this.minAttackDistance < 0;
    if (!badMax && !badMin) {
      // Band reads valid again: clear the latch so a later, distinct
      // corruption is reported instead of healed silently.
      this.hasWarnedAttackBand = false;
      return;
    }

    if (!this.hasWarnedAttackBand) {
      console.error(
        `[EngageCombat] non-finite or negative attack band ` +
        `(min=${this.minAttackDistance}, max=${this.maxAttackDistance}) — ` +
        `resetting the offending bound(s) to 0, then re-ordering if that ` +
        `inverts the band, so a surviving valid bound can end up as the ` +
        `other edge (min=1.5, max=NaN heals to min=0, max=1.5). Left ` +
        `unhandled this NaNs the band-derived ranges pushed to the ` +
        `sub-behaviours: the attack and settle gates then admit nothing, and ` +
        `the acquisition gate reads NaN as "no limit" and admits everything.`,
      );
      this.hasWarnedAttackBand = true;
    }
    if (badMax) this.maxAttackDistance = 0;
    if (badMin) this.minAttackDistance = 0;
    // Resetting only the offending bound can leave min > max; re-apply
    // initialize()'s swap so the heal never emits an inverted band.
    if (this.minAttackDistance > this.maxAttackDistance) {
      const tmp = this.minAttackDistance;
      this.minAttackDistance = this.maxAttackDistance;
      this.maxAttackDistance = tmp;
    }
  }

  /**
   * Pushes derived center-to-center distances to the follow and attack
   * sub-behaviors using the cached collider footprints.
   *
   * Footprints are cached across frames; call `invalidateFootprintCache()`
   * when collider geometry or world scale changes at runtime (target-change
   * invalidation is automatic).
   */
  private updateDerivedRanges(targetEntity: Entity | null): void {
    this.sanitizeAttackBand();

    const targetReach = this.getTargetReach(targetEntity);
    this.lastTargetReach = targetReach;
    const sumR = this.getSelfFootprintXZCached() + targetReach;

    // Re-validate engagementRange every frame — `initialize()` clamps once,
    // but authors can mutate the field at runtime and re-introduce the
    // target-acquire/drop oscillation it was added to prevent. Write the
    // clamped value back to the field so external readers of
    // `combat.engagementRange` see the effective value, consistent with
    // `initialize()`'s self-healing semantics. The `<= 0` "unlimited" sentinel
    // is preserved untouched — clamping it would silently defeat aggro-on-spawn.
    const unlimited = this.engagementRange <= 0;
    const effectiveEngagementRange = unlimited
      ? this.engagementRange
      : Math.max(this.engagementRange, this.maxAttackDistance);
    if (!unlimited && this.engagementRange !== effectiveEngagementRange) {
      this.engagementRange = effectiveEngagementRange;
    }

    const standDist = this.getPreferredStandDistance();
    const bandW = this.maxAttackDistance - this.minAttackDistance;

    // Push derived center-to-center values to attack behavior
    this.attackBehavior!.minAttackDistance = sumR + this.minAttackDistance;
    this.attackBehavior!.maxAttackDistance = sumR + this.maxAttackDistance;
    // Also push the raw radii sum so the attack behavior can convert its
    // center-to-center distance back to a surface (gap) distance for telemetry,
    // using the exact same sumR that defines the band above.
    this.attackBehavior!.radiiSum = sumR;

    // Push derived values to follow behavior via the runtime update API,
    // which writes both the outer public fields and the inner sub-behavior
    // per-frame caches. This template assumes the paired
    // `FollowTaggedEntityBehavior` is regenerated together with this one —
    // any bundle without `applyRuntimeRanges` (including one still carrying
    // only its predecessor `updateRuntimeRanges`) will fail loudly here, which
    // is the intended signal to regenerate both templates. The rename is what
    // makes that failure loud; see the method's own docblock.
    const hysteresis = Math.max(0.15, bandW * 0.4);
    const stopDist = this.getArrivalTolerance();
    // Unlimited (<= 0): pass 0 so FollowTaggedEntityBehavior disables its range
    // gate and acquires/retains at any distance. Otherwise gate at the derived
    // center-to-center engagement range.
    const acquisitionMaxRange = unlimited ? 0 : sumR + effectiveEngagementRange;
    // In-band gate for the follower's stuck fallback. The follow point sits
    // `standDist` (surface) from the target, so the OUTER attack edge lies
    // exactly `maxAttackDistance - standDist` of remaining path beyond it.
    // That difference IS the in-attack-range window, and FollowBehavior
    // compares against it inclusively (`distToFollow <= gate`), so the edge
    // itself is already settleable. A jostled actor stopped beyond the window
    // keeps pursuing — and re-closes once the crowd clears — instead of
    // force-settling out of attack range (the "only the Nth attacker lands a
    // hit" crowding failure). How wide the window is follows from where
    // getPreferredStandDistance() put `standDist`, so it varies by regime —
    // read it there rather than restating a per-regime formula here, which is
    // how this comment previously drifted. A stuck actor settles no farther
    // than `min(hysteresis, window)` beyond the follow point, so it stays
    // inside the band whenever the window is a true in-band measure. Which of
    // the two binds is band-dependent, not fixed: hysteresis floors at 0.15,
    // while the raw window shrinks to 0 on a zero-width band, so on a narrow
    // band the window binds. This is a path distance, matching `distToFollow`
    // in FollowBehavior.
    //
    // Floored at `stopDist` because the follower physically parks anywhere
    // within `distanceToStop` (== `stopDist`) of the follow point: a gate
    // tighter than that names a settle zone the actor can never hold, so it
    // would arrive, settle, and be evicted again every frame. Neither the
    // press-in default nor the kiter inset covers this on its own — in the
    // degenerate regime `getPreferredStandDistance()` returns the MIDPOINT, so
    // the window collapses to `bandW / 2`. That regime includes
    // the documented `maxAttackDistance = 0` bite/unarmed config and any
    // `minAttackDistance === maxAttackDistance` band. In it a `stopDist`-deep
    // shell just outside the (zero-width) attack band becomes settleable; that
    // is unavoidable, since no actor can stop on an infinitely thin shell, and
    // it is strictly better than the per-frame settle/pursue flap the
    // un-floored gate produces.
    //
    // BOTH the follow point and the gate are projected onto the horizontal
    // plane. Everything the follower measures is an XZ along-path quantity
    // (`GotoBehavior.getRemainingPathLength()` sums dx/dz and never reads .y),
    // while the authority that authorizes an attack,
    // `AttackEntityInRangeBehavior`, tests a 3D magnitude. Treating the two as
    // the same quantity makes them disagree by exactly the vertical gap.
    //
    // Projecting only the GATE is inert exactly where the bug lives: wherever
    // the outer inset binds, the flat window already equals `stopDist` (both
    // come from `getArrivalTolerance()`), so the floor returns the same value
    // for every vertical gap and the correction is discarded. Worse, an
    // un-projected FOLLOW POINT is itself outside 3D reach once
    // `dy > sqrt(reach3D^2 - followRange^2)`: the actor arrives,
    // `arrivedAtCenter` settles it without ever consulting the gate, and the
    // settled-exit clause is exempted by that same arrival — permanently
    // parked out of attack range on the UNCROWDED path.
    //
    // So the follow point is placed at the horizontal radius whose 3D distance
    // IS the preferred stand distance, and the gate is the horizontal slack
    // from there to the outer edge. `dy = 0` reproduces the flat-ground values
    // exactly, so level terrain is unchanged. Above `dy = desired3D` no
    // stand-off exists and the actor closes to directly beneath the target,
    // which is the best available position rather than an unreachable one.
    const desired3D = sumR + standDist;
    const reach3D = sumR + this.maxAttackDistance;
    const verticalGap = this.smoothedVerticalGap;
    const followRangeXZ = Math.sqrt(
      Math.max(0, desired3D * desired3D - verticalGap * verticalGap),
    );
    const horizontalReach = Math.sqrt(
      Math.max(0, reach3D * reach3D - verticalGap * verticalGap),
    );
    const stuckSettleMaxDistance = Math.max(
      horizontalReach - followRangeXZ,
      stopDist,
    );
    // Mutate the held instance rather than allocating a literal per frame per
    // combat actor (`no-allocation-in-update-loop`). Every field is written
    // unconditionally on every call — because the object is reused, a
    // conditional write would leave last frame's value in place.
    const ranges = this.runtimeRanges;
    ranges.followRange = followRangeXZ;
    ranges.maxRange = acquisitionMaxRange;
    ranges.hysteresisRadius = hysteresis;
    ranges.distanceToStop = stopDist;
    ranges.stuckSettleMaxDistance = stuckSettleMaxDistance;
    this.followTaggedBehavior!.applyRuntimeRanges(ranges);
  }

  /**
   * Arrival tolerance (m) pushed to the follower as `distanceToStop`, and the
   * inset {@link getPreferredStandDistance} applies. Both derive from this one
   * formula so they cannot drift apart.
   */
  private getArrivalTolerance(): number {
    return Math.max(0.05, (this.maxAttackDistance - this.minAttackDistance) * 0.12);
  }

  private getPreferredStandDistance(): number {
    // Honor the author-set preferredAttackDistance, clamped into the attack
    // band. Fall back to minAttackDistance — press IN rather than hang back —
    // when the author left it unset / NaN / non-finite. That request then goes
    // through the same clamp as any other, so it lands on the target surface
    // for a melee band and one tolerance outside the floor for a dead-zone one
    // (see INNER below); it is not a bypass. This fallback is also exactly what
    // a zero-init template instance gets, matching the field default.
    const requested = Number.isFinite(this.preferredAttackDistance)
      ? this.preferredAttackDistance
      : this.minAttackDistance;
    // Inset one arrival tolerance from BOTH band edges rather than sitting on
    // either. The actor physically parks anywhere within `distanceToStop`
    // (== one tolerance) of the follow point, so a follow point ON an edge puts
    // half that spread outside the band.
    //
    // OUTER: for a kiter that sets preferredAttackDistance at or past the outer
    // edge. Parking exactly on it collapses the in-range settle window
    // (`maxAttackDistance - standDist`) to zero, so the stuck fallback could
    // never fire and any jitter drops the actor out of range.
    //
    // INNER: only when there is a real dead zone (`minAttackDistance > 0`).
    // Such a band clamps a smaller request UP to the floor, so a one-sided
    // inset parked the follow point exactly on the inner edge — and an actor
    // stopping one tolerance short of it falls INSIDE `minAttackDistance`,
    // where `AttackEntityInRangeBehavior` also refuses to fire. Same defect as
    // the outer edge, mirrored.
    //
    // At `minAttackDistance === 0` there is deliberately NO inner inset: no
    // distance is too close to attack from, the collider stops the actor
    // anyway, and an unconditional inset would hold a press-in melee actor a
    // tolerance off the target surface — defeating this fork's whole
    // press-in default.
    const tolerance = this.getArrivalTolerance();
    const outerCap = this.maxAttackDistance - tolerance;
    const innerFloor =
      this.minAttackDistance > 0
        ? this.minAttackDistance + tolerance
        : this.minAttackDistance;
    // When the band cannot hold the insets, `innerFloor` crosses above
    // `outerCap`. That gate is asymmetric because the inner inset is
    // conditional: with a dead zone it means `bandW < 2 * tolerance`, but at
    // `minAttackDistance === 0` — no inner inset to cross — it reduces to
    // `maxAttackDistance < tolerance`, i.e. a reach under 5 cm once the
    // tolerance hits its floor. Both cover the documented
    // `maxAttackDistance = 0` bite config and any `min === max` band. State the
    // branch, not a single width: a lone `bandW < 2 * tolerance` is wrong at 0.
    // The MIDPOINT is then the best available placement — it maximises the
    // margin to whichever edge is nearer. Clamping to either edge instead
    // maximises the margin to neither.
    // Note the inset alone still does NOT guarantee a non-degenerate settle
    // window in that regime; `updateDerivedRanges()` floors the derived gate at
    // `stopDist` to cover it. Do not rely on the inset for that.
    if (innerFloor > outerCap) {
      return (this.minAttackDistance + this.maxAttackDistance) / 2;
    }
    return Math.max(innerFloor, Math.min(requested, outerCap));
  }

  /**
   * True when the collider on `entity` belongs to a trigger volume.
   *
   * The conservative max in {@link getFootprintXZ} is justified by BLOCKING:
   * a collider the actor cannot pass through has to be stood clear of. A
   * trigger blocks nothing, so counting one only inflates `sumR` and pushes
   * the attack band out of reach — a 2.5m interaction sensor on a 0.3m
   * character makes every surface distance negative and combat never starts.
   *
   * Resolved the way physics resolves it: a collider need not carry its own
   * body, so the nearest body at or above it is the one that decides. The
   * shipped actor rig is exactly that shape — `KinematicCollider` holds the
   * capsule while `KinematicCharacter` above it holds the body — so reading
   * only the collider's own entity would miss a trigger authored the same way
   * and silently count its volume as solid.
   *
   * An entity with no body anywhere above it is NOT a trigger: absence of
   * evidence never excludes a collider, so an unrecognised rig keeps its
   * footprint rather than collapsing to a point.
   */
  private isTriggerVolume(entity: Entity): boolean {
    let cursor: Entity | null = entity;
    let depth = 0;
    while (cursor != null && depth < PHYSICS_BODY_WALK_MAX_DEPTH) {
      const body = cursor.getComponent(PhysicsBodyComponent);
      if (body) {
        return body.type === PhysicsBodyType.Trigger;
      }
      cursor = cursor.parent;
      depth += 1;
    }
    return false;
  }

  /**
   * Extracts the XZ-plane collision radius from an entity's collider,
   * scaled by the entity's world scale. Returns 0 if no collider is found.
   *
   * Returns the MAX scaled XZ radius across the root entity AND all child
   * colliders (capsule + sphere + box), plus a rig-wide mesh-collider
   * approximation. Multi-collider rigs (e.g. tiny root tag capsule + larger
   * chest box on a child) get the conservative bounding radius rather than the
   * root-first match, and every collider kind competes in the same max
   * regardless of which node carries it.
   *
   * `zeroIsFinal` reports whether a 0 radius is the ANSWER or merely not
   * resolved YET, which the callers need to decide whether the 0 is cacheable;
   * see {@link FootprintXZ}.
   */
  private getFootprintXZ(entity: Entity): FootprintXZ {
    // Mesh footprints are measured from the ROOT pivot (sumR is added to a
    // root-pivot-to-root-pivot distance), so resolve it once and thread it
    // through both the root and child-mesh measures. Primitive branches are
    // pivot-independent (they read half-extents/radius directly), so they do
    // not need it. Null when the root has no TransformComponent, in which case
    // no mesh reach can be expressed and getMeshFootprintXZ returns 0.
    const rootTransform = entity.getComponent(TransformComponent);
    const rootPivot = rootTransform
      ? {x: rootTransform.worldPosition.x, z: rootTransform.worldPosition.z}
      : null;

    // Tracks whether a collider was dropped for being a trigger. A 0 reached
    // that way is a settled answer; see FootprintXZ.
    let excludedATrigger = this.isTriggerVolume(entity);

    // Root collider participates in the max — do not early-return on a
    // small root match that would mask larger child colliders.
    let maxRadius = excludedATrigger ? 0 : this.getFootprintFromEntity(entity);

    const capsuleChildren = entity.getChildrenWithComponent(ColliderCapsuleComponent, true);
    for (const child of capsuleChildren) {
      const capsule = child.getComponent(ColliderCapsuleComponent);
      if (!capsule) continue;
      if (this.isTriggerVolume(child)) {
        excludedATrigger = true;
        continue;
      }
      const childTransform = child.getComponent(TransformComponent);
      const scaleXZ = childTransform
        ? Math.max(Math.abs(childTransform.worldScale.x), Math.abs(childTransform.worldScale.z))
        : 1;
      const r = capsule.radius * scaleXZ;
      if (r > maxRadius) maxRadius = r;
    }

    const sphereChildren = entity.getChildrenWithComponent(ColliderSphereComponent, true);
    for (const child of sphereChildren) {
      const sphere = child.getComponent(ColliderSphereComponent);
      if (!sphere) continue;
      if (this.isTriggerVolume(child)) {
        excludedATrigger = true;
        continue;
      }
      const childTransform = child.getComponent(TransformComponent);
      const scaleXZ = childTransform
        ? Math.max(Math.abs(childTransform.worldScale.x), Math.abs(childTransform.worldScale.z))
        : 1;
      const r = sphere.radius * scaleXZ;
      if (r > maxRadius) maxRadius = r;
    }

    const boxChildren = entity.getChildrenWithComponent(ColliderBoxComponent, true);
    for (const child of boxChildren) {
      const box = child.getComponent(ColliderBoxComponent);
      if (!box) continue;
      if (this.isTriggerVolume(child)) {
        excludedATrigger = true;
        continue;
      }
      const childTransform = child.getComponent(TransformComponent);
      const scaleXZ = childTransform
        ? Math.max(Math.abs(childTransform.worldScale.x), Math.abs(childTransform.worldScale.z))
        : 1;
      const he = box.halfExtents;
      const r = Math.max(Math.abs(he.x), Math.abs(he.z)) * scaleXZ;
      if (r > maxRadius) maxRadius = r;
    }

    // Mesh colliders (TriangleMesh / convex hull) expose no radius or extents,
    // only an asset handle, so the branches above see nothing and the entity
    // reads as a POINT. That is not a small error: sumR then collapses to the
    // self radius, and every derived range measures to the target's PIVOT.
    // For a building whose pivot sits inside its own geometry, "stop 1m from
    // the target" becomes physically unreachable -- the collider halts the
    // actor at the wall, the attack band is never entered, and the actor
    // pushes against the building indefinitely. Approximating from the mesh's
    // world AABB is coarse but bounded and always beats treating a castle as a
    // point.
    //
    // Resolved ONCE over the whole rig rather than per mesh-collider node. Both
    // properties matter: the renderable that supplies the bounds need not sit
    // at-or-below the collider that triggers the lookup (imported FBX props put
    // them on sibling nodes), and a per-node walk would re-scan overlapping
    // subtrees for every nested mesh collider. See getMeshFootprintXZ.
    const meshReach = this.getMeshFootprintXZ(entity, rootPivot);
    if (meshReach > maxRadius) maxRadius = meshReach;

    // A mesh collider whose bounds have not streamed reports 0 and will report
    // more later, so it keeps the 0 provisional however it was reached. Probed
    // only in the 0 case, which is off the steady-state path.
    const zeroIsFinal =
      maxRadius === 0 && excludedATrigger && !this.targetHasMeshCollider(entity);

    return {radius: maxRadius, zeroIsFinal};
  }

  /**
   * XZ footprint reach of a rig's MESH colliders, measured from an EXTERNAL
   * `pivot` (the root's world position) to the world-space AABB of the rig's
   * renderable meshes. `root` is the entity `getFootprintXZ` was called on, not
   * an individual collider node. Returns 0 when no mesh collider exists
   * anywhere in the rig, no MeshComponent exists anywhere in the rig, the
   * caller supplied no pivot, or no mesh has streamed in yet.
   *
   * Why the search is rig-wide and not scoped to the collider node: a mesh
   * COLLIDER exposes no bounds API, so the reach has to come off a renderable
   * MeshComponent, and imported FBX props do not reliably co-locate the two.
   * A collision proxy on one node with the renderable on a SIBLING is a normal
   * import layout, and scoping the search to the collider's own subtree would
   * miss it and collapse the prop back to a POINT — the exact bug this path
   * exists to remove. Resolving once from the root also means nested mesh
   * colliders cost one traversal rather than one per collider node.
   *
   * The trade is deliberate and matches the conservative-max contract of
   * getFootprintXZ: when a rig mixes a mesh collider with renderables that
   * belong to unrelated parts of the same hierarchy, those renderables widen
   * the reach too. A primitive collider elsewhere in the rig still competes in
   * the outer max, so the tighter measure wins whenever one exists.
   *
   * Why an external pivot and not each mesh entity's own transform: sumR is
   * added to a ROOT-pivot-to-ROOT-pivot distance. A mesh carried on a CHILD
   * offset from the root would, measured from its own pivot, report only its
   * local half-reach and drop the root->child offset — under-reporting exactly
   * the far edge an attacker must stop short of. Measuring the same world AABB
   * from the root pivot folds that offset in. For the common single-prop case
   * (mesh on the root) the pivot IS the entity's own worldPosition.
   *
   * Reduction is Chebyshev (`max(dx, dz)`), matching the box branch, NOT the
   * Euclidean pivot-to-corner hypotenuse. The band feeds a per-axis-style
   * surface offset that the primitive branches already express as a
   * half-extent max; using the hypotenuse here would make an identical
   * bounding box read ~41% larger through the mesh path than through the box
   * path purely by which collider primitive an author happened to import. One
   * conservative axis-max reach keeps the two paths comparable.
   *
   * Two residual over-estimates remain, both in the stop-early direction. An
   * off-center pivot reaches past the near face. And `getWorldBounds*` is an
   * axis-aligned box built by transforming the mesh-space AABB, so a ROTATED
   * prop reports a corner-swept box rather than a tight fit — a 45-degree
   * square reads ~1.41x its true half-width. Both are bounded by the rig's
   * world AABB and neither can reintroduce the point-target failure; the
   * direction-aware raycast follow-up removes them.
   *
   * Deliberately NOT scaled by worldScale like the primitive branches: the
   * world bounds already account for the entity transform and mesh scale, so
   * applying scaleXZ again would square it.
   *
   * A 0 result from unstreamed bounds is transient rather than terminal: the
   * footprint cache clears rather than memoizes a 0 (see
   * getSelfFootprintXZCached), so the next call re-derives and a spawn-frame
   * miss is corrected as soon as the mesh resolves.
   */
  private getMeshFootprintXZ(
    root: Entity,
    pivot: {x: number; z: number} | null,
  ): number {
    // No root pivot to measure from (root lacks a TransformComponent), so no
    // reach can be expressed. The caller's primitive measures still apply.
    // Logged (only when a mesh collider is actually present) because a
    // mesh-collider rig with no root transform is a malformed prop, not an
    // expected transient like unstreamed bounds.
    if (pivot == null) {
      if (this.targetHasMeshCollider(root)) {
        console.debug(
          `[EngageCombatBehavior] mesh collider present but the root has no ` +
            `TransformComponent to measure from; footprint reads 0`,
        );
      }
      return 0;
    }
    const aabb = this.getMeshWorldAabbXZ(root);
    if (aabb == null) {
      return 0;
    }
    // Farthest AABB edge from the pivot in each horizontal axis, reduced to a
    // single conservative Chebyshev radius (matching the box branch). Over-reach
    // is the safe direction for this baseline: the actor stops a touch early
    // rather than clipping into geometry. The direction-aware ladder in
    // getDirectionalTargetReach tightens this per-approach at runtime.
    const dx = Math.max(
      Math.abs(aabb.maxX - pivot.x),
      Math.abs(pivot.x - aabb.minX),
    );
    const dz = Math.max(
      Math.abs(aabb.maxZ - pivot.z),
      Math.abs(pivot.z - aabb.minZ),
    );
    return Math.max(dx, dz);
  }

  /**
   * Unions the world-space XZ AABB of every renderable MeshComponent in a
   * mesh-collider rig (root + descendants). Returns null when the rig has no
   * mesh collider, no renderable MeshComponent, or no mesh has streamed its
   * bounds yet. Shared by the Chebyshev baseline ({@link getMeshFootprintXZ})
   * and the directional slab fallback ({@link tryAabbSlabReach}) so the two
   * measure the exact same geometry.
   *
   * Rig-wide (not scoped to the collider node) because a mesh COLLIDER exposes
   * no bounds API — the reach has to come off a renderable MeshComponent, and
   * imported FBX props routinely put the collision proxy and the renderable on
   * sibling nodes. See the original getMeshFootprintXZ rationale.
   */
  private getMeshWorldAabbXZ(
    root: Entity,
  ): {minX: number; minZ: number; maxX: number; maxZ: number} | null {
    // Nothing to approximate unless a mesh collider exists somewhere in the
    // rig. Checked before the MeshComponent gather so a purely primitive rig
    // (the common actor case) pays only the collider lookups, never the
    // renderable walk.
    if (!this.targetHasMeshCollider(root)) {
      return null;
    }
    // Gather every renderable MeshComponent in the rig — the root's own plus
    // all descendants — so a child offset is folded in rather than dropped.
    const meshes: MeshComponent[] = [];
    const ownMesh = root.getComponent(MeshComponent);
    if (ownMesh) {
      meshes.push(ownMesh);
    }
    for (const descendant of root.getChildrenWithComponent(
      MeshComponent,
      true,
    )) {
      const m = descendant.getComponent(MeshComponent);
      if (m) {
        meshes.push(m);
      }
    }
    if (meshes.length === 0) {
      // Mesh collider present but the rig carries no renderable MeshComponent
      // at all, so there are no world bounds and the entity reads as a POINT.
      // Rare (a collider-only proxy); logged at debug so the residual blind
      // spot is diagnosable rather than invisible.
      console.debug(
        `[EngageCombatBehavior] mesh collider present but no MeshComponent ` +
          `anywhere in the rig; footprint reads 0 (collider-only proxy?)`,
      );
      return null;
    }
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let anyBounds = false;
    for (const mesh of meshes) {
      const min = mesh.getWorldBoundsMin();
      const max = mesh.getWorldBoundsMax();
      if (min == null || max == null) {
        continue;
      }
      anyBounds = true;
      if (min.x < minX) minX = min.x;
      if (min.z < minZ) minZ = min.z;
      if (max.x > maxX) maxX = max.x;
      if (max.z > maxZ) maxZ = max.z;
    }
    if (!anyBounds) {
      // Mesh(es) present but none has world bounds yet — the asset has not
      // streamed in. This is the castle-reads-as-a-point window; expected on
      // the spawn frame and self-correcting (the cache refuses to freeze this
      // 0). Debug-level, not warn: one line per pre-stream frame would be
      // noise, but a persistent stream signals an asset that never loaded.
      console.debug(
        `[EngageCombatBehavior] mesh collider present but world bounds not ` +
          `ready (asset still streaming?); footprint reads 0 this frame`,
      );
      return null;
    }
    return {minX, minZ, maxX, maxZ};
  }

  /**
   * Checks a single entity for a PRIMITIVE collider and returns its scaled XZ
   * radius. Mesh colliders are not handled here: they are resolved rig-wide by
   * getMeshFootprintXZ, which competes in the same outer max. Keeping the mesh
   * path out of this per-entity helper is what makes the root and the child
   * sweep agree — an earlier shape checked mesh last on the root only, so the
   * same rig measured differently depending on which node carried the collider.
   *
   * The trigger test lives in the caller, not here, so the one place that
   * records an exclusion is the one place that performs it.
   */
  private getFootprintFromEntity(entity: Entity): number {
    const transform = entity.getComponent(TransformComponent);
    const scaleXZ = transform
      ? Math.max(Math.abs(transform.worldScale.x), Math.abs(transform.worldScale.z))
      : 1;

    const capsule = entity.getComponent(ColliderCapsuleComponent);
    if (capsule) {
      return capsule.radius * scaleXZ;
    }

    const sphere = entity.getComponent(ColliderSphereComponent);
    if (sphere) {
      return sphere.radius * scaleXZ;
    }

    const box = entity.getComponent(ColliderBoxComponent);
    if (box) {
      const he = box.halfExtents;
      return Math.max(Math.abs(he.x), Math.abs(he.z)) * scaleXZ;
    }

    return 0;
  }

  /**
   * Resolves the actor/target transform pair and updates the cached geometry
   * read by BOTH `updatePursuitStallWarning` and `updateDerivedRanges` — the
   * latter projects the follow point and the settle gate onto the horizontal
   * from the vertical gap cached here.
   *
   * When the transforms are unavailable or non-finite both cached values HOLD
   * their previous reading and the frame is marked invalid; nothing is reset.
   * `updatePursuitStallWarning` then skips the frame outright, because a stale
   * XZ separation would corrupt its elapsed-time count. Holding rather than
   * resetting also keeps one frame of target flicker from snapping the future
   * follow-point derivation to the flat-ground value.
   */
  private updateFrameGeometry(
    targetEntity: Entity | null,
    deltaTime: number,
  ): void {
    const selfEntity = this.getEntity();
    const selfPos = selfEntity?.getComponent(TransformComponent)?.worldPosition;
    const targetPos = targetEntity?.getComponent(TransformComponent)?.worldPosition;
    if (!selfPos || !targetPos) {
      this.frameGeometryValid = false;
      return;
    }

    const dx = selfPos.x - targetPos.x;
    const dz = selfPos.z - targetPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);
    const rawVerticalGap = Math.abs(selfPos.y - targetPos.y);
    // A transform read is native and can hand back a non-finite component. Any
    // such frame is unresolvable: a `NaN` XZ separation would corrupt the stall
    // warning's elapsed-time count, and the vertical IIR below is absorbing — a
    // `NaN` written once is `NaN` for the actor's lifetime. Guard EVERY
    // component, then mark the frame invalid and hold both cached values so the
    // consumer skips it, exactly as the null-transform path above does. Setting
    // the valid flag only after the guard is what keeps a fresh XZ separation
    // from ever being paired with a stale vertical gap.
    if (!Number.isFinite(distXZ) || !Number.isFinite(rawVerticalGap)) {
      this.frameGeometryValid = false;
      return;
    }
    this.frameGeometryValid = true;
    this.frameDistXZ = distXZ;

    const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    // The first reading for a target seeds the filter outright (alpha = 1);
    // later frames low-pass toward the raw gap. The time constant is a positive
    // module constant, so the exponential term needs no divide-by-zero guard.
    const alpha = this.verticalGapSeeded
      ? 1 - Math.exp(-dt / VERTICAL_GAP_SMOOTHING_TIME_CONSTANT_S)
      : 1;
    this.verticalGapSeeded = true;
    this.smoothedVerticalGap +=
      (rawVerticalGap - this.smoothedVerticalGap) * alpha;
  }

  /**
   * Warns when the actor has been pursuing without entering the
   * attack band for an extended period — indicates a configuration
   * problem or navmesh issue. Resets when target is lost so re-warning
   * is possible on a new target.
   */
  private updatePursuitStallWarning(deltaTime: number): void {
    const targetEntity = this.attackBehavior!.targetEntity;

    // Target-loss reset MUST run before the warned-stall short-circuit —
    // otherwise the warning latches for the NPC's entire lifetime and the
    // documented re-arm on new target acquisition never happens.
    if (!targetEntity) {
      this.pursuitStallTimer = 0;
      this.hasWarnedStall = false;
      return;
    }

    if (this.hasWarnedStall) return;

    // Skip a frame whose geometry could not be resolved. Unlike the range
    // derivation, which holds its last reading, a stale XZ separation here
    // would corrupt the elapsed-time count this warning is built on.
    if (!this.frameGeometryValid) return;

    // Same sumR as updateDerivedRanges() this frame: self footprint plus the
    // direction-aware target reach it just computed (updateDerivedRanges runs
    // first in update()), so the stall check measures against the band the
    // follower is actually driving to, not the looser Chebyshev footprint.
    const selfFootprint = this.getSelfFootprintXZCached();
    const targetFootprint = this.lastTargetReach;
    const sumR = selfFootprint + targetFootprint;

    // Measured in 3D, matching `AttackEntityInRangeBehavior` — the authority
    // that actually authorizes an attack. Measured in XZ this reported
    // "in range" for a target directly overhead and reset its own timer every
    // frame, so the one console signal for "reaches the target but never
    // attacks" was blind in precisely the elevated case it should catch.
    const dist3D = Math.sqrt(
      this.frameDistXZ * this.frameDistXZ +
        this.smoothedVerticalGap * this.smoothedVerticalGap,
    );
    // WHY: the predicate reads the SIGNED gap. `Math.max(0, ...)` folds every
    // frame closer than `sumR` onto the inner band edge, and at the shipped
    // default `minAttackDistance = 0` that reads as in-range — resetting the
    // timer in exactly the case `AttackEntityInRangeBehavior` refuses to fire
    // in (`distance >= sumR + minAttackDistance`, its band pushed by
    // `updateDerivedRanges`): an actor pressed inside a large mesh target's
    // reach, or a target overhead by less than `sumR`. Reading the signed gap
    // makes the band test match that authority for every sign.
    const signedGap = dist3D - sumR;
    const isInRange =
      signedGap >= this.minAttackDistance && signedGap <= this.maxAttackDistance;

    if (isInRange) {
      this.pursuitStallTimer = 0;
      return;
    }

    // Sanitized for the same reason as the vertical gap: one non-finite frame
    // would make `pursuitStallTimer` NaN, and `NaN > 5.0` is false forever —
    // silencing this diagnostic for the actor's whole lifetime.
    this.pursuitStallTimer +=
      Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;

    if (this.pursuitStallTimer > 5.0) {
      console.warn(
        `[EngageCombat] Actor cannot reach attack band after 5s of pursuit. ` +
        // Signed, not clamped: a negative value is the actionable case (the
        // actor is INSIDE the summed radii and the attack authority refuses to
        // fire), and clamping it to 0 printed a distance that reads as in-band
        // right next to a message saying the band was never reached.
        `Current surface distance=${signedGap.toFixed(2)}m, ` +
        `attack band=[${this.minAttackDistance}, ${this.maxAttackDistance}]m. ` +
        `Check navmesh connectivity, collider radii (self=${selfFootprint.toFixed(2)}, ` +
        `target=${targetFootprint.toFixed(2)}), or maxAttackDistance.`,
      );
      this.hasWarnedStall = true;
    }
  }
}
