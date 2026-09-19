/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Input Scripts v1

import {
  component,
  Component,
  property,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  ExecuteOn,
  Vec2,
} from 'meta/worlds';
import {InputActionsManager} from './InputActionsManager';
import {TouchHoldMode, TouchRouter} from './TouchRouter';

// ============================================================================
// Tuning constants (see camera-look-behavior.md for the rationale)
// ============================================================================

// Scales the raw per-move normalized delta into the value published on 'Look'.
// The camera consumer decides the final radians-per-unit; this is a coarse gain
// so a full-screen swipe yields a comfortable turn.
const LOOK_SENSITIVITY = 3.0;

// ============================================================================
// Component
//
// An invisible camera-look drag that drives an ActionType.Delta 'Look' action on
// the InputActionsManager. It has no XAML because a look drag has no on-screen
// widget. Touch is delivered by the shared TouchRouter (which owns the single
// OnTouchInput* subscription); the drag registers a descriptor instead of
// subscribing to the raw touch events itself.
//
// LOWEST LAYER: it registers at zPriority 0 with passThrough:true, so it is the
// background of the camera zone. Higher controls (buttons) either consume a
// touch or pass it through to this drag. There is no corner exclusion: buttons
// are simply higher-z controls that own their own hit region.
//
// ORIENTATION-AWARE, PORTRAIT-FIRST zones (set `landscape` in the inspector):
//   Portrait (default): camera zone = TOP half   (screenPosition.y < 0.5).
//   Landscape:          camera zone = RIGHT half  (screenPosition.x >= 0.5).
//
// DELTA MODEL: 'Look' is an ActionType.Delta action. Each move adds its
// per-move delta (the change in touch position since the last move) via
// addActionDelta; the manager accumulates the adds within a frame and auto-zeros
// the action each frame. The camera consumer polls getActionDelta('Look') in its
// OnWorldUpdate and integrates the delta into yaw/pitch, reading (0,0) when the
// finger is idle.
// ============================================================================

@component()
export class TouchCameraLook extends Component {
  /** false = portrait split (default), true = landscape split. */
  @property()
  landscape: boolean = false;

  /** The InputActionsManager Delta action this drag drives. */
  @property()
  actionName: string = 'Look';

  // Last touch position (normalized) per router finger index, used to compute
  // the per-move delta. HoldUntilRelease means a finger keeps driving the look
  // even after it leaves the camera zone, so track by index.
  private lastByIndex: Map<number, Vec2> = new Map();

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    // Register as the background of the camera zone. passThrough:true lets a
    // higher control (a button) also see the touch when it chooses; zPriority 0
    // keeps this drag below everything. HoldUntilRelease keeps the finger for
    // the whole drag.
    TouchRouter.register({
      id: 'cameraLook',
      zPriority: 0,
      passThrough: true,
      holdMode: TouchHoldMode.HoldUntilRelease,
      hitTest: (pos: Vec2) => this.isInCameraZone(pos),
      handlers: {
        onStart: (index: number, pos: Vec2) => this.handleStart(index, pos),
        onMove: (index: number, pos: Vec2) => this.handleMove(index, pos),
        onEnd: (index: number) => this.handleEnd(index),
      },
    });
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    TouchRouter.unregister('cameraLook');
    this.lastByIndex.clear();
  }

  // --------------------------------------------------------------------------
  // Router handlers
  // --------------------------------------------------------------------------

  private handleStart(index: number, pos: Vec2): void {
    this.lastByIndex.set(index, new Vec2(pos.x, pos.y));
  }

  private handleMove(index: number, pos: Vec2): void {
    const last = this.lastByIndex.get(index);
    if (last == null) {
      // No start recorded for this finger; seed and skip a frame.
      this.lastByIndex.set(index, new Vec2(pos.x, pos.y));
      return;
    }
    // Per-move delta (screen space). +X = drag right, +Y = drag down. The
    // camera consumer decides how to map these to yaw/pitch.
    const dx = (pos.x - last.x) * LOOK_SENSITIVITY;
    const dy = (pos.y - last.y) * LOOK_SENSITIVITY;
    this.lastByIndex.set(index, new Vec2(pos.x, pos.y));
    // Accumulate the delta for this frame. The manager sums the adds and
    // auto-zeros the action each frame, so the camera consumer polls the total
    // in its OnWorldUpdate and reads (0,0) once the finger stops moving.
    InputActionsManager.instance?.addActionDelta(
      this.actionName,
      new Vec2(dx, dy),
    );
  }

  private handleEnd(index: number): void {
    // No reset needed for a delta stream: with the finger up there are no more
    // moves, so the last published delta simply stops arriving.
    this.lastByIndex.delete(index);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /** Portrait: top half (y < 0.5). Landscape: right half (x >= 0.5). */
  private isInCameraZone(pos: Vec2): boolean {
    return this.landscape ? pos.x >= 0.5 : pos.y < 0.5;
  }
}
