/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Interaction Scripts v1

/**
 * InteractionControlsBridge
 *
 * Component Attachment: the SAME interactor child entity that carries
 *   `InteractorComponent` + `InteractionController`.
 * Component Networking: Local (input is client-only).
 *
 * Project glue, NOT a portable skill file: it legally imports both the
 * installed touch controls (`InputActionsManager` / `TouchControlsHud`) and
 * `InteractionController` + its candidacy events, which a portable `.ts.skill`
 * may not. Bridges the contextual `Interact` HUD button to the controller:
 * shows the button on candidacy enter, hides it on exit, and calls
 * `activate()` when the `Interact` action fires.
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
  InteractionController,
  OnInteractCandidateEnterEvent,
  OnInteractCandidateExitEvent,
} from './InteractionController';

@component({
  description:
    'Bridges the Interact action + HUD button to InteractionController.',
})
export class InteractionControlsBridge extends Component {
  private subscription: Maybe<EventSubscription> = null;
  private hud: Maybe<TouchControlsHud> = null;
  private wired: boolean = false;
  private pendingShow: boolean = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    this.wire();
  }

  // The InputActionsManager singleton may not be visible at start; retry each
  // frame until wired so a startup race can never drop the subscription. getHud()
  // is likewise null until a TouchControlsHud entity exists, so a candidacy that
  // fired before the HUD was up left pendingShow set: retry the show here too.
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  onUpdate(): void {
    if (!this.wired) {
      this.wire();
    }
    if (this.pendingShow) {
      const hud = this.getHud();
      if (hud != null) {
        hud.showButton('Interact');
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
      'Interact',
      (event: InputActionChangeEvent) => {
        if (event.newValue as boolean) {
          this.entity.getComponent(InteractionController)?.activate();
        }
      },
    );
    this.wired = true;
    // Contextual button: hidden until a candidate exists (candidacy enter shows
    // it). No-op if the HUD is not up yet.
    this.getHud()?.hideButton('Interact');
  }

  @subscribe(OnInteractCandidateEnterEvent, {execution: ExecuteOn.Owner})
  onCandidateEnter(): void {
    this.pendingShow = true;
    const hud = this.getHud();
    if (hud != null) {
      hud.showButton('Interact');
      this.pendingShow = false;
    }
  }

  @subscribe(OnInteractCandidateExitEvent, {execution: ExecuteOn.Owner})
  onCandidateExit(): void {
    this.pendingShow = false;
    this.getHud()?.hideButton('Interact');
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
    this.getHud()?.hideButton('Interact');
  }
}
