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

// Design resolution (matches the XAML authoring resolution). Selected by
// `landscape` and used to convert button geometry to a runtime hit rect.
const DESIGN_WIDTH_PORTRAIT = 1080;
const DESIGN_HEIGHT_PORTRAIT = 2340;
const DESIGN_WIDTH_LANDSCAPE = 2340;
const DESIGN_HEIGHT_LANDSCAPE = 1080;

// ============================================================================
// ViewModel — per-button visibility, enabled, and pressed flags.
//
// Buttons no longer use Noesis <Button> Command bindings. Touch is delivered by
// the shared TouchRouter, so each XAML button is a display-only visual: its
// pressed look binds to a `*Pressed` flag the router handlers set, and its
// Visibility / IsEnabled bind to the existing `*Visible` / `*Enabled` flags.
// ============================================================================

@uiViewModel()
export class TouchControlsHudViewModel extends UiViewModel {
  override readonly events = {};

  // Per-button visibility (bound to Button.Visibility in the XAML).
  jumpVisible: boolean = true;

  // Per-button enabled state (bound to Button.IsEnabled in the XAML).
  jumpEnabled: boolean = true;

  // Per-button pressed state (bound to a scale change in the XAML).
  jumpPressed: boolean = false;

  // Contextual: InteractionControlsBridge shows this only while the interactor
  // has a WSDK candidate, so it starts hidden.
  interactVisible: boolean = false;
  interactEnabled: boolean = true;
  interactPressed: boolean = false;

  // Contextual: AttachableControlsBridge shows this only while the local player
  // holds a droppable AttachableObject, so it starts hidden.
  dropVisible: boolean = false;
  dropEnabled: boolean = true;
  dropPressed: boolean = false;
}

// ============================================================================
// Button config — the tunable table a creator edits to add or shape a button.
//
// Each button carries its DESIGN-space geometry for both orientations: `geom`
// (portrait) and `geomLandscape`. Geometry is bottom-right anchored (matching
// the built-in GameplayControls and the Canvas.Right/Canvas.Bottom in the XAML):
// `right`/`bottom` are the design-px insets from the bottom-right corner and
// `w`/`h` are the button size. effectiveConfigs() selects one by `this.landscape`
// (set it to match the copied XAML build: TouchControlsHud.portrait.xaml /
// .landscape.xaml), and rectFor() converts it to a normalized (0..1) hit rect at
// touch time using the panel's ACTUAL logical size (logicalDims), so the hit
// zone tracks the visible button on any device aspect. A statically-normalized
// rect (design / 1920) is right on x but offset on y on a non-design aspect,
// because the fill Canvas overscans and the button is bottom-anchored.
//
// Sizes follow the Figma default design tiers (see hud-button-layout.md):
// primary 195, jump 160, ability/special 135, secondary/utility 110.
// Portrait geometry (design 1080x2340, 19.5:9 matching the Figma frame):
//   Jump:     W160 H160 Canvas.Right 88  Canvas.Bottom 654
//   Interact: W110 H110 Canvas.Right 90  Canvas.Bottom 260
//   Drop:     W110 H110 Canvas.Right 249 Canvas.Bottom 95
// Landscape geometry (design 2340x1080, Jump from Figma node 1065-20660):
//   Jump:     W160 H160 Canvas.Right 153 Canvas.Bottom 383
//   Interact: W110 H110 Canvas.Right 300 Canvas.Bottom 140
//   Drop:     W110 H110 Canvas.Right 178 Canvas.Bottom 570
// Move or resize a button in a build -> update that orientation's geom here to
// match the Canvas.Right/Canvas.Bottom/size in the matching XAML.
// ============================================================================

type ButtonRect = {x0: number; y0: number; x1: number; y1: number};

// Bottom-right-anchored button geometry in design pixels (matches the XAML
// Canvas.Right / Canvas.Bottom / Width / Height).
type ButtonGeom = {right: number; bottom: number; w: number; h: number};

type ButtonConfig = {
  /** InputActionsManager action name driven by this button. */
  action: string;
  /** Portrait design-px geometry; MUST match the portrait XAML position + size. */
  geom: ButtonGeom;
  /** Landscape design-px geometry; MUST match the landscape XAML position + size. */
  geomLandscape: ButtonGeom;
  /** true = tap (pulse on press); false = hold (down until release). */
  momentary: boolean;
  /** true = lower controls also see the touch; false = consume it. */
  passThrough: boolean;
  /** Drag-off vs hold-until-release semantics. */
  holdMode: TouchHoldMode;
  /** ViewModel property bound to the button's Visibility. */
  visibleKey: string;
  /** ViewModel property bound to the button's IsEnabled. */
  enabledKey: string;
  /** ViewModel property bound to the button's pressed visual. */
  pressedKey: string;
};

const BUTTON_CONFIGS: ButtonConfig[] = [
  {
    action: 'Jump',
    geom: {right: 88, bottom: 654, w: 160, h: 160},
    geomLandscape: {right: 153, bottom: 383, w: 160, h: 160},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'jumpVisible',
    enabledKey: 'jumpEnabled',
    pressedKey: 'jumpPressed',
  },
  {
    action: 'Interact',
    geom: {right: 90, bottom: 260, w: 110, h: 110},
    geomLandscape: {right: 300, bottom: 140, w: 110, h: 110},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'interactVisible',
    enabledKey: 'interactEnabled',
    pressedKey: 'interactPressed',
  },
  {
    action: 'Drop',
    geom: {right: 249, bottom: 95, w: 110, h: 110},
    geomLandscape: {right: 178, bottom: 570, w: 110, h: 110},
    momentary: true,
    passThrough: false,
    holdMode: TouchHoldMode.DeactivateOnDragOff,
    visibleKey: 'dropVisible',
    enabledKey: 'dropEnabled',
    pressedKey: 'dropPressed',
  },
];

// ============================================================================
// Component — renders the HUD and drives InputActionsManager via the router.
// ============================================================================

@component()
export class TouchControlsHud extends Component {
  /**
   * false = portrait (default), true = landscape. Selects the portrait vs
   * landscape BUTTON_CONFIGS hit rects; set it to match the copied XAML build
   * (TouchControlsHud.portrait.xaml or .landscape.xaml).
   */
  @property()
  landscape: boolean = false;

  // Per-button tunables (inspector overrides of the BUTTON_CONFIGS defaults).
  // The defaults reproduce the table: tap, consume, deactivate-on-drag-off. For
  // an aim-while-fire recipe on a button that overlaps the camera zone, set that
  // button's PassThrough=true, Momentary=false, HoldUntilRelease=true so a finger
  // fires the action while it holds AND the camera-look drag underneath turns.

  @property()
  jumpPassThrough: boolean = false;
  @property()
  jumpMomentary: boolean = true;
  @property()
  jumpHoldUntilRelease: boolean = false;

  private viewModel = new TouchControlsHudViewModel();
  private customUi: Maybe<CustomUiComponent> = null;
  private registeredIds: string[] = [];

  private designWidth = DESIGN_WIDTH_PORTRAIT;
  private designHeight = DESIGN_HEIGHT_PORTRAIT;

  // --------------------------------------------------------------------------
  // Lifecycle
  //
  // Use OnEntityStartEvent (not OnEntityCreateEvent): CustomUiComponent is not
  // fully ready at create time, so dataContext must be set on start.
  // --------------------------------------------------------------------------

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    this.designWidth = this.landscape
      ? DESIGN_WIDTH_LANDSCAPE
      : DESIGN_WIDTH_PORTRAIT;
    this.designHeight = this.landscape
      ? DESIGN_HEIGHT_LANDSCAPE
      : DESIGN_HEIGHT_PORTRAIT;

    this.registeredIds = [];

    this.customUi = this.entity.getComponent(CustomUiComponent);
    if (this.customUi == null) {
      // Bail before registering: the buttons would be invisible without the UI,
      // but their hit regions still sit at zPriority 100 and would swallow every
      // touch that lands on them.
      console.error('TouchControlsHud: CustomUiComponent not found on entity');
      return;
    }
    this.customUi.dataContext = this.viewModel;

    // Register each button with the router at the HUD band (zPriority 100,
    // above the joystick and camera-look). hitTest converts the button's design
    // geometry to a normalized rect at touch time (rectFor) so it tracks the
    // visible button on any device aspect.
    for (const cfg of this.effectiveConfigs()) {
      const id = `btn:${cfg.action}`;
      TouchRouter.register({
        id,
        zPriority: 100,
        passThrough: cfg.passThrough,
        holdMode: cfg.holdMode,
        hitTest: (pos: Vec2) =>
          this.isButtonInteractable(cfg) &&
          this.pointInRect(pos, this.rectFor(cfg.geom)),
        handlers: {
          onStart: () => this.handleButtonStart(cfg),
          onEnd: () => this.handleButtonEnd(cfg),
        },
      });
      this.registeredIds.push(id);
    }
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    // Release any held button before unregistering, or a hold button torn down
    // mid-press (scene reload, entity removed) leaves the action stuck down.
    const mgr = InputActionsManager.instance;
    for (const cfg of this.effectiveConfigs()) {
      this.setPressedVisual(cfg, false);
      if (!cfg.momentary) {
        mgr?.setButtonState(cfg.action, false);
      }
    }
    for (const id of this.registeredIds) {
      TouchRouter.unregister(id);
    }
    this.registeredIds = [];
    this.customUi = null;
  }

  // --------------------------------------------------------------------------
  // Router handlers — pressed visual plus the action drive.
  // --------------------------------------------------------------------------

  private handleButtonStart(cfg: ButtonConfig): void {
    this.setPressedVisual(cfg, true);
    if (cfg.momentary) {
      // Tap: pulse the action press + release on touch-down.
      InputActionsManager.instance?.triggerInputAction(cfg.action);
    } else {
      // Hold: hold the action down until the finger releases.
      InputActionsManager.instance?.setButtonState(cfg.action, true);
    }
  }

  private handleButtonEnd(cfg: ButtonConfig): void {
    this.setPressedVisual(cfg, false);
    if (!cfg.momentary) {
      InputActionsManager.instance?.setButtonState(cfg.action, false);
    }
  }

  // --------------------------------------------------------------------------
  // Wrapper API — clean show/hide/enable control over individual buttons
  // --------------------------------------------------------------------------

  /** Show a single button by its action name (e.g. `'Jump'`). */
  public showButton(action: string): void {
    this.setButtonVisible(action, true);
  }

  /** Hide a single button by its action name. */
  public hideButton(action: string): void {
    this.setButtonVisible(action, false);
  }

  /** Enable or grey-out a single button by its action name. */
  public setButtonEnabled(action: string, enabled: boolean): void {
    const cfg = this.findConfig(action);
    if (cfg != null) {
      this.setViewModelFlag(cfg.enabledKey, enabled);
    }
  }

  /** Show the entire HUD. */
  public showAll(): void {
    if (this.customUi != null) {
      this.customUi.isVisible = true;
    }
  }

  /** Hide the entire HUD. */
  public hideAll(): void {
    if (this.customUi != null) {
      this.customUi.isVisible = false;
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Select each button's orientation geometry (portrait vs landscape) and apply
   * the per-button inspector overrides onto the config table. The router hitTest
   * converts the returned `geom` to a hit rect via rectFor, so selecting it here
   * is what makes `landscape` switch the hit regions to match the copied XAML.
   *
   * Inspector overrides (jump*) apply ONLY to the shipped `Jump` button. Buttons
   * you ADD have no inspector fields, so set their momentary/passThrough/holdMode
   * directly in their `BUTTON_CONFIGS` row (which this method preserves).
   */
  private effectiveConfigs(): ButtonConfig[] {
    return BUTTON_CONFIGS.map(cfg => {
      const geom = this.landscape ? cfg.geomLandscape : cfg.geom;
      if (cfg.action === 'Jump') {
        return {
          ...cfg,
          geom,
          passThrough: this.jumpPassThrough,
          momentary: this.jumpMomentary,
          holdMode: this.jumpHoldUntilRelease
            ? TouchHoldMode.HoldUntilRelease
            : TouchHoldMode.DeactivateOnDragOff,
        };
      }
      return {...cfg, geom};
    });
  }

  // The buttons live in a fill Canvas inside the LayoutScaler, which overscans
  // the non-limiting axis. The router pos is physical-normalized (0..1 of the
  // screen), so convert each button's bottom-right-anchored design geometry to a
  // normalized rect through the panel's ACTUAL logical size, derived from the
  // runtime viewport aspect, not the fixed design constants. Without it a
  // bottom-anchored button's hit zone is offset from the visible button on any
  // off-design aspect (x correct, y wrong on a taller phone). Mirrors the
  // joystick and the engine's built-in controls.
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

  private rectFor(geom: ButtonGeom): ButtonRect {
    const {w: lw, h: lh} = this.logicalDims();
    return {
      x0: (lw - geom.right - geom.w) / lw,
      x1: (lw - geom.right) / lw,
      y0: (lh - geom.bottom - geom.h) / lh,
      y1: (lh - geom.bottom) / lh,
    };
  }

  private pointInRect(pos: Vec2, rect: ButtonRect): boolean {
    return (
      pos.x >= rect.x0 &&
      pos.x <= rect.x1 &&
      pos.y >= rect.y0 &&
      pos.y <= rect.y1
    );
  }

  private setPressedVisual(cfg: ButtonConfig, pressed: boolean): void {
    this.setViewModelFlag(cfg.pressedKey, pressed);
  }

  private setButtonVisible(action: string, visible: boolean): void {
    const cfg = this.findConfig(action);
    if (cfg != null) {
      this.setViewModelFlag(cfg.visibleKey, visible);
    }
  }

  private setViewModelFlag(key: string, value: boolean): void {
    (this.viewModel as unknown as Record<string, boolean>)[key] = value;
  }

  private getViewModelFlag(key: string): boolean {
    return (this.viewModel as unknown as Record<string, boolean>)[key];
  }

  /**
   * A button only takes touches when the whole HUD is visible and the button's
   * own visible + enabled flags are set. The router hit rect is pure geometry,
   * so without this a hidden or greyed-out button still intercepts taps and
   * fires its action.
   */
  private isButtonInteractable(cfg: ButtonConfig): boolean {
    if (this.customUi != null && !this.customUi.isVisible) {
      return false;
    }
    return (
      this.getViewModelFlag(cfg.visibleKey) &&
      this.getViewModelFlag(cfg.enabledKey)
    );
  }

  private findConfig(action: string): Maybe<ButtonConfig> {
    for (const cfg of BUTTON_CONFIGS) {
      if (cfg.action === action) {
        return cfg;
      }
    }
    console.error(`TouchControlsHud: no button bound to action '${action}'`);
    return null;
  }
}
