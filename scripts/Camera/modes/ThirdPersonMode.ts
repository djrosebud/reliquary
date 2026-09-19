/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * Right-stick / mouse orbit behind the player, with optional auto-rotate that
 * swings the camera yaw back behind the direction of travel for one-thumb play.
 */

import {Vec3} from 'meta/worlds';
import {
  type CameraModeContext,
  CameraModeType,
  type CameraTuning,
  clampAngle,
  shortestAngleDelta,
} from '../CameraModeTypes';
import {OrbitCameraModeBase} from './OrbitCameraModeBase';

// Skip auto-rotate correction when the camera is nearly head-on with the
// movement, otherwise running straight at the camera flip-flops left/right.
const AUTO_ROTATE_MAX_ANGLE = 165;
// Minimum squared XZ movement per frame to count as moving; filters out
// positional jitter while standing still.
const AUTO_ROTATE_MIN_MOVE_SQ = 0.0001;

export class ThirdPersonMode extends OrbitCameraModeBase {
  public readonly type = CameraModeType.ThirdPerson;

  private lastTargetPosition: Vec3 | null = null;
  // 0..1 ramp so auto-rotate engages and disengages smoothly instead of
  // snapping to full turn rate the instant the dead zone is crossed.
  private autoRotateRamp: number = 0;

  public override onActivate(
    ctx: CameraModeContext,
    tuning: CameraTuning,
  ): void {
    super.onActivate(ctx, tuning);
    ctx.pitch = clampAngle(ctx.pitch, tuning.minPitch, tuning.maxPitch);
    this.lastTargetPosition = null;
    this.autoRotateRamp = 0;
  }

  protected updateAngles(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): void {
    ctx.yaw += ctx.lookDeltaYaw;
    ctx.pitch = clampAngle(
      ctx.pitch + ctx.lookDeltaPitch,
      tuning.minPitch,
      tuning.maxPitch,
    );

    this.updateAutoRotate(ctx, tuning, deltaTime);
  }

  /**
   * Turns yaw toward "behind the movement direction" at a constant angular
   * rate once the player has gone `autoRotateDelay` seconds without touching
   * the camera. Pitch is deliberately never touched.
   */
  private updateAutoRotate(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): void {
    const targetPosition = ctx.targetTransform.worldPosition;

    if (!tuning.autoRotateEnabled) {
      this.lastTargetPosition = targetPosition;
      this.autoRotateRamp = 0;
      return;
    }

    let isActivelyRotating = false;
    let angleDiff = 0;
    let absAngle = 0;

    if (this.lastTargetPosition !== null) {
      const dx = targetPosition.x - this.lastTargetPosition.x;
      const dz = targetPosition.z - this.lastTargetPosition.z;
      const movementDistSq = dx * dx + dz * dz;
      const timeSinceInput = ctx.worldTime - ctx.lastLookInputTime;

      if (
        movementDistSq > AUTO_ROTATE_MIN_MOVE_SQ &&
        timeSinceInput > tuning.autoRotateDelay
      ) {
        const desiredYaw = Math.atan2(-dx, -dz) * (180 / Math.PI);
        angleDiff = shortestAngleDelta(ctx.yaw, desiredYaw);
        absAngle = Math.abs(angleDiff);
        isActivelyRotating =
          absAngle > tuning.autoRotateDeadZone &&
          absAngle < AUTO_ROTATE_MAX_ANGLE;
      }
    }
    this.lastTargetPosition = targetPosition;

    const rampStep =
      tuning.autoRotateRampDuration > 0
        ? deltaTime / tuning.autoRotateRampDuration
        : 1.0;
    this.autoRotateRamp = isActivelyRotating
      ? Math.min(1.0, this.autoRotateRamp + rampStep)
      : Math.max(0.0, this.autoRotateRamp - rampStep);

    if (this.autoRotateRamp > 0 && isActivelyRotating) {
      const stepDeg = tuning.autoRotateSpeed * this.autoRotateRamp * deltaTime;
      ctx.yaw += Math.min(stepDeg, absAngle) * Math.sign(angleDiff);
    }
  }
}
