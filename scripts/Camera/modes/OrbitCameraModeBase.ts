/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * Shared orbit rig for the modes that frame the player from behind
 * (ThirdPerson, Follow, AutoFollow). Subclasses only decide how yaw and pitch
 * evolve; the pivot, orbit placement, smoothing and collision are common.
 */

import {Quaternion, Vec3} from 'meta/worlds';
import {CameraCollision} from '../CameraCollision';
import {
  type CameraModeContext,
  type CameraModeResult,
  type CameraModeType,
  type CameraTuning,
  type ICameraMode,
  smoothingFactor,
  yawPitchRotation,
} from '../CameraModeTypes';

export abstract class OrbitCameraModeBase implements ICameraMode {
  public abstract readonly type: CameraModeType;

  /** Base rotation applied before the yaw/pitch orbit rotation. */
  public rotationOffset: Quaternion = new Quaternion(0, 0, 0, 1);

  protected readonly collision = new CameraCollision();
  protected smoothedYaw: number = 0;
  protected smoothedPitch: number = 0;
  private lastSmoothedPosition: Vec3 | null = null;

  public onActivate(ctx: CameraModeContext, tuning: CameraTuning): void {
    this.smoothedYaw = ctx.yaw;
    this.smoothedPitch = ctx.pitch;
    this.lastSmoothedPosition = null;
    this.collision.reset();
    this.collision.rebuildLayerMask();
    if (tuning.enableCollision && !this.hasCollisionLayers()) {
      console.warn(
        '[CameraManager] Collision enabled but no collision layers set.',
      );
    }
  }

  public onDeactivate(): void {
    this.collision.reset();
    this.lastSmoothedPosition = null;
  }

  public update(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): CameraModeResult {
    this.updateAngles(ctx, tuning, deltaTime);

    const targetPosition = ctx.targetTransform.worldPosition;
    const targetScale = ctx.targetTransform.worldScale;
    const maxScale = Math.max(targetScale.x, targetScale.y, targetScale.z);

    const pivotPosition = targetPosition.add(
      new Vec3(0, tuning.shoulderHeight * maxScale, 0),
    );

    // Smooth yaw and pitch as angles rather than slerping quaternions:
    // Quaternion.fromEuler flips hemisphere past 360 degrees of yaw, and slerp
    // then takes the long way around, swinging the camera backward mid-turn.
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

    const finalRotation = this.rotationOffset.mul(
      yawPitchRotation(this.smoothedYaw, this.smoothedPitch),
    );

    // Derive the orbit position from the smoothed rotation. Interpolating the
    // position directly produces artifacts: Vec3.lerp cuts chords so the camera
    // dips toward the player, and slerping the offset leaves the orbit plane
    // and tilts the view vertically.
    const orbitPosition = pivotPosition
      .add(finalRotation.mulVec3(new Vec3(tuning.shoulderOffset * maxScale, 0, 0)))
      .add(finalRotation.mulVec3(new Vec3(0, 0, tuning.targetDistance * maxScale)));

    const collidedPosition = tuning.enableCollision
      ? this.collision.resolve({
          pivotPosition,
          desiredCameraPosition: orbitPosition,
          scale: maxScale,
          deltaTime,
          targetEntity: ctx.targetEntity,
        })
      : orbitPosition;

    // Smooth only the radial distance, so a collision pull-in eases while the
    // orbit direction stays locked to the (already smoothed) rotation.
    let finalPosition = collidedPosition;
    if (tuning.translationSpeed > 0) {
      const t = smoothingFactor(tuning.translationSpeed, deltaTime);
      const orbitOffset = orbitPosition.sub(pivotPosition);
      const orbitMag = orbitOffset.magnitude();
      const desiredMag = collidedPosition.sub(pivotPosition).magnitude();
      const currentMag = (this.lastSmoothedPosition ?? collidedPosition)
        .sub(pivotPosition)
        .magnitude();
      const smoothedMag = currentMag + (desiredMag - currentMag) * t;

      finalPosition =
        orbitMag > 0.001
          ? pivotPosition.add(orbitOffset.mul(smoothedMag / orbitMag))
          : orbitPosition;
    }

    this.lastSmoothedPosition = finalPosition;

    return {position: finalPosition, rotation: finalRotation};
  }

  /** Advance `ctx.yaw` / `ctx.pitch` for this frame. */
  protected abstract updateAngles(
    ctx: CameraModeContext,
    tuning: CameraTuning,
    deltaTime: number,
  ): void;

  private hasCollisionLayers(): boolean {
    return this.collision.collisionLayers.length > 0;
  }
}
