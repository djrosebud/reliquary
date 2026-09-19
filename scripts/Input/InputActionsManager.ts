/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v1

import {
  component,
  Component,
  NetworkingService,
  subscribe,
  ExecuteOn,
  OnEntityCreateEvent,
  OnEntityDestroyEvent,
  OnLateWorldUpdateEvent,
  PlayerInputService,
  Vec2,
} from 'meta/worlds';
import type {EventSubscription, Maybe} from 'meta/worlds';

// ============================================================================
// Inlined input-action types (self-contained — no experimental/provisional deps)
// ============================================================================

/** The data type of an input action. */
export enum ActionType {
  /** Boolean value: pressed or released. */
  Button = 0,
  /** Single float value (e.g. a trigger/throttle). */
  Axis = 1,
  /** Two-axis float value (e.g. a virtual joystick). */
  Axis2D = 2,
  /**
   * Two-axis relative delta (e.g. a look/drag). Accumulated within a frame and
   * auto-zeroed each frame.
   */
  Delta = 3,
}

/** The value type carried by an {@link InputActionChangeEvent}. */
export type InputActionValue = boolean | number | Vec2;

/** Rich payload delivered to subscribers when an action's state changes. */
export class InputActionChangeEvent {
  /** Name of the action that changed. */
  readonly actionName: string;
  /** Data type of the action. */
  readonly actionType: ActionType;
  /** Value before the change. */
  readonly oldValue: InputActionValue;
  /** Value after the change. */
  readonly newValue: InputActionValue;

  constructor(
    actionName: string,
    actionType: ActionType,
    oldValue: InputActionValue,
    newValue: InputActionValue,
  ) {
    this.actionName = actionName;
    this.actionType = actionType;
    this.oldValue = oldValue;
    this.newValue = newValue;
  }
}

/** Callback signature for input-action subscriptions. */
export type InputActionCallback = (event: InputActionChangeEvent) => void;

// ============================================================================
// Internal state types
// ============================================================================

type ActionRecord = {
  type: ActionType;
  currentValue: InputActionValue;
  // Delta only: this-frame accumulator. Delta input adds into `deltaAccum`;
  // `onLateWorldUpdate` publishes it into `currentValue` (what getActionDelta
  // returns) and clears it. Consumers therefore read the value published at the
  // previous late-update, which is stable for the whole frame, so a camera that
  // must poll `Look` in OnLateWorldUpdate (following a post-physics target) reads
  // a non-zero delta instead of racing the reset. Unused for non-Delta actions.
  deltaAccum: Vec2;
};

type InputActionSubscriberEntry = {
  id: number;
  callback: InputActionCallback;
};

function defaultValueForType(type: ActionType): InputActionValue {
  switch (type) {
    case ActionType.Button:
      return false;
    case ActionType.Axis:
      return 0;
    case ActionType.Axis2D:
      return new Vec2(0, 0);
    case ActionType.Delta:
      return new Vec2(0, 0);
    default:
      // Fail loud on an unhandled ActionType rather than returning undefined,
      // which would poison currentValue and every downstream cast.
      // `type` narrows to `never` here, so widen it for the template literal.
      console.error(`InputActionsManager: unknown ActionType ${type as number}`);
      return false;
  }
}

// ============================================================================
// InputActionsManager — mandatory singleton pub/sub input-action bus
// ============================================================================

/**
 * Pure-TypeScript pub/sub bus for custom, string-keyed input actions.
 *
 * The on-screen HUD (`TouchControlsHud`), the `TouchJoystick`, and the
 * `TouchCameraLook` drive this bus; game and camera code subscribe to named
 * actions to react. There is no gamepad or native binding here — actions are
 * driven programmatically (by the HUD, joystick, camera-look, AI, or tests) and
 * observed via {@link subscribeAction}.
 *
 * Access the singleton anywhere via `InputActionsManager.instance`, e.g.
 * `InputActionsManager.instance?.isPressed('Jump')`.
 */
@component()
export class InputActionsManager extends Component {
  /** Global access point to the single manager instance. */
  public static instance: Maybe<InputActionsManager> = null;

  private inputActions: Map<string, ActionRecord> = new Map();
  private inputActionSubscribers: Map<string, InputActionSubscriberEntry[]> =
    new Map();
  private nextInputActionSubscriptionId: number = 0;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityCreateEvent)
  onCreate(): void {
    InputActionsManager.instance = this;
    this.defineActions();

    // The custom controls replace the engine's built-in touch controls, so hide
    // them. These are the stable/durable PlayerInputService methods
    // (client-only — no-op on server and VR).
    if (NetworkingService.get().isPlayerContext()) {
      PlayerInputService.get().setJoystickVisible(false);
      PlayerInputService.get().setGameplayControlsVisible(false);
    }
  }

  @subscribe(OnEntityDestroyEvent)
  onDestroy(): void {
    this.inputActionSubscribers.clear();
    this.inputActions.clear();
    InputActionsManager.instance = null;

    // Restore the built-in controls so tearing down the manager doesn't leave
    // the engine controls suppressed.
    if (NetworkingService.get().isPlayerContext()) {
      PlayerInputService.get().setJoystickVisible(true);
      PlayerInputService.get().setGameplayControlsVisible(true);
    }
  }

  @subscribe(OnLateWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onLateWorldUpdate(): void {
    // Publish each Delta action's this-frame accumulator into currentValue (what
    // getActionDelta returns) and clear the accumulator. Publishing here rather
    // than zeroing currentValue means a consumer polling getActionDelta reads the
    // value published at the PREVIOUS late-update, which stays stable for the
    // whole frame. So a consumer that must poll in OnLateWorldUpdate (e.g. a
    // camera orbiting a post-physics target) reads a non-zero delta regardless of
    // whether it runs before or after this handler, instead of racing a reset
    // that zeroed the value it was about to read. Subscribers are notified on each
    // add, not on this per-frame publish.
    for (const record of this.inputActions.values()) {
      if (record.type === ActionType.Delta) {
        record.currentValue = record.deltaAccum;
        // Fresh Vec2, not an in-place zero: currentValue now aliases the old
        // accumulator, so zeroing in place would wipe the just-published value.
        // WHY the lint suppression: the per-frame allocation is load-bearing —
        // reusing/pooling the instance would mutate the value consumers just
        // read from getActionDelta. It is one Vec2 per Delta action per frame.
        // eslint-disable-next-line mhs-linter/no-allocation-in-update-loop
        record.deltaAccum = new Vec2(0, 0);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Action definitions — THE place to add a new game action
  // --------------------------------------------------------------------------

  /**
   * Every game action is declared here, one line each. Adding a new action is
   * as simple as adding another `this.defineAction(...)` line. The default set
   * below matches the controls shipped with this skill: the TouchJoystick
   * (`Move`), the TouchCameraLook (`Look`), and the TouchControlsHud buttons
   * (`Jump`, `Dash`).
   */
  private defineActions(): void {
    // Movement vector driven by the TouchJoystick (floating analog stick).
    this.defineAction('Move', ActionType.Axis2D);

    // Per-frame look delta driven by the TouchCameraLook drag. Delta actions
    // accumulate within a frame and auto-zero each frame (see the
    // OnLateWorldUpdateEvent reset below).
    this.defineAction('Look', ActionType.Delta);

    // On-screen HUD buttons.
    this.defineAction('Jump', ActionType.Button);
    this.defineAction('Dash', ActionType.Button);

    // Contextual button shown by InteractionControlsBridge only while the
    // interactor has a WSDK candidate.
    this.defineAction('Interact', ActionType.Button);

    // Contextual button shown by AttachableControlsBridge only while the local
    // player holds a droppable AttachableObject.
    this.defineAction('Drop', ActionType.Button);

    // True while ClickToMoveController is actively steering the character along
    // a path. Other input sources (e.g. PlayerActionController axis) can check
    // this to avoid fighting click-to-move steering.
    this.defineAction('ClickToMove', ActionType.Button);

    // Add more actions here — one line per action:
    // this.defineAction('PrimaryAction', ActionType.Button);
    // this.defineAction('Sprint', ActionType.Button);
    // this.defineAction('Throttle', ActionType.Axis);
  }

  /** Create or update a named action, seeding its default value for the type. */
  public defineAction(name: string, type: ActionType): void {
    const existing = this.inputActions.get(name);
    if (existing != null) {
      const typeChanged = existing.type !== type;
      existing.type = type;
      if (typeChanged) {
        existing.currentValue = defaultValueForType(type);
        // Clear the accumulator too, or a stale delta from a prior Delta
        // lifetime would publish on the next late-update after a retype.
        existing.deltaAccum = new Vec2(0, 0);
      }
    } else {
      this.inputActions.set(name, {
        type,
        currentValue: defaultValueForType(type),
        deltaAccum: new Vec2(0, 0),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Subscribe
  // --------------------------------------------------------------------------

  /**
   * Register a callback fired whenever the named action's value changes.
   * @returns A handle with a `disconnect()` method — call it in `onDestroy()`.
   */
  public subscribeAction(
    name: string,
    callback: InputActionCallback,
  ): EventSubscription {
    const id = this.nextInputActionSubscriptionId;
    this.nextInputActionSubscriptionId += 1;

    let entries = this.inputActionSubscribers.get(name);
    if (entries == null) {
      entries = [];
      this.inputActionSubscribers.set(name, entries);
    }
    entries.push({id, callback});

    return {
      disconnect: () => {
        const list = this.inputActionSubscribers.get(name);
        if (list == null) {
          return;
        }
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === id) {
            list.splice(i, 1);
            break;
          }
        }
      },
    };
  }

  // --------------------------------------------------------------------------
  // State setters
  // --------------------------------------------------------------------------

  public setButtonState(name: string, pressed: boolean): void {
    const record = this.validateInputAction(name, ActionType.Button);
    if (record == null) {
      return;
    }
    const oldValue = record.currentValue;
    record.currentValue = pressed;
    this.notifyInputActionSubscribers(name, record, oldValue, pressed);
  }

  public setAxisValue(name: string, value: number): void {
    const record = this.validateInputAction(name, ActionType.Axis);
    if (record == null) {
      return;
    }
    const oldValue = record.currentValue;
    record.currentValue = value;
    this.notifyInputActionSubscribers(name, record, oldValue, value);
  }

  public setAxis2DValue(name: string, value: Vec2): void {
    const record = this.validateInputAction(name, ActionType.Axis2D);
    if (record == null) {
      return;
    }
    const oldValue = record.currentValue;
    // Clone the incoming Vec2 so a caller reusing one Vec2 instance across
    // frames cannot retro-mutate the stored oldValue and defeat edge-triggers.
    const newValue = new Vec2(value.x, value.y);
    record.currentValue = newValue;
    this.notifyInputActionSubscribers(name, record, oldValue, newValue);
  }

  /**
   * Accumulate a relative delta onto a Delta action for the current frame. The
   * accumulator is published into currentValue and cleared in `onLateWorldUpdate`,
   * so getActionDelta returns a value stable for the whole frame (see that
   * handler). Subscribers are notified with the pre-add and post-add accumulated
   * values.
   */
  public addActionDelta(name: string, v: Vec2): void {
    const record = this.validateInputAction(name, ActionType.Delta);
    if (record == null) {
      return;
    }
    const oldAccum = record.deltaAccum;
    // Fresh Vec2 so subscribers get distinct old/new; mutating in place would
    // alias the two and defeat edge-trigger/smoothing logic.
    const newAccum = new Vec2(oldAccum.x + v.x, oldAccum.y + v.y);
    record.deltaAccum = newAccum;
    this.notifyInputActionSubscribers(name, record, oldAccum, newAccum);
  }

  /** Press + release pulse — use for tap-style, on-press buttons. */
  public triggerInputAction(name: string): void {
    const record = this.validateInputAction(name, ActionType.Button);
    if (record == null) {
      return;
    }
    this.setButtonState(name, true);
    this.setButtonState(name, false);
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  public isPressed(name: string): boolean {
    const record = this.validateInputAction(name, ActionType.Button);
    return record == null ? false : (record.currentValue as boolean);
  }

  public getAxis(name: string): number {
    const record = this.validateInputAction(name, ActionType.Axis);
    return record == null ? 0 : (record.currentValue as number);
  }

  public getAxis2D(name: string): Vec2 {
    const record = this.validateInputAction(name, ActionType.Axis2D);
    return record == null ? new Vec2(0, 0) : (record.currentValue as Vec2);
  }

  /** Read the delta accumulated so far this frame on a Delta action. */
  public getActionDelta(name: string): Vec2 {
    const record = this.validateInputAction(name, ActionType.Delta);
    return record == null ? new Vec2(0, 0) : (record.currentValue as Vec2);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  // Actions already warned about, so a per-frame consumer polling a misnamed or
  // mistyped action logs once rather than 60x/second.
  private warnedActions: Set<string> = new Set();

  private warnOnce(key: string, message: string): void {
    if (this.warnedActions.has(key)) {
      return;
    }
    this.warnedActions.add(key);
    console.error(message);
  }

  private validateInputAction(
    name: string,
    expectedType: ActionType,
  ): ActionRecord | undefined {
    const record = this.inputActions.get(name);
    if (record == null) {
      this.warnOnce(
        `undef:${name}`,
        `InputActionsManager: action '${name}' has not been defined`,
      );
      return undefined;
    }
    if (record.type !== expectedType) {
      this.warnOnce(
        `type:${name}:${expectedType}`,
        `InputActionsManager: action '${name}' is type ${ActionType[record.type]}, expected ${ActionType[expectedType]}`,
      );
      return undefined;
    }
    return record;
  }

  private notifyInputActionSubscribers(
    name: string,
    record: ActionRecord,
    oldValue: InputActionValue,
    newValue: InputActionValue,
  ): void {
    const entries = this.inputActionSubscribers.get(name);
    if (entries == null || entries.length === 0) {
      return;
    }
    // Snapshot the subscriber list once so a callback that subscribes or
    // disconnects mid-dispatch cannot shift indices out from under the loop. For
    // each snapshotted entry, re-check the live list by id: an entry disconnected
    // earlier in this same dispatch is skipped (not invoked), and none are
    // skipped by a splice-induced index shift.
    const list = entries.slice();
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      const live = this.inputActionSubscribers.get(name);
      if (live == null || !live.some(e => e.id === entry.id)) {
        continue;
      }
      entry.callback(
        new InputActionChangeEvent(name, record.type, oldValue, newValue),
      );
    }
  }
}
