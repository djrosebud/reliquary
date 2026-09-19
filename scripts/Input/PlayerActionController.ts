/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v3

/**
 * PlayerActionController
 *
 * Component Attachment: a scene service entity (`PlayerInputServices` in space.hstf)
 * Component Networking: Everywhere — each client binds to its own local player
 *   and ignores the server context, so the callbacks only ever reach a character
 *   that client owns.
 *
 * The ENGINE input surface: every `PlayerInputAction` is declared once in
 * {@link defineActions} and subscribed here. This component owns no gameplay
 * state of its own, it resolves the components that do and routes presses to
 * them.
 *
 * It is not the only input surface. On-screen touch controls publish through
 * `InputActionsManager` and reach the character via `ProjectControlsBridge`;
 * both paths write the same latched movement input, so the engine axis yields
 * when another source is steering (see {@link engineAxisYields}).
 *
 * WHY THIS LIVES IN THE SCENE, NOT ON THE CHARACTER:
 *   Input outlives any one character. Hosted on the PlayerCharacter template
 *   this component was created and destroyed with the body, so every
 *   subscription was torn down and rebuilt on each respawn. On a scene service
 *   entity the subscriptions are made once at world load and simply re-point at
 *   whatever character the local player currently has.
 *
 *   The cost is that ONE component drives ONE character. Extra spawned
 *   characters get no input; that is the intended trade — they are dummies.
 *
 * WHAT THE TEMPLATE BINDS
 *
 * Movement and jump. That is the whole shipped surface. Movement always works —
 * the axis subscription needs no config asset — and jump binds because
 * `JumpInputConfig.inputconfig` is assigned on the scene entity.
 *
 * To add an action: add a row to {@link defineActions}, add a matching
 * `*InputConfig` property, author an `.inputconfig` asset and assign it. An
 * action whose property is left unassigned is skipped, so a row costs nothing
 * until it is wired up. The engine permits a single subscriber per action
 * (T216638120), which is why every binding is declared in this one table rather
 * than spread across components that would silently contend for the same action.
 */

import {
  Component,
  component,
  editor,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  OnPlayerCreateEvent,
  OnPlayerCreateEventPayload,
  OnPlayerDestroyEvent,
  OnPlayerDestroyEventPayload,
  NetworkingService,
  ExecuteOn,
  PlayerInputService,
  PlayerInputAction,
  PlayerInputAxis,
  PlayerInputState,
  PlayerInputActionCallbackPayload,
  PlayerInputAxisCallbackPayload,
  PlayerInputSubscription,
  InputVisualConfigAsset,
  property,
  Vec2,
  type Entity,
  type Maybe,
} from 'meta/worlds';
import {InputActionsManager} from './InputActionsManager';
import {CharacterStateMachine} from '../Character/State/CharacterStateMachine';
import {WeaponMeleeComponent} from '../gas/weapons/melee/WeaponMeleeComponent';
import {
  JumpClickEvent,
  JumpReleaseEvent,
} from '../Character/State/ActionEvents';

/**
 * One row of the action table: the engine action, the config asset that gives it
 * an on-screen button, and what to do with its state changes.
 */
type ActionBinding = {
  /** Used only in the log line when a binding is skipped. */
  label: string;
  action: PlayerInputAction;
  config: Maybe<InputVisualConfigAsset>;
  onState: (state: PlayerInputState) => void;
};

@component({
  description:
    'Engine input bindings: subscribes movement and jump and routes them to the character state machine. On-screen touch controls are a separate surface.',
})
export class PlayerActionController extends Component {
  @editor({
    description: `Jump button config (.inputconfig). Leave unassigned to ship without a jump button.`,
  })
  @property()
  jumpInputConfig: Maybe<InputVisualConfigAsset> = null;

  @editor({
    description: `Melee attack button config (.inputconfig). Unassigned by default; assign MeleeAttackInputConfig to put the button on screen.`,
  })
  @property()
  meleeInputConfig: Maybe<InputVisualConfigAsset> = null;

  private stateMachine: CharacterStateMachine | null = null;
  private meleeWeapon: WeaponMeleeComponent | null = null;
  private subscriptions: PlayerInputSubscription[] = [];

  /**
   * Subscribe every binding once, at world load. These are player-input
   * subscriptions rather than character ones, so they outlive any single body;
   * the handlers read the resolved state machine, which is null until a local
   * player exists and null again once it is gone, making every callback a no-op
   * in between.
   *
   * Skipped in the server context, which has no local player to drive.
   */
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    if (NetworkingService.get().isServerContext()) {
      return;
    }

    for (const binding of this.defineActions()) {
      this.bind(binding);
    }

    // Movement is the one action with no config asset — the axis subscription
    // has no on-screen button to configure, so it always binds.
    this.subscriptions.push(
      PlayerInputService.get().subscribePlayerInputAxis(
        this,
        PlayerInputAxis.Left,
        (payload: PlayerInputAxisCallbackPayload) => {
          if (this.engineAxisYields(payload.value)) {
            return;
          }
          this.stateMachine?.handleMovementInput(payload.value);
        },
      ),
    );
  }

  /**
   * Whether the engine axis should stand down for this value.
   *
   * `MovementAbility.setInput` latches, so a zero from an idle engine axis
   * overwrites a live value published by the touch joystick or by
   * click-to-move steering. A non-zero engine value always wins; a zero only
   * reaches the character when no other source is steering.
   */
  private engineAxisYields(value: Vec2): boolean {
    if (value.x !== 0 || value.y !== 0) {
      return false;
    }
    const actions = InputActionsManager.instance;
    if (actions == null) {
      return false;
    }
    if (actions.isPressed('ClickToMove')) {
      return true;
    }
    const move = actions.getAxis2D('Move');
    return move.x !== 0 || move.y !== 0;
  }

  /**
   * Point input at the local player's character. Gated on `isLocal` so a remote
   * player spawning on this client does not steal the bindings, and on the
   * server context, which drives no input.
   */
  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  onPlayerCreate(payload: OnPlayerCreateEventPayload): void {
    if (NetworkingService.get().isServerContext() || !payload.isLocal) {
      return;
    }
    const playerEntity: Maybe<Entity> = payload.entity;
    if (!playerEntity) {
      console.error(
        '[PlayerActionController] OnPlayerCreateEvent carried no local entity; input will be a no-op.',
      );
      return;
    }
    // Optional: without a melee weapon the button still binds, it just has
    // nothing to swing.
    this.meleeWeapon = playerEntity.getComponent(WeaponMeleeComponent);
    this.stateMachine = playerEntity.getComponent(CharacterStateMachine);
    if (!this.stateMachine) {
      console.warn(
        '[PlayerActionController] CharacterStateMachine not found on the local player; movement and jump will be no-ops.',
      );
    }
  }

  /**
   * Drop the character on despawn. Without this the handlers would keep calling
   * into a destroyed entity's components until the next spawn replaced them.
   */
  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    if (!payload.isLocal) {
      return;
    }
    this.stateMachine = null;
    this.meleeWeapon = null;
  }

  /**
   * Every button the character binds, one row each. This is THE place to add a
   * new action: add a row, add the matching `*InputConfig` property above, and
   * assign the asset on the scene entity.
   */
  private defineActions(): ActionBinding[] {
    return [
      {
        label: 'jump',
        action: PlayerInputAction.Jump,
        config: this.jumpInputConfig,
        onState: state => {
          if (state === PlayerInputState.Pressed) {
            this.stateMachine?.handleJumpClick();
          } else if (state === PlayerInputState.Released) {
            this.stateMachine?.handleJumpRelease();
          }
        },
      },
      {
        label: 'melee',
        action: PlayerInputAction.ExtraActionOne,
        config: this.meleeInputConfig,
        onState: state => {
          // The weapon owns pacing, animation and damage.
          if (state === PlayerInputState.Pressed) {
            this.meleeWeapon?.pullTrigger();
          } else {
            this.meleeWeapon?.releaseTrigger();
          }
        },
      },
    ];
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    for (const sub of this.subscriptions) {
      sub.disconnect();
    }
    this.subscriptions = [];
  }

  /**
   * Subscribe one row of the action table. The stable API requires a config
   * asset, so an unassigned property means the action is skipped entirely.
   */
  private bind(binding: ActionBinding): void {
    if (!binding.config) {
      console.log(
        `[PlayerActionController] ${binding.label}: no inputconfig assigned, not bound`,
      );
      return;
    }
    this.subscriptions.push(
      PlayerInputService.get().subscribePlayerInputAction(
        this,
        binding.action,
        (payload: PlayerInputActionCallbackPayload) => {
          binding.onState(payload.inputState);
        },
        binding.config,
      ),
    );
  }

  // --- Legacy UiEvent handlers (custom-HUD wiring / backward compatibility) ---
  @subscribe(JumpClickEvent)
  onJumpClick(): void {
    this.stateMachine?.handleJumpClick();
  }

  @subscribe(JumpReleaseEvent)
  onJumpRelease(): void {
    this.stateMachine?.handleJumpRelease();
  }
}
