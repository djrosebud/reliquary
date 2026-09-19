/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * Fixed placement that optionally pans toward and looks at the player.
 * The camera stays wherever the entity was authored in the scene.
 */

import {Quaternion, Vec3} from 'meta/worlds';
import {
  type CameraModeContext,
  type CameraModeResult,
  CameraModeType,
  type CameraTuning,
  type ICameraMode,
  smoothingFactor,
} from '../CameraModeTypes';

export class StaticMode implements ICameraMode {
  public readonly type = CameraModeType.Static;

  public enableSlowFollow: boolean = false;
  public lookAtPlayer: boolean = true;

  private panPosition: Vec3 | null = null;

  public onActivate(ctx: CameraModeContext, _tuning: CameraTuning): void {
    // Restart the pan from the authored pose rather than from wherever the
    // previous mode left the camera.
    this.panPosition = ctx.authoredPosition;
  }

  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult {
    const playerPos = ctx.targetTransform.worldPosition;
    let position = this.panPosition ?? ctx.authoredPosition;

    if (this.enableSlowFollow) {
      const t = smoothingFactor(Math.max(tuning.followSpeed, 0.0001), deltaTime);
      position = new Vec3(
        position.x + (playerPos.x - position.x) * t,
        position.y,
        position.z + (playerPos.z - position.z) * t,
      );
    }
    this.panPosition = position;

    return {
      position,
      rotation: this.lookAtPlayer
        ? Quaternion.lookRotation(playerPos.sub(position), Vec3.up)
        : ctx.authoredRotation,
    };
  }
}
