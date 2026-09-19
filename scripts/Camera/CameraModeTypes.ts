/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * Shared contract between CameraManager and the individual camera modes.
 *
 * Camera modes are plain classes, NOT Components. CameraManager owns one
 * instance of every mode and switches between them by changing which instance
 * it ticks, so changing camera never adds or removes a component.
 */

import type {CameraComponent, Entity, TransformComponent} from 'meta/worlds';
import {Quaternion, Vec3} from 'meta/worlds';

export enum CameraModeType {
  /** Orbit behind the player, right-stick/mouse driven, with auto-rotate. */
  ThirdPerson = 0,
  /** Eye-level view driven entirely by look input. */
  FirstPerson = 1,
  /** Orbit that eases back behind the player's facing after input stops. */
  Follow = 2,
  /** Orbit locked to the player's facing; ignores look input (one-thumb). */
  AutoFollow = 3,
  /** High-angle orbit the player aims freely, for builder/strategy views. */
  Orbit = 4,
  /** Bird's-eye view looking straight down. */
  TopDown = 5,
  /** Fixed-angle view; pair with an orthographic CameraPlatformComponent. */
  Isometric = 6,
  /** 2D plane view with a fixed Z, for side-scrollers. */
  SideScroll = 7,
  /** Trailing view with speed-proportional FOV, for racing. */
  Chase = 8,
  /** Fixed placement that optionally pans toward and looks at the player. */
  Static = 9,
}

/**
 * Cross-cutting settings owned by CameraManager and shared by every mode, so
 * one editor property tunes the same concept regardless of the active mode.
 * Mode-specific knobs live as public fields on the mode itself.
 */
export interface CameraTuning {
  targetDistance: number;
  shoulderHeight: number;
  shoulderOffset: number;
  translationSpeed: number;
  rotationSpeed: number;
  followSpeed: number;
  defaultPitch: number;
  minPitch: number;
  maxPitch: number;
  fieldOfView: number;
  enableCollision: boolean;
  autoRotateEnabled: boolean;
  autoRotateDelay: number;
  autoRotateSpeed: number;
  autoRotateDeadZone: number;
  autoRotateRampDuration: number;
}

/**
 * Per-frame state handed to the active mode.
 *
 * `yaw` and `pitch` are owned by the context rather than by any one mode, so a
 * switch from (say) ThirdPerson to FirstPerson keeps the player's heading
 * instead of snapping.
 */
export interface CameraModeContext {
  readonly cameraEntity: Entity;
  readonly cameraTransform: TransformComponent;
  readonly cameraComponent: CameraComponent | null;
  readonly targetEntity: Entity;
  readonly targetTransform: TransformComponent;
  /**
   * Camera pose as authored in the scene, captured before any mode has run.
   * Static mode needs it because by the time it activates the live transform
   * is wherever the previous mode left the camera.
   */
  readonly authoredPosition: Vec3;
  readonly authoredRotation: Quaternion;
  yaw: number;
  pitch: number;
  /**
   * Look input for this frame in degrees, already scaled by sensitivity.
   * CameraManager zeroes it after the mode has ticked; a mode that ignores
   * look input simply never reads it.
   */
  lookDeltaYaw: number;
  lookDeltaPitch: number;
  /** World time of the most recent non-zero look input, for auto-rotate. */
  lastLookInputTime: number;
  worldTime: number;
}

export interface CameraModeResult {
  position: Vec3;
  rotation: Quaternion;
  /** Requested FOV in degrees; omit to leave the current FOV alone. */
  fov?: number;
}

export interface ICameraMode {
  readonly type: CameraModeType;
  /** Called when this mode becomes active, and on player (re)spawn. */
  onActivate?(ctx: CameraModeContext, tuning: CameraTuning): void;
  /** Called when another mode takes over. */
  onDeactivate?(): void;
  update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult | null;
}

/** Shortest signed difference between two angles, wrapped to [-180, 180]. */
export function shortestAngleDelta(from: number, to: number): number {
  return ((((to - from + 180) % 360) + 360) % 360) - 180;
}

/**
 * Frame-rate independent interpolation factor. Matches the exponential decay
 * used throughout MHE's C++ camera code: lerp = 1 - pow(4, -speed * dt).
 */
export function smoothingFactor(speed: number, deltaTime: number): number {
  return 1.0 - Math.pow(4.0, -speed * deltaTime);
}

export function clampAngle(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Yaw in degrees that points along the entity's forward (local -Z). */
export function facingYawDegrees(transform: TransformComponent): number {
  const forward = transform.worldRotation.mulVec3(Vec3.forward);
  return Math.atan2(-forward.x, -forward.z) * (180 / Math.PI);
}

/** Camera rotation from yaw/pitch, decomposed to keep roll at zero. */
export function yawPitchRotation(yaw: number, pitch: number): Quaternion {
  return Quaternion.fromEuler(new Vec3(0, yaw, 0)).mul(
    Quaternion.fromEuler(new Vec3(pitch, 0, 0)),
  );
}
