/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Locomotion Scripts v3

/**
 * LocomotionSettingsComponent
 *
 * Component Attachment: a scene service entity (`PlayerInputServices` in space.hstf),
 *   beside the controllers it gates
 * Component Networking: Everywhere — the mode is a per-client setting
 *
 * Exposes a single editor-tunable enum dropdown to select the locomotion
 * mode: Joystick only or ClickToMove only. At runtime the component
 * reads the value once on start and configures the locomotion systems.
 */

import {
  Component,
  component,
  property,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
  NetworkingService,
  PlayerInputService,
} from 'meta/worlds';
import {ClickToMoveController} from './ClickToMoveController';
import {InputActionsManager} from '../Input/InputActionsManager';

/** Locomotion input mode exposed as a dropdown in the Properties panel. */
export enum LocomotionMode {
  Joystick = 0,
  ClickToMove = 1,
}

@component({
  description:
    'Editor-configurable locomotion settings. Exposes a LocomotionMode dropdown in the Properties panel.',
})
export class LocomotionSettingsComponent extends Component {
  /** Select which locomotion input method is active. */
  @property()
  locomotionMode: LocomotionMode = LocomotionMode.Joystick;

  // Attached to the scene's PlayerInputServices entity alongside the controllers
  // it gates. Runs on every client, which is where input services live and where
  // the mode has to apply.
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    // PlayerInputService.setJoystickVisible() is client-only; skip on server.
    if (NetworkingService.get().isServerContext()) {
      return;
    }

    const enableJoystick =
      this.locomotionMode === LocomotionMode.Joystick;
    const enableClickToMove =
      this.locomotionMode === LocomotionMode.ClickToMove;

    console.log(
      `[LocomotionSettingsComponent] Applying mode=${LocomotionMode[this.locomotionMode]}` +
        ` — joystick=${String(enableJoystick)}, clickToMove=${String(enableClickToMove)}`,
    );

    // --- Joystick ---
    // setJoystickVisible(false) is sticky: forces joystick hidden until true
    // releases it. Explicitly set the engine joystick to its final desired
    // visibility so any prior hide-lock is properly released.
    // When the custom touch control system (InputActionsManager) is active it
    // provides its own TouchJoystick, so the engine's built-in joystick must stay
    // hidden even in Joystick mode — otherwise two joysticks would render at once.
    // The `customControlsActive` check reads InputActionsManager.instance, which is
    // only populated once InputActionsManager.onCreate has run. This handler and
    // that create can fire in either order, so this check alone is not init-order
    // independent: if this runs first, the engine joystick is momentarily shown.
    // InputActionsManager.onCreate hides the engine joystick itself, so it acts as
    // the backstop and the final visibility is correct regardless of ordering.
    // PlayerInputService is only available on the client, so guard against server context.
    if (NetworkingService.get().isPlayerContext()) {
      const customControlsActive = InputActionsManager.instance != null;
      const showEngineJoystick = enableJoystick && !customControlsActive;
      PlayerInputService.get().setJoystickVisible(showEngineJoystick);
      if (customControlsActive && enableJoystick) {
        console.log(
          '[LocomotionSettingsComponent] Custom touch controls (InputActionsManager) active — ' +
            'hiding engine joystick to avoid duplicate joystick UI',
        );
      } else if (enableJoystick) {
        console.log('[LocomotionSettingsComponent] Joystick ENABLED');
      } else {
        console.log('[LocomotionSettingsComponent] Joystick DISABLED');
      }
    }

    // --- Click-to-Move ---
    // ClickToMoveController.initReferences() runs on the same OnEntityStartEvent
    // but may execute before or after this handler. setClickToMoveEnabled is
    // safe to call at any time — it sets a flag that initReferences also reads.
    const clickToMove = this.entity.getComponent(ClickToMoveController);
    if (clickToMove) {
      clickToMove.setClickToMoveEnabled(enableClickToMove);
      if (!enableClickToMove) {
        console.log('[LocomotionSettingsComponent] Click-to-move DISABLED');
      }
    } else {
      console.warn(
        '[LocomotionSettingsComponent] ClickToMoveController not found on entity ' +
          this.entity.name,
      );
    }
  }
}
