/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v1

/**
 * ProjectControlsBridge
 *
 * Component Attachment: PlayerCharacter root entity (client-owned) — the same
 *   entity that carries `CharacterStateMachine`.
 * Component Networking: Local (input is client-only).
 *
 * Project glue, NOT a portable control file: it imports this world's
 * `CharacterStateMachine`, so it lives here rather than in the shipped
 * `building-on-screen-controls` set. Bridges the on-screen controls (driven
 * through `InputActionsManager`) into the durable `CharacterStateMachine` seams:
 *
 * - 'Move' (Axis2D)  -> handleMovementInput(value). The camera-relative
 *   conversion happens downstream in MovementAbility, never here. A zero vector
 *   stops the avatar, so the joystick's release needs no special case.
 * - 'Jump' (Button)  -> handleJumpClick() / handleJumpRelease().
 *
 * The 'Dash' action is still declared on InputActionsManager but is not bridged:
 * CharacterStateMachine has no dash seam, so the HUD button is inert until one
 * is reintroduced.
 *
 * InputActionsManager hides the engine's built-in touch joystick and gameplay
 * controls, so this on-screen path and the built-in keyboard/gamepad path in
 * PlayerActionController drive the same seams without competing on touch clients.
 */

import {
  component,
  Component,
  subscribe,
  ExecuteOn,
  OnEntityStartEvent,
  OnPlayerCreateEvent,
  OnWorldUpdateEvent,
  OnEntityDestroyEvent,
  Vec2,
} from 'meta/worlds';
import type {EventSubscription, Maybe} from 'meta/worlds';
import {
  InputActionsManager,
  InputActionChangeEvent,
} from './InputActionsManager';
import {CharacterStateMachine} from '../Character/State/CharacterStateMachine';
import {CameraManager} from '../Camera/CameraManager';

@component({
  description:
    'Bridges InputActionsManager Move/Jump actions into the character locomotion seams',
})
export class ProjectControlsBridge extends Component {
  private stateMachine: Maybe<CharacterStateMachine> = null;
  private subscriptions: EventSubscription[] = [];
  private wired: boolean = false;

  // PlayerCharacter is client-owned; Owner execution runs on the owning client,
  // which is where input is consumed.
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    this.resolveStateMachine();
    this.wire();
  }

  // The manager singleton or the state machine may not be ready at start; retry
  // once the player exists.
  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Owner})
  onPlayerCreate(): void {
    this.resolveStateMachine();
    this.wire();
  }

  // OnEntityStart/OnPlayerCreate are the fast path, but the scene-resident
  // InputActionsManager singleton is not guaranteed visible from this
  // client-owned template at either moment. Poll every frame until wired so a
  // startup race can never leave the subscription permanently unattached; once
  // wired this early-returns and costs nothing. KEEP this retry loop — a
  // one-shot subscribe silently kills Move/Jump/Dash when the race is lost
  // (D118509248).
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  onUpdate(): void {
    if (this.wired) {
      return;
    }
    this.resolveStateMachine();
    this.wire();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Owner})
  onDestroy(): void {
    for (const sub of this.subscriptions) {
      sub.disconnect();
    }
    this.subscriptions = [];
    this.wired = false;
    // Never leave movement driven after teardown.
    this.stateMachine?.handleMovementInput(Vec2.zero);
  }

  private resolveStateMachine(): void {
    if (this.stateMachine == null) {
      // Mirror PlayerActionController: use this entity's own state machine so
      // each PlayerCharacter instance controls itself.
      this.stateMachine = this.entity.getComponent(CharacterStateMachine);
    }
  }

  private wire(): void {
    if (this.wired) {
      return;
    }
    const manager = InputActionsManager.instance;
    if (manager == null) {
      return;
    }
    // Require the state machine too: once wired latches, onUpdate stops polling
    // resolveStateMachine, so latching before it resolves leaves locomotion dead.
    if (this.stateMachine == null) {
      return;
    }
    this.subscriptions.push(
      manager.subscribeAction('Move', e => this.onMove(e)),
    );
    this.subscriptions.push(
      manager.subscribeAction('Jump', e => this.onJump(e)),
    );
    // Bridge the 'Look' Delta action to CameraManager.addLookDelta(). The
    // subscriber receives (oldAccum, newAccum) — cumulative accumulator values,
    // not per-add deltas — so we extract the per-add delta as new − old.
    // Negate both axes to match CameraManager's sign convention: +X drag →
    // negative yaw (rotate right), +Y drag → negative pitch (look down).
    this.subscriptions.push(
      manager.subscribeAction('Look', e => this.onLook(e)),
    );
    this.wired = true;
    // Runtime wiring signal: absence of this line at play time means the bridge
    // never saw the InputActionsManager singleton (the startup race), so the
    // controls are dead even though the build is clean.
    console.log('[ProjectControlsBridge] Wired Move/Jump/Look');
  }

  private onMove(event: InputActionChangeEvent): void {
    this.stateMachine?.handleMovementInput(event.newValue as Vec2);
  }

  private onJump(event: InputActionChangeEvent): void {
    if (event.newValue as boolean) {
      this.stateMachine?.handleJumpClick();
    } else {
      this.stateMachine?.handleJumpRelease();
    }
  }

  private onLook(event: InputActionChangeEvent): void {
    const oldV = event.oldValue as Vec2;
    const newV = event.newValue as Vec2;
    // Per-add delta extracted from the cumulative accumulator values.
    const dx = newV.x - oldV.x;
    const dy = newV.y - oldV.y;
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
      return;
    }
    // Negate to match CameraManager's convention (see onLookInput in CameraManager).
    CameraManager.get()?.addLookDelta(-dx, -dy);
  }
}
