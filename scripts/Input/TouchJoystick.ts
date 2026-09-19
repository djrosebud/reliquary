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
  CustomUiComponent,
  ExecuteOn,
  Vec2,
  uiViewModel,
  UiViewModel,
  CameraService,
} from 'meta/worlds';
import type {Maybe} from 'meta/worlds';
import {InputActionsManager} from './InputActionsManager';
import {TouchHoldMode, TouchRouter} from './TouchRouter';

// ============================================================================
// Tuning constants (see joystick-behavior.md for the rationale)
// ============================================================================

// How far (in normalized screen units, 0..1) the finger must travel from the
// touch-down point to reach full deflection. Mirrors DualJoystickController.
const TOUCH_RADIUS = 0.12;
// Ignore tiny jitter around the touch-down point (normalized magnitude).
const TOUCH_DEADZONE = 0.08;

// Design resolution (matches the XAML authoring resolution).
const DESIGN_WIDTH_PORTRAIT = 1080;
const DESIGN_HEIGHT_PORTRAIT = 2340;
const DESIGN_WIDTH_LANDSCAPE = 2340;
const DESIGN_HEIGHT_LANDSCAPE = 1080;

// Ring container size (px, design space), matching the Figma default design
// (Horizon Mobile In-World 2025, portrait: 172pt outer ring on a 393pt frame ->
// 172 * 1080/393 = 475). The container is centred on the touch-down point, so its
// top-left offset is origin - RING_HALF.
const RING_SIZE = 475;
const RING_HALF = RING_SIZE / 2;
// Max distance (px) the knob CENTRE travels from the ring centre (visual clamp
// only; the gameplay output is computed separately). Set so at the limit the knob
// EDGE sits half a handle-radius past the OUTER ring: outer radius RING_HALF
// (237.5) + half the 90px handle radius (22.5) = 260px knob edge, so the centre
// travels 260 - 45 = 215. The knob tracks the finger 1:1 until it reaches this limit.
const KNOB_TRAVEL_PX = 215;

// ============================================================================
// ViewModel
// ============================================================================

@uiViewModel()
export class TouchJoystickViewModel extends UiViewModel {
  override readonly events = {};

  // The ring only shows while a finger is driving the stick (floating stick).
  active: boolean = false;

  // Ring container top-left in design pixels (bound to a TranslateTransform).
  // Set so the ring is centred on the touch-down point.
  originX: number = 0;
  originY: number = 0;

  // Analog knob offset from the ring centre, in design pixels (bound to a
  // TranslateTransform). +Y is down (screen space).
  knobX: number = 0;
  knobY: number = 0;
}

// ============================================================================
// Component
//
// A floating, orientation-aware virtual movement joystick that drives an Axis2D
// action on the InputActionsManager. Touch is delivered by the shared
// TouchRouter (which owns the single OnTouchInput* subscription); the joystick
// registers a descriptor instead of subscribing to the raw touch events itself,
// because a joystick needs continuous finger tracking that a Noesis <Button>
// Command tap cannot supply.
//
// FLOATING: the stick has no fixed home. It activates at the touch-down point
// inside the movement zone (origin = touch-down) and the ring is drawn there.
//
// ORIENTATION-AWARE, PORTRAIT-FIRST zones (set `landscape` in the inspector):
//   Portrait (default): movement zone = BOTTOM half (screenPosition.y >= 0.5).
//   Landscape:          movement zone = LEFT half  (screenPosition.x < 0.5).
// The camera-look zone is the complementary half, owned by TouchCameraLook, so
// movement and camera can be driven by two fingers at once.
// ============================================================================

@component()
export class TouchJoystick extends Component {
  /** false = portrait split (default), true = landscape split. */
  @property()
  landscape: boolean = false;

  /** The InputActionsManager Axis2D action this joystick drives. */
  @property()
  actionName: string = 'Move';

  private viewModel = new TouchJoystickViewModel();
  private customUi: Maybe<CustomUiComponent> = null;

  // interactionIndex of the finger currently driving the joystick, or null.
  private activeIndex: Maybe<number> = null;
  // Touch-down anchor (the floating centre), in normalized screen units.
  private originNormX = 0;
  private originNormY = 0;

  private designWidth = DESIGN_WIDTH_PORTRAIT;
  private designHeight = DESIGN_HEIGHT_PORTRAIT;

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    this.designWidth = this.landscape
      ? DESIGN_WIDTH_LANDSCAPE
      : DESIGN_WIDTH_PORTRAIT;
    this.designHeight = this.landscape
      ? DESIGN_HEIGHT_LANDSCAPE
      : DESIGN_HEIGHT_PORTRAIT;

    this.customUi = this.entity.getComponent(CustomUiComponent);
    if (this.customUi != null) {
      this.customUi.dataContext = this.viewModel;
    }
    this.resetVisuals();

    // Route touch through the shared TouchRouter. zPriority 50 sits above the
    // background camera-look (0); passThrough:false consumes the touch so a
    // finger in the movement zone drives only the stick; HoldUntilRelease keeps
    // the finger even if it drags outside the ring.
    TouchRouter.register({
      id: 'joystick',
      zPriority: 50,
      passThrough: false,
      holdMode: TouchHoldMode.HoldUntilRelease,
      hitTest: (pos: Vec2) => this.isInMovementZone(pos),
      handlers: {
        onStart: (index: number, pos: Vec2) => this.handleStart(index, pos),
        onMove: (index: number, pos: Vec2) => this.handleMove(index, pos),
        onEnd: (index: number) => this.handleEnd(index),
      },
    });
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    TouchRouter.unregister('joystick');
    this.activeIndex = null;
    // Safety: never leave an override active — it would keep the avatar walking.
    this.setOutput(0, 0);
    this.customUi = null;
  }

  // --------------------------------------------------------------------------
  // Router handlers
  //
  // The router only delivers touches whose down-point is inside the movement
  // zone. An internal activeIndex still gates a SECOND finger: once a finger
  // owns the stick, another finger's start in the zone is ignored.
  // --------------------------------------------------------------------------

  // The ring lives in a fill Canvas inside the LayoutScaler, which pins the
  // limiting axis to the design reference and OVERSCANS the other. The router's
  // pos is physical-normalized (0..1 of the screen), so map it through the panel's
  // ACTUAL logical size, derived from the runtime viewport aspect (width/height),
  // not the fixed design constants. Mirrors the engine's built-in joystick
  // (TouchInputControlsUIPanel); without it the ring is offset on any device whose
  // aspect differs from the design (x correct, y wrong on a taller phone).
  private logicalDims(): {w: number; h: number} {
    const refW = this.designWidth;
    const refH = this.designHeight;
    const aspect = CameraService.get().aspectRatio;
    if (!(aspect > 0) || !Number.isFinite(aspect)) {
      return {w: refW, h: refH};
    }
    if (aspect < refW / refH) {
      // Viewport taller than the design: width pins, height overscans.
      return {w: refW, h: refW / aspect};
    }
    // Viewport wider than the design: height pins, width overscans.
    return {w: refH * aspect, h: refH};
  }

  private handleStart(index: number, pos: Vec2): void {
    if (this.activeIndex !== null && this.activeIndex !== index) {
      return; // Already driving another finger — do not hijack.
    }
    this.activeIndex = index;
    this.originNormX = pos.x;
    this.originNormY = pos.y;

    // Show the ring at the touch-down point; no movement until the finger moves.
    // Map the physical-normalized pos through the panel's actual logical size
    // (see logicalDims) so the ring centres on the finger on any device aspect.
    const dims = this.logicalDims();
    this.viewModel.active = true;
    this.viewModel.originX = pos.x * dims.w - RING_HALF;
    this.viewModel.originY = pos.y * dims.h - RING_HALF;
    this.viewModel.knobX = 0;
    this.viewModel.knobY = 0;
    this.setOutput(0, 0);
  }

  private handleMove(index: number, pos: Vec2): void {
    if (index !== this.activeIndex) {
      return;
    }

    // Visual knob: sit directly under the finger. Convert the raw offset from the
    // touch-down origin to design px via logicalDims (aspect-correct, same mapping
    // as the ring), then clamp its magnitude to KNOB_TRAVEL_PX so the handle stays
    // inside the ring. This is DECOUPLED from the gameplay output below: the knob
    // tracks the finger 1:1 until it passes the travel limit and then pins to the
    // ring edge, while the output keeps its deadzone + TOUCH_RADIUS ramp. Deriving
    // the knob from the output instead makes it lag the finger (the output is
    // deadzone-subtracted and renormalized over TOUCH_RADIUS, which is a different
    // per-axis distance than KNOB_TRAVEL_PX).
    const dims = this.logicalDims();
    let knobX = (pos.x - this.originNormX) * dims.w;
    let knobY = (pos.y - this.originNormY) * dims.h;
    const knobMag = Math.hypot(knobX, knobY);
    if (knobMag > KNOB_TRAVEL_PX) {
      const clampScale = KNOB_TRAVEL_PX / knobMag;
      knobX *= clampScale;
      knobY *= clampScale;
    }
    this.viewModel.knobX = knobX;
    this.viewModel.knobY = knobY;

    // Gameplay output: normalized offset from the floating origin, scaled by the
    // touch radius. Screen Y grows downward; joystick Y is +1 = up = forward.
    const dx = (pos.x - this.originNormX) / TOUCH_RADIUS;
    const dy = -(pos.y - this.originNormY) / TOUCH_RADIUS;

    const mag = Math.hypot(dx, dy);
    if (mag < TOUCH_DEADZONE) {
      this.setOutput(0, 0);
      return;
    }
    // Direction unit vector (dy already inverted so +Y = forward).
    const dirX = dx / mag;
    const dirY = dy / mag;
    // Renormalize the magnitude so output ramps from 0 at the deadzone edge to 1
    // at full deflection, instead of jumping to ~deadzone the instant the finger
    // crosses it. Clamp the raw magnitude to the unit disk first.
    const clampedMag = Math.min(mag, 1);
    const scaledMag = Math.min(
      Math.max((clampedMag - TOUCH_DEADZONE) / (1 - TOUCH_DEADZONE), 0),
      1,
    );
    // Output normalized to the unit disk; up = +Y (world forward).
    this.setOutput(dirX * scaledMag, dirY * scaledMag);
  }

  private handleEnd(index: number): void {
    if (index !== this.activeIndex) {
      return;
    }
    this.activeIndex = null;
    this.setOutput(0, 0);
    this.resetVisuals();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /** Portrait: bottom half (y >= 0.5). Landscape: left half (x < 0.5). */
  private isInMovementZone(pos: Vec2): boolean {
    return this.landscape ? pos.x < 0.5 : pos.y >= 0.5;
  }

  private setOutput(x: number, y: number): void {
    InputActionsManager.instance?.setAxis2DValue(
      this.actionName,
      new Vec2(x, y),
    );
  }

  private resetVisuals(): void {
    this.viewModel.active = false;
    this.viewModel.knobX = 0;
    this.viewModel.knobY = 0;
  }
}
