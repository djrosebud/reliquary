/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * Orbit locked to the player's facing direction. Ignores look input entirely,
 * so the whole game is playable with a single stick.
 */

import {
  type CameraModeContext,
  CameraModeType,
  type CameraTuning,
  facingYawDegrees,
} from '../CameraModeTypes';
import {OrbitCameraModeBase} from './OrbitCameraModeBase';

export class AutoFollowMode extends OrbitCameraModeBase {
  public readonly type = CameraModeType.AutoFollow;

  public override onActivate(
    ctx: CameraModeContext,
    tuning: CameraTuning,
  ): void {
    ctx.yaw = facingYawDegrees(ctx.targetTransform);
    ctx.pitch = tuning.defaultPitch;
    super.onActivate(ctx, tuning);
  }

  protected updateAngles(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    _deltaTime: number,
  ): void {
    ctx.yaw = facingYawDegrees(ctx.targetTransform);
    ctx.pitch = tuning.defaultPitch;
  }
}
