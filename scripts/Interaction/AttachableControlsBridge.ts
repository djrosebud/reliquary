/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Interaction Scripts v1

/**
 * AttachableControlsBridge
 *
 * Component Attachment: the SAME interactor child entity that carries
 *   `InteractorComponent` + `InteractionController` + `InteractionControlsBridge`.
 * Component Networking: Local (input is client-only).
 *
 * Project glue, NOT a portable skill file: it imports both the installed touch
 * controls (`InputActionsManager` / `TouchControlsHud`) and `AttachableObject`.
 * `AttachableObject` fires {@link OnHeldStateChangedEvent} and exposes
 * `release()` but deliberately renders no button; this bridge owns the
 * contextual `Drop` HUD button:
 *
 * - held + canDrop  -> showButton('Drop')
 * - released        -> hideButton('Drop')
 * - `Drop` action   -> release() on the currently-held object
 *
 * `canDrop === false` (a permanently-held / one-way pickup) keeps the button
 * hidden, so the player has no way to let go.
 */

import {
  Component,
  component,
  subscribe,
  EntityService,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  OnEntityDestroyEvent,
  ExecuteOn,
} from 'meta/worlds';
import type {EventSubscription, Maybe} from 'meta/worlds';
import {
  InputActionsManager,
  InputActionChangeEvent,
} from '../Input/InputActionsManager';
import {TouchControlsHud} from '../Input/TouchControlsHud';
import {
  AttachableObject,
  HeldStateChangedPayload,
  OnHeldStateChangedEvent,
} from './AttachableObject';

@component({
  description:
    'Bridges the Drop action + HUD button to the currently-held AttachableObject.',
})
export class AttachableControlsBridge extends Component {
  private subscription: Maybe<EventSubscription> = null;
  private hud: Maybe<TouchControlsHud> = null;
  private wired: boolean = false;
  private pendingShow: boolean = false;
  // The object this client's player is currently holding, or null.
  private held: Maybe<AttachableObject> = null;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    this.wire();
  }

  // Same startup race as the other bridges: the InputActionsManager singleton
  // lives on a scene entity and is not guaranteed visible from this
  // client-owned child at start. Retry every frame until wired; once wired this
  // early-returns. pendingShow covers a grab that landed before the HUD entity
  // existed.
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  onUpdate(): void {
    if (!this.wired) {
      this.wire();
    }
    if (this.pendingShow) {
      const hud = this.getHud();
      if (hud != null) {
        hud.showButton('Drop');
        this.pendingShow = false;
      }
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
    this.subscription = manager.subscribeAction(
      'Drop',
      (event: InputActionChangeEvent) => {
        if (event.newValue as boolean) {
          this.held?.release();
        }
      },
    );
    this.wired = true;
    // Contextual button: hidden until something is held.
    this.getHud()?.hideButton('Drop');
  }

  /**
   * `AttachableObject` fires this locally on the owning client whenever an
   * object is grabbed, dropped, holstered, or destroyed while held.
   */
  @subscribe(OnHeldStateChangedEvent, {execution: ExecuteOn.Owner})
  onHeldStateChanged(payload: HeldStateChangedPayload): void {
    // `held` is exactly "the object the Drop button releases", so a grabbed but
    // non-droppable object (canDrop=false) leaves it null and the button hidden.
    this.held =
      payload.isHeld && payload.canDrop
        ? (payload.object?.getComponent(AttachableObject) ?? null)
        : null;
    if (this.held == null) {
      this.pendingShow = false;
      this.getHud()?.hideButton('Drop');
      return;
    }
    this.pendingShow = true;
    const hud = this.getHud();
    if (hud != null) {
      hud.showButton('Drop');
      this.pendingShow = false;
    }
  }

  private getHud(): Maybe<TouchControlsHud> {
    if (this.hud == null) {
      const huds = EntityService.findEntitiesWithComponent(TouchControlsHud);
      if (huds.length > 0) {
        this.hud = huds[0].getComponent(TouchControlsHud);
      }
    }
    return this.hud;
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Owner})
  onDestroy(): void {
    this.subscription?.disconnect();
    this.subscription = null;
    this.wired = false;
    this.held = null;
    this.getHud()?.hideButton('Drop');
  }
}
