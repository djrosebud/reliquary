/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {
  Component,
  component,
  editor,
  property,
  subscribe,
  ExecuteOn,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  OnOwnershipTransferEvent,
  PlayerInputService,
  PlayerInputAction,
  PlayerInputState,
  PlayerInputActionCallbackPayload,
  PlayerInputSubscription,
  InputVisualConfigAsset,
  type Maybe,
} from 'meta/worlds';

/**
 * What this component drives. A weapon implements it and registers itself via
 * {@link WeaponInputComponent.bind}, so the input component never imports a
 * weapon type and the same buttons serve any weapon.
 */
export interface TriggerSink {
  pullTrigger(): void;
  releaseTrigger(): void;
  reload(): void;
}

/**
 * The on-screen actions a weapon can bind to, by name. Jump is deliberately
 * absent — locomotion owns it.
 */
const INPUT_ACTIONS: Readonly<Record<string, PlayerInputAction>> = {
  PrimaryLeft: PlayerInputAction.PrimaryLeft,
  PrimaryRight: PlayerInputAction.PrimaryRight,
  SecondaryLeft: PlayerInputAction.SecondaryLeft,
  SecondaryRight: PlayerInputAction.SecondaryRight,
  TertiaryLeft: PlayerInputAction.TertiaryLeft,
  TertiaryRight: PlayerInputAction.TertiaryRight,
  ExtraActionOne: PlayerInputAction.ExtraActionOne,
  ExtraActionTwo: PlayerInputAction.ExtraActionTwo,
  ExtraActionThree: PlayerInputAction.ExtraActionThree,
  ExtraActionFour: PlayerInputAction.ExtraActionFour,
};

/** Legal action names, for warnings and editor descriptions. */
export const INPUT_ACTION_NAMES: readonly string[] = Object.keys(INPUT_ACTIONS);

/**
 * Read a designer-written action name. The editor has no enum property, so an
 * unknown value warns and falls back to `fallback` rather than binding nothing
 * and leaving the button silently dead.
 */
export function parsePlayerInputAction(
  value: string,
  fallback: PlayerInputAction,
): PlayerInputAction {
  const action = INPUT_ACTIONS[value];
  if (action !== undefined) {
    return action;
  }
  console.warn(
    `[Weapon] unknown input action '${value}'; expected one of ` +
      `${INPUT_ACTION_NAMES.join(', ')}. Falling back to the default.`,
  );
  return fallback;
}

/**
 * Binds the on-screen fire / reload buttons to the weapon on this entity.
 * Optional — a weapon without one is driven by game code calling `pullTrigger()`
 * / `reload()`, which is what turrets, NPCs and auto-aim controllers want.
 */
@component({
  description: 'Binds on-screen fire / reload buttons to the weapon on this entity.',
})
export class WeaponInputComponent extends Component {
  @editor({
    description:
      'The .inputconfig asset for the fire button (its icon and screen position). ' +
      'Leave empty and no fire button appears — drive firing from script instead.',
  })
  @property()
  public fireButtonConfig: Maybe<InputVisualConfigAsset> = null;

  @editor({
    description:
      'The .inputconfig asset for the reload button. Leave empty for no reload ' +
      'button; the weapon can still reload from script or via autoReload.',
  })
  @property()
  public reloadButtonConfig: Maybe<InputVisualConfigAsset> = null;

  // The @editor descriptions below are extracted statically — interpolation is
  // not evaluated — so the action names are spelled out rather than read from
  // INPUT_ACTIONS. Keep them in step with that map; the runtime warning is
  // generated from the map and stays correct either way.

  @editor({
    description:
      'Action bound to fire. PrimaryLeft, PrimaryRight, SecondaryLeft, SecondaryRight, ' +
      'TertiaryLeft, TertiaryRight, or ExtraActionOne through ExtraActionFour.',
  })
  @property()
  public fireAction: string = 'PrimaryRight';

  @editor({
    description:
      'Action bound to reload. Same names as fireAction, and must differ from it.',
  })
  @property()
  public reloadAction: string = 'SecondaryRight';

  private sink: TriggerSink | null = null;
  private fireSub: PlayerInputSubscription | null = null;
  private reloadSub: PlayerInputSubscription | null = null;

  /**
   * Register the weapon these buttons drive. Called by the weapon from its own
   * start, so the two may start in either order — whichever runs second binds.
   */
  public bind(sink: TriggerSink): void {
    this.sink = sink;
    this.refreshBindings();
  }

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onEntityStart(): void {
    this.refreshBindings();
  }

  /**
   * Ownership can arrive after start — an entity spawned server-side and handed
   * to a client never sees `isOwned()` true in {@link onEntityStart}, so binding
   * only there would leave that player's buttons dead.
   */
  @subscribe(OnOwnershipTransferEvent, {execution: ExecuteOn.Everywhere})
  onOwnershipTransfer(): void {
    this.refreshBindings();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onEntityDestroy(): void {
    this.unbindInput();
  }

  /**
   * Bind the buttons this client owns. Input is client-local, so bindings exist
   * only while this client owns the entity. Idempotent — safe on every change.
   */
  private refreshBindings(): void {
    if (!this.sink || !this.entity.isOwned()) {
      this.unbindInput();
      return;
    }
    const input = PlayerInputService.get();
    const fireAction = parsePlayerInputAction(this.fireAction, PlayerInputAction.PrimaryRight);
    const reloadAction = parsePlayerInputAction(
      this.reloadAction,
      PlayerInputAction.SecondaryRight,
    );

    // One action cannot drive two subscriptions; the second would shadow the
    // first and the weapon would reload every time it fired.
    if (fireAction === reloadAction) {
      console.error(
        `[Weapon] fireAction and reloadAction are both '${this.fireAction}'. ` +
          'Reload is not bound; give them different actions.',
      );
    }

    if (!this.fireSub && this.fireButtonConfig) {
      this.fireSub = input.subscribePlayerInputAction(
        this,
        fireAction,
        (payload: PlayerInputActionCallbackPayload) => {
          if (payload.inputState === PlayerInputState.Pressed) {
            this.sink?.pullTrigger();
          } else if (payload.inputState === PlayerInputState.Released) {
            this.sink?.releaseTrigger();
          }
        },
        this.fireButtonConfig,
      );
    }
    if (!this.reloadSub && this.reloadButtonConfig && reloadAction !== fireAction) {
      this.reloadSub = input.subscribePlayerInputAction(
        this,
        reloadAction,
        (payload: PlayerInputActionCallbackPayload) => {
          if (payload.inputState === PlayerInputState.Pressed) {
            this.sink?.reload();
          }
        },
        this.reloadButtonConfig,
      );
    }
  }

  /**
   * Drop the bindings and release the trigger — no Released event arrives once
   * the buttons are gone, so an auto weapon would otherwise fire forever.
   */
  private unbindInput(): void {
    this.fireSub?.disconnect();
    this.fireSub = null;
    this.reloadSub?.disconnect();
    this.reloadSub = null;
    this.sink?.releaseTrigger();
  }
}
