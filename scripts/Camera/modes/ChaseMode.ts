/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/** Trailing view with speed-proportional FOV, for racing and driving. */

import {Quaternion, Vec3} from 'meta/worlds';
import {
  type CameraModeContext,
  type CameraModeResult,
  CameraModeType,
  type CameraTuning,
  type ICameraMode,
  smoothingFactor,
} from '../CameraModeTypes';

export class ChaseMode implements ICameraMode {
  public readonly type = CameraModeType.Chase;

  public chaseDistance: number = 8;
  public heightOffset: number = 2;
  /** FOV at top speed; the base FOV comes from CameraManager's tuning. */
  public maxFov: number = 95;
  public maxSpeed: number = 50;

  private previousPosition: Vec3 | null = null;
  private currentSpeed: number = 0;

  public onActivate(_ctx: CameraModeContext, _tuning: CameraTuning): void {
    this.previousPosition = null;
    this.currentSpeed = 0;
  }


  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult {
    const playerPos = ctx.targetTransform.worldPosition;

    if (this.previousPosition !== null) {
      this.currentSpeed =
        playerPos.sub(this.previousPosition).magnitude() /
        Math.max(deltaTime, 0.001);
    }
    this.previousPosition = playerPos;

    const desired = new Vec3(
      playerPos.x,
      playerPos.y + this.heightOffset,
      playerPos.z - this.chaseDistance,
    );

    const cur = ctx.cameraTransform.worldPosition;
    const t =
      tuning.translationSpeed > 0
        ? smoothingFactor(tuning.translationSpeed, deltaTime)
        : 1;
    const position = new Vec3(
      cur.x + (desired.x - cur.x) * t,
      cur.y + (desired.y - cur.y) * t,
      cur.z + (desired.z - cur.z) * t,
    );

    const speedRatio = Math.min(
      this.currentSpeed / Math.max(this.maxSpeed, 0.001),
      1.0,
    );

    return {
      position,
      rotation: Quaternion.lookRotation(playerPos.sub(position), Vec3.up),
      fov: tuning.fieldOfView + (this.maxFov - tuning.fieldOfView) * speedRatio,
    };
  }
}
