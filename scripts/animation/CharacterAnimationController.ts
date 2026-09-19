/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import {
  component,
  editor,
  property,
  subscribe,
  ExecuteOn,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  type OnWorldUpdateEventPayload,
  AnimatorComponent,
  type EventData,
  type EventSubscription,
  type IEvent,
  type Maybe,
  type Entity,
  Vec3,
  TransformComponent,
} from 'meta/worlds';
import {CharacterStateMachine, StateId} from '../Character/State/CharacterStateMachine';
import {MovementAbility} from '../Character/Abilities/MovementAbility';
import {CharacterForceControllerBase} from '../Character/Force/CharacterForceControllerBase';
import {JumpStartedEvent} from '../Character/Abilities/JumpAbility';
import {ICharacterInitializable} from '../Character/ICharacterInitializable';
import {
  fromStateEntry,
  WorldsCharacterStateReplication,
  type ReplicatedValue,
} from '../Character/WorldsCharacterStateReplication';
import {AnimKey} from './AnimKey';
import {AnimVar} from './AnimationGraphContract';
import {resolveComponent, resolveComponentOrThrow} from './EntityUtils';
import {CharacterSpeedSmoother} from './CharacterSpeedSmoother';
import type {AnimFrame, AnimLayer, AnimLayerHost} from './layers/AnimLayer';
import {createAnimLayers} from './layers/index';

/**
 * CharacterAnimationController — the host the character's animation layers are mounted on.
 *
 * It owns exactly three things, and deliberately no fourth:
 *   1. THE BASE GRAPH. The locomotion blend (`Speed`, `MovementDirectionYaw`, `ShouldStrafe`)
 *      and the grounded / jumping bools, fed from whichever velocity source this character
 *      has — the owner's physics, a proxy's replicated transform, or observed motion for a
 *      character with no MovementAbility at all.
 *   2. TRANSPORT. Binding the optional {@link WorldsCharacterStateReplication} and routing
 *      each replicated key to whichever layers claimed it. The routing table is built from
 *      the layers, so there is no hand-written dispatch to extend.
 *   3. COMPOSITION. Mounting the layers, ticking them, and propagating cross-layer tags.
 *
 * IT KNOWS NO LAYER. No layer, state or action is named in this file. Callers address an
 * `AnimAction` — a gameplay intent — layers claim one, and the host only forwards. Adding a
 * layer is a file in `layers/` plus a line in `layers/index.ts`; nothing here changes. See
 * `layers/AnimLayer.ts` for what a layer may do.
 *
 * MULTIPLAYER IS OPT-IN via a sibling {@link WorldsCharacterStateReplication}. Without one
 * everything applies locally (single-player). With one, {@link fireNet} / {@link setNet}
 * predict on the calling client and replicate owner → all, and the callbacks drive every
 * client's layers identically. The locomotion floats are never networked either way: a stale
 * speed is a perpetual sprint, and direction is recoverable from the replicated transform.
 *
 * WHY THE REMOTE VELOCITY IS SMOOTHED AND THE OWNER'S IS NOT (read before trying to unify):
 * a proxy does not run the physics simulation — it only sees the transform as it replicates,
 * with dropped frames and jitter — so a raw per-frame position delta is noisy and fed straight
 * to the animator produces visible popping. The owner reads the physics engine output
 * directly with no round-trip, so smoothing it would only add latency and blur.
 */
@component({
  description:
    'Host for the character animation layers: drives the base-graph locomotion blend, routes replicated state to the layers, and mounts everything in layers/index.ts. Layer behaviour lives in the layers, not here.',
})
export class CharacterAnimationController extends ICharacterInitializable implements AnimLayerHost {
  @property()
  public animatorEntity: Maybe<Entity> = null;

  @property()
  public groundedThreshold: number = 0.8;

  @editor({
    description: `Frames of velocity averaged together in measured mode (a character with no MovementAbility, i.e. an NPC). Higher is smoother but less responsive. Ignored when movement drives the blend. 🚨 Template gotcha: stored as 0 on a template instance — set 10 explicitly.`,
  })
  @property({isNetworked: false, minValue: 1.0, maxValue: 60.0})
  public smoothingFrameCount: number = 10;

  @editor({
    description: `Measured-mode speed clamp (m/s), which keeps a teleport or a physics glitch from spiking the locomotion blend. 🚨 Template gotcha: stored as 0 on a template instance, and a 0 clamps all motion to zero — set 10.0 explicitly.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 100.0})
  public maxSpeedClamp: number = 10.0;

  @editor({
    description: `Measured-mode multiplier applied to the speed before it reaches the animator, for tuning blend thresholds. 🚨 Template gotcha: stored as 0 on a template instance, and a 0 freezes locomotion animation entirely — set 1.0 explicitly.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 10.0})
  public speedMultiplier: number = 1.0;

  @editor({
    description: `Measured-mode floor below which speed is treated as zero, so micro-movement does not trip the locomotion blend. 🚨 Template gotcha: stored as 0 on a template instance, which disables the filter — set 0.01 explicitly.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 1.0})
  public minSpeedThreshold: number = 0.01;

  @editor({
    description: `Movement speed at which a masked layer's mask reaches full strength (the action confined to the upper body, legs left to locomotion). The ramp is proportional from 0 up to this — at the 1.0 default, half speed is a half-strength mask. Layers with no mask ignore it.`,
  })
  @property({isNetworked: false, minValue: 0.0, maxValue: 50.0})
  public actionMaskFullSpeed: number = 1.0;

  // ===== AnimLayerHost =====

  public animator!: AnimatorComponent;

  public subscribeEvent<T extends EventData>(
    event: IEvent<T>,
    callback: (payload: T) => unknown,
  ): EventSubscription {
    return this.subscribe(event, callback);
  }

  public fireNet(key: string): void {
    if (this.stateReplication) {
      this.stateReplication.trigger(key);
    } else {
      this.dispatchTrigger(key);
    }
  }

  public setNet(key: string, value: ReplicatedValue): void {
    if (this.stateReplication) {
      this.stateReplication.requestState(key, value);
    } else {
      this.dispatchValue(key, value, false);
    }
  }

  public setTag(tag: string, raised: boolean): void {
    const changed = raised ? !this.tags.has(tag) : this.tags.delete(tag);
    if (raised) {
      this.tags.add(tag);
    }
    if (!changed) {
      return;
    }
    // Synchronous, not deferred to the next tick: a layer raising a tag expects its rivals to
    // be back at rest by the time its own next statement runs.
    for (const layer of this.layers) {
      layer.refreshSuppression();
    }
  }

  public hasTag(tag: string): boolean {
    return this.tags.has(tag);
  }

  // ===== Public API: gameplay addresses an intent, never a layer. =====

  /** Play a one-shot action. Unclaimed intents are a no-op. */
  public play(action: string): void {
    this.layersByAction.get(action)?.request();
  }

  /** Cut a one-shot action short. */
  public stop(action: string): void {
    this.layersByAction.get(action)?.interrupt();
  }

  /** Enter or leave a persistent pose. */
  public setLayerActive(action: string, active: boolean): void {
    this.layersByAction.get(action)?.setActive(active);
  }

  public isLayerActive(action: string): boolean {
    return this.layersByAction.get(action)?.isActive ?? false;
  }

  /**
   * Push a per-entity tuning value at the layer serving `action`.
   *
   * A layer is a plain class with no `@property`, so a number that differs between the player
   * and an NPC has to come from the gameplay component that owns it. Call this from an
   * `ExecuteOn.Everywhere` handler — every client must hold the value before the first
   * replicated trigger arrives, because a proxy writes the graph variables itself.
   */
  public tune(action: string, key: string, value: number): void {
    this.layersByAction.get(action)?.tune(key, value);
  }

  // ===== Internals =====

  private readonly layers: AnimLayer[] = createAnimLayers();
  /**
   * Routing tables, derived from the layers at CONSTRUCTION rather than at mount. A gameplay
   * component pushes its tuning from `OnEntityCreateEvent`, which fires before the
   * `OnEntityStartEvent` that mounts the layers — built any later, those values would be
   * routed to an empty table and silently dropped.
   */
  private readonly layersByAction: Map<string, AnimLayer> = indexByAction(this.layers);
  private readonly layersByNetKey: Map<string, AnimLayer[]> = indexByNetKey(this.layers);
  private readonly tags: Set<string> = new Set<string>();

  private stateMachine: CharacterStateMachine | null = null;
  private movementComponent: MovementAbility | null = null;
  private transformComponent: TransformComponent | null = null;
  private characterForceController: CharacterForceControllerBase | null = null;
  private stateReplication: WorldsCharacterStateReplication | null = null;

  /** Remote-only velocity smoother; null on the owner. See the class header. */
  private speedSmoother: CharacterSpeedSmoother | null = null;
  private previousPosition: Vec3 | null = null;

  private warnedMissingSpeed: boolean = false;

  /**
   * True when the character has no MovementAbility, so the locomotion blend comes from
   * observed motion instead — an NPC, moved by behaviours, physics or a scripted path.
   * Resolved in the start handlers rather than `initialize`, because a proxy never runs
   * `initialize` and still has to pick the same path.
   */
  private measuredLocomotion: boolean = false;
  private velocitySamplesX: number[] = [];
  private velocitySamplesZ: number[] = [];
  private velocitySampleIndex: number = 0;
  private measuredPreviousPosition: Vec3 | null = null;

  /**
   * Keys the BASE graph owns. Their replication key IS the graph variable / transition name
   * (a base-graph transition is layerless, so one string carries it), which is why they can be
   * applied here directly. Everything else on the channel belongs to a layer.
   */
  private static readonly baseGraphKeys: ReadonlySet<string> = new Set<string>([
    AnimKey.IS_GROUNDED,
    AnimKey.IS_JUMPING,
    AnimKey.IS_RECENTLY_GROUNDED,
    AnimKey.JUMP_TRIGGER,
  ]);

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  private onEntityStart(): void {
    this.startShared();
  }

  /**
   * Remote (proxy) setup. The owner-side `initialize` / `update` never run here, so a proxy
   * resolves its own animator and transform, builds the smoother, and mounts the same layers —
   * they play from the replication callbacks.
   */
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.NonOwner})
  private onRemoteEntityStart(): void {
    this.transformComponent = this.entity.getComponent(TransformComponent);
    this.speedSmoother = new CharacterSpeedSmoother();
    this.startShared();
  }

  private startShared(): void {
    this.animator = resolveComponentOrThrow(this.entity, this.animatorEntity, AnimatorComponent);
    this.resolveLocomotionSource();
    // Mount BEFORE binding: a layer only receives its host in `attach`, and binding replays
    // the current value snapshot immediately. Bound first, a client joining onto an
    // already-dead character would deliver that snapshot to a layer with no host yet.
    this.mountLayers();
    this.bindStateReplication();
  }

  /**
   * Mount every registered layer. Runs on owner and proxy alike — a proxy plays these layers
   * from the replication callbacks, so it needs the same weights and masks.
   *
   * A layer whose `layerName` is not in the animator's `additionalLayers` throws from
   * `attach`. That throw is the only validation available, since the SDK exposes no way to
   * enumerate configured layers — and it is what turns a misspelled or unmounted layer from
   * "the animation just never plays" into a failure at start.
   */
  private mountLayers(): void {
    for (const layer of this.layers) {
      layer.attach(this);
    }
  }

  /**
   * Resolve the optional replication layer and drive the animator from its callbacks. Replays
   * the current VALUE snapshot once so a late joiner converges; triggers are never replayed.
   */
  private bindStateReplication(): void {
    this.stateReplication = resolveComponent(this.entity, null, WorldsCharacterStateReplication);
    if (!this.stateReplication) {
      return;
    }
    this.stateReplication.addStateListener((key, value) => this.dispatchValue(key, value, false));
    this.stateReplication.addTriggerListener((key) => this.dispatchTrigger(key));
    for (const entry of this.stateReplication.replicatedState) {
      // fromStateEntry reconstructs the JS type from the wire number, so a Bool graph var does
      // not get a numeric 0 at frame 0. `replayed` marks this as a join-time snapshot rather
      // than a live change — a layer holding a persistent pose seeds to its end frame.
      this.dispatchValue(entry.key, fromStateEntry(entry), true);
    }
  }

  /** Apply a replicated value: to the base graph if it owns the key, then to every claimant. */
  private dispatchValue(key: string, value: ReplicatedValue, replayed: boolean): void {
    if (CharacterAnimationController.baseGraphKeys.has(key)) {
      this.animator.setGraphVariable(key, value);
    }
    const claimants = this.layersByNetKey.get(key);
    if (claimants) {
      for (const layer of claimants) {
        layer.onNetValue(key, value, replayed);
      }
    }
  }

  /**
   * Fire a replicated one-shot. Base-graph and layer handling are additive, not exclusive: the
   * jump trigger is a base-graph transition AND the edge the airborne pass starts from, and
   * both need it.
   */
  private dispatchTrigger(key: string): void {
    if (CharacterAnimationController.baseGraphKeys.has(key)) {
      this.animator.requestTransition(key);
    }
    const claimants = this.layersByNetKey.get(key);
    if (claimants) {
      for (const layer of claimants) {
        layer.onNetTrigger(key);
      }
    }
  }

  /** Decide once whether locomotion comes from MovementAbility or from observed motion. */
  private resolveLocomotionSource(): void {
    this.measuredLocomotion = this.entity.getComponent(MovementAbility) == null;
    if (!this.measuredLocomotion) {
      return;
    }
    this.transformComponent ??= this.entity.getComponent(TransformComponent);
    const frames = Math.max(1, Math.floor(this.smoothingFrameCount));
    this.velocitySamplesX = new Array<number>(frames).fill(0);
    this.velocitySamplesZ = new Array<number>(frames).fill(0);
    this.velocitySampleIndex = 0;
    this.measuredPreviousPosition = null;
  }

  public initialize(characterRootEntity: Entity, characterSimulatedEntity: Entity): void {
    this.stateMachine = characterRootEntity.getComponent(CharacterStateMachine);
    this.movementComponent = characterRootEntity.getComponent(MovementAbility);
    this.transformComponent = characterRootEntity.getComponent(TransformComponent);
    // The force controller usually lives on the simulated (physics) entity; fall back to root.
    this.characterForceController =
      characterSimulatedEntity.getComponent(CharacterForceControllerBase) ??
      characterRootEntity.getComponent(CharacterForceControllerBase);

    for (const layer of this.layers) {
      layer.onCharacterReady(characterRootEntity, characterSimulatedEntity);
    }

    // The jump edge goes onto the wire once. The base graph takes it as a transition and any
    // layer that claimed the key takes it too, on every client — this host does not know or
    // care which layers those are.
    this.subscribe(JumpStartedEvent, () => this.fireNet(AnimKey.JUMP_TRIGGER));
  }

  /** Owner-side per-frame, inside the character's ordered update (after physics). */
  public update(): void {
    // Measured mode drives locomotion on every client from the Everywhere handler, so the
    // owner path has nothing to do — including the ordered layer tick, which exists to read
    // this frame's physics and a measured character has none to read.
    if (this.measuredLocomotion) {
      return;
    }
    const state = this.stateMachine?.getCurrentState() ?? StateId.Movement;

    let velocity = Vec3.zero;
    if (this.movementComponent) {
      velocity = this.movementComponent.getDesiredVelocity();
    }
    if (this.characterForceController) {
      const sampledVelocity = this.characterForceController.sampledVelocity;
      const desiredSpeed = velocity.magnitude();
      if (desiredSpeed < 0.01) {
        // No input: fall back to sampled velocity for external forces (knockback, etc.)
        velocity = sampledVelocity;
      } else {
        // Always animate in the direction of the input, but take whichever magnitude is
        // larger so the player still gets feedback when running into a wall.
        const velocityDirection = velocity.normalize();
        const scalarProjection = Math.max(desiredSpeed, sampledVelocity.dot(velocityDirection));
        velocity = velocityDirection.mul(scalarProjection);
      }
    }

    const horizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    // Speed is local on every client, never networked (see the class header).
    this.animator.setGraphVariable(AnimVar.SPEED, horizontalSpeed);
    this.applyBool(AnimKey.IS_GROUNDED, this.stateMachine?.isGrounded() ?? true);
    this.applyBool(
      AnimKey.IS_RECENTLY_GROUNDED,
      this.stateMachine?.isNearlyGrounded(this.groundedThreshold) ?? true,
    );
    this.applyBool(AnimKey.IS_JUMPING, state === StateId.Jumping);
    this.animator.setGraphVariable(
      AnimVar.MOVEMENT_DIRECTION_YAW,
      this.getRelativeMovementYaw(velocity),
    );

    this.ownerTickLayers(horizontalSpeed, 0);
  }

  /**
   * Remote per-frame update (invoked by CharacterUpdateManager on non-owner clients): derive
   * velocity from the proxy's own replicated transform, smooth it, and feed the same two Blend
   * Space 2D inputs the owner feeds. Intentionally NOT run on the owner.
   */
  public remoteUpdate(deltaTime: number): void {
    if (this.measuredLocomotion || !this.speedSmoother || !this.transformComponent) {
      return;
    }
    const currentPosition = this.transformComponent.worldPosition;
    if (this.previousPosition === null || deltaTime <= 0) {
      this.previousPosition = currentPosition;
      return;
    }
    const sampledVelocity = currentPosition.sub(this.previousPosition).mul(1 / deltaTime);
    this.previousPosition = currentPosition;

    this.speedSmoother.update(sampledVelocity);
    const velocity = this.speedSmoother.averagedVelocity;
    this.animator.setGraphVariable(
      AnimVar.SPEED,
      Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z),
    );
    // Without this the Blend Space 2D x input stays at its default 0 on the proxy and every
    // direction collapses to "Walk Fwd" — strafe and back never play.
    this.animator.setGraphVariable(
      AnimVar.MOVEMENT_DIRECTION_YAW,
      this.getRelativeMovementYaw(velocity),
    );
  }

  /** Every client: measured locomotion, then the layers' client-local tick (masks included). */
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onEveryClientUpdate(payload: OnWorldUpdateEventPayload): void {
    if (this.measuredLocomotion) {
      this.driveMeasuredLocomotion(payload.deltaTime);
    }
    this.clientTickLayers(payload.deltaTime);
  }

  private ownerTickLayers(speed: number, deltaTime: number): void {
    const frame: AnimFrame = {deltaTime, speed, maskRamp: this.maskRamp(speed)};
    for (const layer of this.layers) {
      layer.ownerTick(frame);
    }
  }

  /**
   * `speed` is read back off the animator rather than taken from whichever path wrote it, so
   * the mask ramp is identical on owner, proxy and measured characters.
   */
  private clientTickLayers(deltaTime: number): void {
    // An unreadable Speed degrades the mask ramp ONLY. Skipping the tick outright would also
    // stop every layer's onUpdate for the entity's lifetime, which is a far wider blast radius
    // than the value it depends on — no layer should lose its per-frame work because a blend
    // input is missing.
    const speed = this.readSpeed() ?? 0;
    const frame: AnimFrame = {deltaTime, speed, maskRamp: this.maskRamp(speed)};
    for (const layer of this.layers) {
      layer.tick(frame);
    }
  }

  private readSpeed(): number | null {
    const speed = this.animator.getGraphVariable(AnimVar.SPEED);
    if (typeof speed === 'number') {
      return speed;
    }
    if (!this.warnedMissingSpeed) {
      this.warnedMissingSpeed = true;
      // eslint-disable-next-line mhs-linter/no-console-in-update-loop -- latched to fire at most once per entity
      console.warn(
        `[CharacterAnimationController] graph variable '${AnimVar.SPEED}' is not a float; layer mask ramps will read 0`,
      );
    }
    return null;
  }

  /** A zero/negative full-speed collapses the ramp into an on/off step instead of dividing by <= 0. */
  private maskRamp(speed: number): number {
    if (this.actionMaskFullSpeed > 0) {
      return Math.max(0, Math.min(1, speed / this.actionMaskFullSpeed));
    }
    return speed > 0 ? 1 : 0;
  }

  /**
   * Locomotion blend for a character with no MovementAbility. Runs on every client — each one
   * measures the transform it already has, so the blend needs nothing off the wire.
   */
  private driveMeasuredLocomotion(deltaTime: number): void {
    if (!this.transformComponent) {
      return;
    }
    const worldPosition = this.transformComponent.worldPosition;
    if (this.measuredPreviousPosition === null || deltaTime < 0.0001) {
      this.measuredPreviousPosition = worldPosition;
      return;
    }
    const displacement = worldPosition.sub(this.measuredPreviousPosition);
    this.measuredPreviousPosition = worldPosition;

    this.velocitySamplesX[this.velocitySampleIndex] = displacement.x / deltaTime;
    this.velocitySamplesZ[this.velocitySampleIndex] = displacement.z / deltaTime;
    this.velocitySampleIndex = (this.velocitySampleIndex + 1) % this.velocitySamplesX.length;

    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < this.velocitySamplesX.length; i++) {
      sumX += this.velocitySamplesX[i];
      sumZ += this.velocitySamplesZ[i];
    }
    const averageX = sumX / this.velocitySamplesX.length;
    const averageZ = sumZ / this.velocitySamplesZ.length;

    const rawSpeed = Math.sqrt(averageX * averageX + averageZ * averageZ);
    const clampedSpeed = Math.min(rawSpeed, this.maxSpeedClamp);
    const finalSpeed =
      clampedSpeed < this.minSpeedThreshold ? 0 : clampedSpeed * this.speedMultiplier;

    this.animator.setGraphVariable(AnimVar.SPEED, finalSpeed);
    this.animator.setGraphVariable(AnimKey.IS_GROUNDED, true);
    this.animator.setGraphVariable(AnimKey.IS_JUMPING, false);
    this.animator.setGraphVariable(
      AnimVar.MOVEMENT_DIRECTION_YAW,
      this.getRelativeMovementYaw(new Vec3(averageX, 0, averageZ)),
    );
    // A measured character is turned by its own movement controller rather than by look
    // input, so the graph reads direction off MovementDirectionYaw.
    this.animator.setGraphVariable(AnimVar.SHOULD_STRAFE, true);
  }

  /**
   * Apply a networked bool: predict + replicate when a channel is present (its change-check
   * means it only RPCs on an actual transition), else drive the animator directly.
   */
  private applyBool(key: string, value: boolean): void {
    if (this.stateReplication) {
      this.stateReplication.requestState(key, value);
    } else {
      this.animator.setGraphVariable(key, value);
    }
  }

  private getRelativeMovementYaw(worldVelocity: Vec3): number {
    if (!this.transformComponent || worldVelocity.magnitudeSquared() < 0.01) return 0;

    const relativeVelocity = this.transformComponent.worldRotation.inverse().mulVec3(worldVelocity);
    if (relativeVelocity.magnitudeSquared() < 0.01) return 0;

    const moveAngle = Math.atan2(relativeVelocity.x, relativeVelocity.z) * (180 / Math.PI);
    const characterAngle = Math.atan2(Vec3.forward.x, Vec3.forward.z) * (180 / Math.PI);

    let yaw = moveAngle - characterAngle;
    if (yaw > 180) yaw -= 360;
    if (yaw < -180) yaw += 360;
    return yaw;
  }
}

function indexByAction(layers: readonly AnimLayer[]): Map<string, AnimLayer> {
  const byAction = new Map<string, AnimLayer>();
  for (const layer of layers) {
    if (layer.action !== null) {
      byAction.set(layer.action, layer);
    }
  }
  return byAction;
}

function indexByNetKey(layers: readonly AnimLayer[]): Map<string, AnimLayer[]> {
  const byKey = new Map<string, AnimLayer[]>();
  for (const layer of layers) {
    for (const key of layer.netKeys) {
      // Several layers may claim one key — the jump edge starts both the base graph's
      // transition and the airborne pass — so every claimant is kept.
      const claimants = byKey.get(key);
      if (claimants) {
        claimants.push(layer);
      } else {
        byKey.set(key, [layer]);
      }
    }
  }
  return byKey;
}
