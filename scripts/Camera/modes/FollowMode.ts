/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * Orbit that eases back behind the player's facing direction once look input
 * stops, with an optional pitch return to the horizon.
 *
 * Differs from ThirdPerson's auto-rotate: this tracks where the player is
 * FACING (so it also re-centres while turning on the spot), whereas
 * ThirdPerson tracks where the player is MOVING.
 */

import {
  type CameraModeContext,
  CameraModeType,
  type CameraTuning,
  clampAngle,
  facingYawDegrees,
  shortestAngleDelta,
} from '../CameraModeTypes';
import {OrbitCameraModeBase} from './OrbitCameraModeBase';

export class FollowMode extends OrbitCameraModeBase {
  public readonly type = CameraModeType.Follow;

  /** Re-centre even when the player is standing still. */
  public continuousTurn: boolean = false;
  /** Also return pitch toward `horizonLevelingPitch`. */
  public horizonLeveling: boolean = false;
  public horizonLevelingPitch: number = 0;
  /** Seconds for the return rate to ramp to full; 0 disables the ramp. */
  public rotationRateAccelerationTime: number = 0;

  private noInputTimer: number = 0;
  private horizontalTimePassed: number = 0;
  private verticalTimePassed: number = 0;
  private previousTargetPosition: {x: number; z: number} | null = null;
  private suppressUntilMoving: boolean = false;

  public override onActivate(
    ctx: CameraModeContext,
    tuning: CameraTuning,
  ): void {
    super.onActivate(ctx, tuning);
    ctx.pitch = clampAngle(ctx.pitch, tuning.minPitch, tuning.maxPitch);
    this.noInputTimer = 0;
    this.horizontalTimePassed = 0;
    this.verticalTimePassed = 0;
    this.previousTargetPosition = null;
    this.suppressUntilMoving = false;
  }

  protected updateAngles(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): void {
    const position = ctx.targetTransform.worldPosition;
    let isMoving = false;
    if (this.previousTargetPosition !== null) {
      const dx = position.x - this.previousTargetPosition.x;
      const dz = position.z - this.previousTargetPosition.z;
      isMoving = dx * dx + dz * dz > 0.000001;
    }
    this.previousTargetPosition = {x: position.x, z: position.z};

    if (isMoving) {
      this.suppressUntilMoving = false;
    }

    const hasInput =
      Math.abs(ctx.lookDeltaYaw) > 0.0001 ||
      Math.abs(ctx.lookDeltaPitch) > 0.0001;

    if (hasInput) {
      ctx.yaw += ctx.lookDeltaYaw;
      ctx.pitch = clampAngle(
        ctx.pitch + ctx.lookDeltaPitch,
        tuning.minPitch,
        tuning.maxPitch,
      );
      this.noInputTimer = 0;
      this.horizontalTimePassed = 0;
      this.verticalTimePassed = 0;
      // Aiming while stationary is a deliberate look-around; don't yank it back
      // until the player actually moves again.
      if (this.continuousTurn && !isMoving) {
        this.suppressUntilMoving = true;
      }
      return;
    }

    if (!this.suppressUntilMoving && this.noInputTimer < tuning.autoRotateDelay) {
      this.noInputTimer += deltaTime;
    }

    if (!this.canAutoRotate(tuning, isMoving)) {
      this.horizontalTimePassed = 0;
      this.verticalTimePassed = 0;
      return;
    }

    this.horizontalTimePassed += deltaTime;
    const facingYaw = facingYawDegrees(ctx.targetTransform);
    const yawDelta = shortestAngleDelta(ctx.yaw, facingYaw);
    const yawStep = this.rotationStep(
      tuning,
      deltaTime,
      this.horizontalTimePassed,
    );
    ctx.yaw += Math.min(yawStep, Math.abs(yawDelta)) * Math.sign(yawDelta);

    if (this.horizonLeveling) {
      this.verticalTimePassed += deltaTime;
      const pitchDelta = this.horizonLevelingPitch - ctx.pitch;
      const pitchStep = this.rotationStep(
        tuning,
        deltaTime,
        this.verticalTimePassed,
      );
      ctx.pitch = clampAngle(
        ctx.pitch + Math.min(pitchStep, Math.abs(pitchDelta)) * Math.sign(pitchDelta),
        tuning.minPitch,
        tuning.maxPitch,
      );
    } else {
      this.verticalTimePassed = 0;
    }
  }

  private canAutoRotate(tuning: CameraTuning, isMoving: boolean): boolean {
    if (!tuning.autoRotateEnabled) return false;
    if (this.suppressUntilMoving) return false;
    if (!isMoving && !this.continuousTurn) return false;
    return (
      tuning.autoRotateDelay === 0 || this.noInputTimer >= tuning.autoRotateDelay
    );
  }

  private rotationStep(
    tuning: CameraTuning,
    deltaTime: number,
    timePassed: number,
  ): number {
    const step = tuning.autoRotateSpeed * deltaTime;
    if (this.rotationRateAccelerationTime <= 0) {
      return step;
    }
    return step * Math.min(1.0, timePassed / this.rotationRateAccelerationTime);
  }
}
