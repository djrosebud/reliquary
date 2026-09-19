/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/** Bird's-eye view looking straight down at the player. */

import {Quaternion, Vec3} from 'meta/worlds';
import {
  type CameraModeContext,
  type CameraModeResult,
  CameraModeType,
  type CameraTuning,
  type ICameraMode,
  smoothingFactor,
} from '../CameraModeTypes';

export class TopDownMode implements ICameraMode {
  public readonly type = CameraModeType.TopDown;

  public cameraHeight: number = 15;

  // RUB coords: -90 about X swings the default -Z forward down to -Y.
  private readonly downRotation = Quaternion.fromEuler(new Vec3(-90, 0, 0));



  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult {
    const playerPos = ctx.targetTransform.worldPosition;
    const cur = ctx.cameraTransform.worldPosition;

    // Dampen XZ only. Y tracks instantly, otherwise the camera appears to float
    // whenever the player jumps or drops off a ledge.
    let x = playerPos.x;
    let z = playerPos.z;
    if (tuning.followSpeed > 0) {
      const t = smoothingFactor(tuning.followSpeed, deltaTime);
      x = cur.x + (playerPos.x - cur.x) * t;
      z = cur.z + (playerPos.z - cur.z) * t;
    }

    return {
      position: new Vec3(x, playerPos.y + this.cameraHeight, z),
      rotation: this.downRotation,
    };
  }
}
