/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/** 2D plane view: follows the player in X and Y with Z pinned. */

import {Quaternion, Vec3} from 'meta/worlds';
import {
  type CameraModeContext,
  type CameraModeResult,
  CameraModeType,
  type CameraTuning,
  type ICameraMode,
  smoothingFactor,
} from '../CameraModeTypes';

export class SideScrollMode implements ICameraMode {
  public readonly type = CameraModeType.SideScroll;

  /** Fixed Z distance from the action plane. */
  public sideOffset: number = 15.0;
  public heightOffset: number = 2.0;

  private readonly sideRotation = Quaternion.lookRotation(
    new Vec3(0, 0, -1),
    Vec3.up,
  );



  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult {
    const playerPos = ctx.targetTransform.worldPosition;
    const desired = new Vec3(
      playerPos.x,
      playerPos.y + this.heightOffset,
      this.sideOffset,
    );

    const cur = ctx.cameraTransform.worldPosition;
    const t =
      tuning.followSpeed > 0
        ? smoothingFactor(tuning.followSpeed, deltaTime)
        : 1;

    return {
      position: new Vec3(
        cur.x + (desired.x - cur.x) * t,
        cur.y + (desired.y - cur.y) * t,
        cur.z + (desired.z - cur.z) * t,
      ),
      rotation: this.sideRotation,
    };
  }
}
