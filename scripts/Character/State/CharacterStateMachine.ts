/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v2

import {type Entity, component, Vec2} from 'meta/worlds';
import {WorldsGroundInfoComponent} from '../Physics/WorldsGroundInfoComponent';
import {MovementAbility} from '../Abilities/MovementAbility';
import {JumpAbility} from '../Abilities/JumpAbility';
import {AutoFaceRotationAbility} from '../Abilities/AutoFaceRotationAbility';
import {StateMachineBase} from './StateMachineBase';

export const StateId = {
  Movement: 'Movement',
  Jumping: 'Jumping',
  Dead: 'Dead',
} as const;

@component({
  description: 'Character state machine',
})
export class CharacterStateMachine extends StateMachineBase {
  private groundInfo: WorldsGroundInfoComponent | null = null;
  private movement: MovementAbility | null = null;
  private jump: JumpAbility | null = null;
  private rotation: AutoFaceRotationAbility | null = null;

  /**
   * When true, emits debug logs for state transitions.
   * Toggled by test runner via setDebugLogsEnabled().
   */
  public enableDebugLogs: boolean = false;

  public override initialize(characterRootEntity: Entity, characterSimulatedEntity: Entity): void {
    this.groundInfo = characterSimulatedEntity.getComponent(WorldsGroundInfoComponent);
    this.movement = characterRootEntity.getComponent(MovementAbility);
    this.jump = characterRootEntity.getComponent(JumpAbility);
    this.rotation = characterRootEntity.getComponent(AutoFaceRotationAbility);

    if (this.enableDebugLogs) {
      console.log(`[CharacterStateMachine] initialize: jump:${String(!!this.jump)} movement:${String(!!this.movement)}`);
    }

    if (this.movement) this.movement.initialize(characterRootEntity, characterSimulatedEntity);
    if (this.jump) this.jump.initialize(characterRootEntity, characterSimulatedEntity);

    this.registerStates();
    this.setInitialState(StateId.Movement);
  }

  public handleMovementInput(value: Vec2): void {
    this.movement?.setInput(value);
  }

  public handleJumpClick(): void {
    // If we're already in Jumping state but grounded (landing frame before
    // Jumping→Movement transition fires), force-transition to Movement first
    // so the subsequent requestStateChange(Jumping) succeeds.
    // This makes consecutive jumps responsive regardless of update order.
    if (this.getCurrentState() === StateId.Jumping && this.jump?.isGrounded()) {
      this.transitionTo(StateId.Movement);
    }
    this.jump?.recordInput();
    this.requestStateChange(StateId.Jumping);
  }

  public handleJumpRelease(): void {
    this.jump?.abortJump();
  }

  /**
   * Runtime API: enter or leave the incapacitated state, which halts movement, facing and
   * jump.
   *
   * It does NOT drive animation. The death pose is a separate fact on a separate system, and
   * whoever decides a character died raises both — `CharacterGASComponent` does it when health
   * reaches zero. A caller that sets only this leaves the character standing while unable to
   * move.
   */
  public setDead(isDead: boolean): void {
    if (isDead) {
      this.requestStateChange(StateId.Dead);
    } else if (this.isDead()) {
      this.transitionTo(StateId.Movement);
    }
  }

  public isDead(): boolean {
    return this.isInState(StateId.Dead);
  }

  private registerStates(): void {
    this.registerState({
      id: StateId.Movement,
      transitions: [
        // The JumpAbility may enter the jumping state on its own if a buffered jump is activated, this keeps the CharacterStateMachine in sync
        {to: StateId.Jumping, condition: () => (this.jump?.getIsJumping() ?? false)},
      ],
      onUpdate: (dt) => {
        this.movement?.setSpeedMultiplier(1.0);
        this.movement?.update(dt);
        // Update jump to trigger buffered jumps and coyote time
        this.jump?.update();
      },
    });

    this.registerState({
      id: StateId.Jumping,
      allowedFrom: [StateId.Movement],
      transitions: [
        {to: StateId.Movement, condition: () => !(this.jump?.getIsJumping() ?? false)},
      ],
      canEnter: () => {
        return this.jump?.canActivate(Date.now()) ?? false;
      },
      onEnter: () => {
        this.jump?.activate();
      },
      onUpdate: (dt) => {
        this.movement?.update(dt);
        this.jump?.update();
      },
    });

    // No allowedFrom, so it is reachable from Movement and Jumping alike; no transitions,
    // because nothing but an explicit setDead(false) revives a corpse. No onUpdate either:
    // the abilities are suspended by their blocked flags, and gravity still runs in
    // CharacterSimulationController, so a body killed mid-air falls and settles.
    this.registerState({
      id: StateId.Dead,
      transitions: [],
      onEnter: () => {
        this.movement?.stop();
        this.movement?.setMovementBlocked(true);
        this.jump?.setJumpBlocked(true);
        this.rotation?.setRotationBlocked(true);
      },
      onExit: () => {
        this.movement?.setMovementBlocked(false);
        this.jump?.setJumpBlocked(false);
        this.rotation?.setRotationBlocked(false);
      },
    });
  }

  public isGrounded(): boolean {
    return this.groundInfo?.isGrounded ?? true;
  }

  public isNearlyGrounded(groundedThreshold: number): boolean {
    return this.groundInfo?.isNearlyGrounded(groundedThreshold) ?? true;
  }
}
