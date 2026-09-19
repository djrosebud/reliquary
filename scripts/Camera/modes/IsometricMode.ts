/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * Fixed-angle view that follows the player. Set projection to Orthographic on
 * the CameraPlatformComponent for a true isometric look; this mode drives the
 * orthographic size and the dampened follow.
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

export class IsometricMode implements ICameraMode {
  public readonly type = CameraModeType.Isometric;

  public cameraDistance: number = 20;
  public cameraPitch: number = 50;
  public cameraYaw: number = 45;
  public orthoSize: number = 10;

  private isoRotation: Quaternion | null = null;
  private offsetDir: Vec3 | null = null;

  public onActivate(ctx: CameraModeContext, _tuning: CameraTuning): void {
    // Yaw about world Y then pitch about local X, decomposed so the ZXY Euler
    // order cannot introduce roll.
    this.isoRotation = Quaternion.fromEuler(new Vec3(0, this.cameraYaw, 0)).mul(
      Quaternion.fromEuler(new Vec3(-this.cameraPitch, 0, 0)),
    );
    this.offsetDir = this.isoRotation
      .mulVec3(Vec3.forward)
      .mul(-1)
      .normalize();

    if (ctx.cameraComponent) {
      ctx.cameraComponent.orthographicSize = this.orthoSize;
    }
  }


  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult | null {
    if (!this.isoRotation || !this.offsetDir) {
      return null;
    }

    const playerPos = ctx.targetTransform.worldPosition;
    const goalPos = playerPos.add(this.offsetDir.mul(this.cameraDistance));
    const cur = ctx.cameraTransform.worldPosition;

    // Dampen XZ only; instant Y keeps the camera from floating on jumps.
    let x = goalPos.x;
    let z = goalPos.z;
    if (tuning.followSpeed > 0) {
      const t = smoothingFactor(tuning.followSpeed, deltaTime);
      x = cur.x + (goalPos.x - cur.x) * t;
      z = cur.z + (goalPos.z - cur.z) * t;
    }

    return {
      position: new Vec3(x, goalPos.y, z),
      rotation: this.isoRotation,
    };
  }
}
