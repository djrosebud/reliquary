/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import type {Entity} from 'meta/worlds';
import {AnimLayer, type AnimFrame} from './AnimLayer';
import {AnimKey} from '../AnimKey';
import {CharacterForceControllerBase} from '../../Character/Force/CharacterForceControllerBase';
import {WorldsGroundInfoComponent} from '../../Character/Physics/WorldsGroundInfoComponent';
import {CharacterStateMachine, StateId} from '../../Character/State/CharacterStateMachine';

/**
 * The jump → in-air → landing pass.
 *
 * This is the shape of layer that a name table cannot express, and the reason {@link AnimLayer}
 * is a class rather than a config row: the layer runs its own state machine off a `TimeTillLand`
 * value that nothing in the engine produces, so the script has to predict touchdown from the
 * projectile equation each frame and hand it over. None of that is a name.
 *
 * It therefore reads the physics simulation directly, which is why it uses
 * {@link AnimLayer.onOwnerUpdate} — that hook runs inside the character's ordered update, after
 * ground detection and force integration, so the sampled velocity and ground distance it reads
 * are this frame's.
 *
 * STATES IN THE AUTHORED GRAPH. Script names only two of them; the layer walks the rest by
 * itself off the two variables below:
 *
 *   `empty state` --JumpTrigger--> `jump state` --> `inAir state` --> `landing state` --> `empty state`
 *                                                     ^ Jumping            ^ TimeTillLand < 0.1
 *                                                                            AND Speed < 0.5
 *
 * That `Speed < 0.5` on the last hop is why {@link maybeRelease} exists: a running landing
 * never satisfies it, so the layer would hold `inAir state` over locomotion forever.
 */
export class AirborneLayer extends AnimLayer {
  readonly layerName: string = 'Airborne_Layer';
  readonly restState: string = 'empty state';

  public override get netKeys(): readonly string[] {
    // The base graph's jump trigger, claimed rather than re-broadcast: the host applies it to
    // the base graph AND hands it to every layer that asks, so the airborne pass starts from
    // the same replicated edge on every client instead of only where the jump was pressed.
    return [AnimKey.JUMP_TRIGGER];
  }

  /** Predicted seconds-to-touchdown above which the graph is told "still falling". */
  private readonly maxTimeTillLandSeconds: number = 3.0;
  private readonly gravityMetersPerSecondSquared: number = 9.81;
  /**
   * Seconds after launch during which TimeTillLand is pinned above the graph's landing
   * threshold. On the launch frame the sampled velocity has not ticked and ground distance is
   * still ~0, which would otherwise read as an immediate landing.
   */
  private readonly minAirborneDurationSeconds: number = 0.3;
  /**
   * Horizontal speed above which a grounded character is forced back to rest. The graph's
   * `inAir -> landing` transition requires `Speed < 0.5`, so a running jump would stick in
   * `inAir state` on landing; this is the escape hatch.
   */
  private readonly exitSpeedThreshold: number = 0.5;

  private stateMachine: CharacterStateMachine | null = null;
  private forceController: CharacterForceControllerBase | null = null;
  private groundInfo: WorldsGroundInfoComponent | null = null;

  /** Wall-clock ms at the last launch, for the grace window above. */
  private lastJumpTimeMs: number = -1;
  /** Edge-detects the force-release request so the transition fires once per landing. */
  private releaseRequested: boolean = false;

  public override onCharacterReady(
    characterRootEntity: Entity,
    characterSimulatedEntity: Entity,
  ): void {
    this.stateMachine = characterRootEntity.getComponent(CharacterStateMachine);
    // Both usually live on the simulated (KCC) child; fall back to the root.
    this.forceController =
      characterSimulatedEntity.getComponent(CharacterForceControllerBase) ??
      characterRootEntity.getComponent(CharacterForceControllerBase);
    this.groundInfo =
      characterSimulatedEntity.getComponent(WorldsGroundInfoComponent) ??
      characterRootEntity.getComponent(WorldsGroundInfoComponent);
  }

  public override onNetTrigger(key: string): void {
    if (key !== AnimKey.JUMP_TRIGGER) {
      return;
    }
    // The base graph's JumpTrigger event does not route into an additional layer's state
    // machine, so the `empty state -> jump state` path has to be taken explicitly.
    this.play('jump state');
    this.lastJumpTimeMs = Date.now();
    this.releaseRequested = false;
  }

  protected override onOwnerUpdate(frame: AnimFrame): void {
    const state = this.stateMachine?.getCurrentState() ?? StateId.Movement;
    const isGrounded = this.stateMachine?.isGrounded() ?? true;

    // This layer declares its own `Jumping`, which is NOT the base graph's `IsJumping` — a
    // different variable of a different name on a different graph.
    this.setVar('Jumping', state === StateId.Jumping);
    this.setVar('TimeTillLand', this.computeTimeTillLandSeconds(isGrounded));
    this.maybeRelease(isGrounded, frame.speed);
  }

  /**
   * Predicted seconds until touchdown, from `d = -v·t + 0.5·g·t²` solved for t, with v the
   * current vertical velocity (up positive), g the gravity magnitude, and d the distance from
   * feet to the ground directly below. Returns 0 when grounded so the layer's landing
   * threshold (< 0.1) trips at touchdown, and clamps to {@link maxTimeTillLandSeconds} when no
   * ground is within cast range so the graph never sees an unbounded countdown.
   */
  private computeTimeTillLandSeconds(isGrounded: boolean): number {
    const msSinceJump = this.lastJumpTimeMs < 0 ? Infinity : Date.now() - this.lastJumpTimeMs;
    const inLaunchGrace = msSinceJump < this.minAirborneDurationSeconds * 1000;
    if (isGrounded && !inLaunchGrace) {
      return 0;
    }
    const g = this.gravityMetersPerSecondSquared;
    if (g <= 0 || !this.groundInfo || !this.forceController) {
      return this.maxTimeTillLandSeconds;
    }
    const d = this.groundInfo.groundDistance;
    const v = this.forceController.sampledVelocity.y;
    const t = (v + Math.sqrt(v * v + 2 * g * d)) / g;
    const bounded = Number.isFinite(t)
      ? Math.min(Math.max(0, t), this.maxTimeTillLandSeconds)
      : this.maxTimeTillLandSeconds;
    return inLaunchGrace ? Math.max(bounded, this.maxTimeTillLandSeconds) : bounded;
  }

  /**
   * On the ground and running faster than the graph's landing threshold allows, force the
   * layer back to rest so a running landing does not leave the airborne pose stuck on top of
   * locomotion. Edge-detected so the transition is issued once per landing.
   */
  private maybeRelease(isGrounded: boolean, horizontalSpeed: number): void {
    const shouldRelease = isGrounded && horizontalSpeed > this.exitSpeedThreshold;
    if (shouldRelease === this.releaseRequested) {
      return;
    }
    this.releaseRequested = shouldRelease;
    if (shouldRelease) {
      this.rest();
    }
  }
}
