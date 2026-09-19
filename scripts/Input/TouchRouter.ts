/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v1

import {
  component,
  Component,
  subscribe,
  ExecuteOn,
  OnEntityCreateEvent,
  OnEntityDestroyEvent,
  OnTouchInputStartedEvent,
  OnTouchInputMovedEvent,
  OnTouchInputEndedEvent,
  Vec2,
} from 'meta/worlds';
import type {Maybe, TouchInputEventPayload} from 'meta/worlds';

// ============================================================================
// Public routing types (see touch-routing.md for the full model)
// ============================================================================

/** How a control behaves when the finger driving it moves. */
export enum TouchHoldMode {
  /**
   * Deactivate the moment the finger leaves the control's hit region. Its
   * `onEnd` fires on drag-off and it stops receiving moves. Use for buttons.
   */
  DeactivateOnDragOff = 0,
  /**
   * Keep the finger until it is released, even if it drags outside the hit
   * region. Use for a joystick or a camera-look drag.
   */
  HoldUntilRelease = 1,
}

/** Per-control touch callbacks. All are optional and keyed by finger index. */
export type TouchControlHandlers = {
  onStart?(index: number, pos: Vec2): void;
  onMove?(index: number, pos: Vec2): void;
  onEnd?(index: number, pos: Vec2): void;
};

/** A layered touch control registered with the {@link TouchRouter}. */
export interface TouchControlDescriptor {
  /** Unique id; re-registering the same id replaces the descriptor. */
  id: string;
  /** Higher wins the touch first. Ties break by registration order. */
  zPriority: number;
  /** true = lower controls also receive the touch; false = consume it. */
  passThrough: boolean;
  /** Drag-off vs hold-until-release semantics. */
  holdMode: TouchHoldMode;
  /** Normalized-screen-space hit test for the touch-down point. */
  hitTest: (pos: Vec2) => boolean;
  /** Touch callbacks. */
  handlers: TouchControlHandlers;
}

// ============================================================================
// TouchRouter — the single OnTouchInput* owner and layered dispatcher
//
// Every touch control (joystick, camera-look, HUD buttons) registers a
// descriptor here instead of subscribing to the raw OnTouchInput* events. The
// router owns the one subscription and dispatches each finger to the registered
// controls in zPriority order, honoring per-control consume/pass-through and
// drag-off/hold semantics. See touch-routing.md for the descriptor model,
// layering, and the aim-while-fire recipe.
//
// STATIC REGISTRATION BEFORE THE INSTANCE EXISTS: controls register in their
// OnEntityStartEvent, which can run before the router entity's create. So
// register()/unregister() operate on the live instance if present, else on a
// static pending list the instance adopts when it initializes. Control start
// ordering therefore does not matter.
// ============================================================================

@component()
export class TouchRouter extends Component {
  /** Global access point to the single router instance. */
  public static instance: Maybe<TouchRouter> = null;

  // Descriptors registered before the instance exists (or after it is torn
  // down). Adopted into `registry` on create.
  private static pending: Map<string, TouchControlDescriptor> = new Map();

  private registry: Map<string, TouchControlDescriptor> = new Map();
  // interactionIndex -> owning control ids, in delivery order.
  private owners: Map<number, string[]> = new Map();

  // --------------------------------------------------------------------------
  // Registration (static so controls can register before the instance exists)
  // --------------------------------------------------------------------------

  /** Register (or replace) a control by its `id`. */
  public static register(desc: TouchControlDescriptor): void {
    if (TouchRouter.instance != null) {
      TouchRouter.instance.registry.set(desc.id, desc);
    } else {
      TouchRouter.pending.set(desc.id, desc);
    }
  }

  /**
   * Remove a control by its `id`. Safe if it was never registered. Also scrubs
   * the id from any in-flight finger's owner list so a control unregistered
   * mid-touch does not linger there until the finger lifts. The control releases
   * its own held state in its onDestroy; the router does not call `onEnd` on an
   * unregistering control (it is tearing down).
   */
  public static unregister(id: string): void {
    if (TouchRouter.instance != null) {
      TouchRouter.instance.registry.delete(id);
      TouchRouter.instance.scrubOwner(id);
    } else {
      TouchRouter.pending.delete(id);
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityCreateEvent)
  onCreate(): void {
    TouchRouter.instance = this;
    // Adopt anything registered before this instance existed.
    for (const [id, desc] of TouchRouter.pending) {
      this.registry.set(id, desc);
    }
    TouchRouter.pending.clear();
  }

  @subscribe(OnEntityDestroyEvent)
  onDestroy(): void {
    // Move the live registry back to pending so a later instance re-adopts it.
    // Controls must unregister in their own onDestroy first, or a stale descriptor lingers.
    for (const [id, desc] of this.registry) {
      TouchRouter.pending.set(id, desc);
    }
    this.registry.clear();
    this.owners.clear();
    TouchRouter.instance = null;
  }

  // --------------------------------------------------------------------------
  // Touch dispatch
  // --------------------------------------------------------------------------

  @subscribe(OnTouchInputStartedEvent, {execution: ExecuteOn.Everywhere})
  onStart(payload: TouchInputEventPayload): void {
    const idx = payload.interactionIndex;
    const pos = payload.screenPosition;

    // Interruption guard: a prior finger reusing this index never ended (there
    // is no touch-cancel event, and Ended is not guaranteed on OS
    // interruptions). End its owners first so nothing is left stuck active.
    const stale = this.owners.get(idx);
    if (stale != null) {
      for (const id of stale) {
        this.registry.get(id)?.handlers.onEnd?.(idx, pos);
      }
      this.owners.delete(idx);
    }

    // Every control under the finger, highest zPriority first. Array.sort is
    // stable, so equal-priority controls stay in registration order.
    const hits: TouchControlDescriptor[] = [];
    for (const desc of this.registry.values()) {
      if (desc.hitTest(pos)) {
        hits.push(desc);
      }
    }
    hits.sort((a, b) => b.zPriority - a.zPriority);

    const ownerIds: string[] = [];
    for (const desc of hits) {
      desc.handlers.onStart?.(idx, pos);
      ownerIds.push(desc.id);
      if (desc.passThrough === false) {
        break; // Consumed: lower controls do not receive this touch.
      }
    }
    this.owners.set(idx, ownerIds);
  }

  @subscribe(OnTouchInputMovedEvent, {execution: ExecuteOn.Everywhere})
  onMove(payload: TouchInputEventPayload): void {
    const idx = payload.interactionIndex;
    const pos = payload.screenPosition;
    const ids = this.owners.get(idx);
    if (ids == null) {
      return;
    }
    // Copy first: a DeactivateOnDragOff control may drop itself mid-iteration.
    // Owners are fixed at touch-down time (minus drag-off drops); a move never
    // re-acquires a control the finger has newly dragged over.
    for (const id of ids.slice()) {
      const desc = this.registry.get(id);
      if (desc == null) {
        continue;
      }
      if (desc.holdMode === TouchHoldMode.HoldUntilRelease) {
        desc.handlers.onMove?.(idx, pos);
      } else if (desc.hitTest(pos)) {
        // DeactivateOnDragOff, still over the control.
        desc.handlers.onMove?.(idx, pos);
      } else {
        // Dragged off: deactivate this control for this finger.
        desc.handlers.onEnd?.(idx, pos);
        this.removeOwner(idx, id);
      }
    }
  }

  @subscribe(OnTouchInputEndedEvent, {execution: ExecuteOn.Everywhere})
  onEnd(payload: TouchInputEventPayload): void {
    const idx = payload.interactionIndex;
    const pos = payload.screenPosition;
    const ids = this.owners.get(idx);
    if (ids != null) {
      for (const id of ids) {
        this.registry.get(id)?.handlers.onEnd?.(idx, pos);
      }
    }
    this.owners.delete(idx);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  // Remove an id from every finger's owner list, used when a control
  // unregisters mid-touch so no stale id lingers until the finger lifts.
  private scrubOwner(id: string): void {
    for (const idx of [...this.owners.keys()]) {
      this.removeOwner(idx, id);
    }
  }

  private removeOwner(idx: number, id: string): void {
    const ids = this.owners.get(idx);
    if (ids == null) {
      return;
    }
    const at = ids.indexOf(id);
    if (at >= 0) {
      ids.splice(at, 1);
    }
    if (ids.length === 0) {
      this.owners.delete(idx);
    }
  }
}
