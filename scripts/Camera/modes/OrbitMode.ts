/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * High-angle orbit the player aims freely around the target. Suits tycoon,
 * tower-defence, strategy and inspection views.
 */

import {Quaternion, Vec3} from 'meta/worlds';
import {
  type CameraModeContext,
  type CameraModeResult,
  CameraModeType,
  type CameraTuning,
  type ICameraMode,
  clampAngle,
  smoothingFactor,
} from '../CameraModeTypes';

export class OrbitMode implements ICameraMode {
  public readonly type = CameraModeType.Orbit;

  public orbitDistance: number = 20;
  public minDistance: number = 5;
  public maxDistance: number = 50;
  public defaultYaw: number = 45;
  /** Overhead framing; the shared pitch clamp is too permissive here. */
  public defaultPitch: number = -65;
  public minPitch: number = -85;
  public maxPitch: number = -30;

  public onActivate(ctx: CameraModeContext, _tuning: CameraTuning): void {
    ctx.yaw = this.defaultYaw;
    ctx.pitch = clampAngle(this.defaultPitch, this.minPitch, this.maxPitch);
  }


  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult {
    ctx.yaw += ctx.lookDeltaYaw;
    ctx.pitch = clampAngle(
      ctx.pitch + ctx.lookDeltaPitch,
      this.minPitch,
      this.maxPitch,
    );

    const distance = Math.max(
      this.minDistance,
      Math.min(this.maxDistance, this.orbitDistance),
    );
    const yawRad = (ctx.yaw * Math.PI) / 180;
    const pitchRad = (ctx.pitch * Math.PI) / 180;

    const targetPos = ctx.targetTransform.worldPosition;
    const desiredPos = targetPos.add(
      new Vec3(
        Math.sin(yawRad) * Math.cos(pitchRad) * distance,
        -Math.sin(pitchRad) * distance,
        Math.cos(yawRad) * Math.cos(pitchRad) * distance,
      ),
    );

    const cur = ctx.cameraTransform.worldPosition;
    const t =
      tuning.followSpeed > 0
        ? smoothingFactor(tuning.followSpeed, deltaTime)
        : 1;
    const position = new Vec3(
      cur.x + (desiredPos.x - cur.x) * t,
      cur.y + (desiredPos.y - cur.y) * t,
      cur.z + (desiredPos.z - cur.z) * t,
    );

    return {
      position,
      rotation: Quaternion.lookRotation(targetPos.sub(position), Vec3.up),
    };
  }
}
