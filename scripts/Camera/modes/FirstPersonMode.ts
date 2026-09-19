/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/** Eye-level view driven entirely by look input. */

import {Vec3} from 'meta/worlds';
import {
  type CameraModeContext,
  type CameraModeResult,
  CameraModeType,
  type CameraTuning,
  type ICameraMode,
  clampAngle,
  smoothingFactor,
  yawPitchRotation,
} from '../CameraModeTypes';

export class FirstPersonMode implements ICameraMode {
  public readonly type = CameraModeType.FirstPerson;

  public eyeHeight: number = 1.7;

  private smoothedYaw: number = 0;
  private smoothedPitch: number = 0;

  public onActivate(ctx: CameraModeContext, tuning: CameraTuning): void {
    ctx.pitch = clampAngle(ctx.pitch, tuning.minPitch, tuning.maxPitch);
    this.smoothedYaw = ctx.yaw;
    this.smoothedPitch = ctx.pitch;
  }


  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult {
    ctx.yaw += ctx.lookDeltaYaw;
    ctx.pitch = clampAngle(
      ctx.pitch + ctx.lookDeltaPitch,
      tuning.minPitch,
      tuning.maxPitch,
    );

    if (tuning.rotationSpeed > 0) {
      const t = smoothingFactor(tuning.rotationSpeed, deltaTime);
      let yawDiff = ctx.yaw - this.smoothedYaw;
      while (yawDiff > 180) yawDiff -= 360;
      while (yawDiff < -180) yawDiff += 360;
      this.smoothedYaw += yawDiff * t;
      this.smoothedPitch += (ctx.pitch - this.smoothedPitch) * t;
    } else {
      this.smoothedYaw = ctx.yaw;
      this.smoothedPitch = ctx.pitch;
    }

    const playerPos = ctx.targetTransform.worldPosition;
    return {
      position: new Vec3(
        playerPos.x,
        playerPos.y + this.eyeHeight,
        playerPos.z,
      ),
      rotation: yawPitchRotation(this.smoothedYaw, this.smoothedPitch),
    };
  }
}
