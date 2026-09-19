/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import {Vec3} from 'meta/worlds';

/** Frames of velocity averaged together. Higher is smoother but less responsive. */
const smoothingFrameCount: number = 10;
/** Speed magnitude (m/s) above which a sample is clamped, so a teleport cannot spike the blend. */
const maxSpeedClamp: number = 10.0;

/**
 * Fixed-window rolling average of a character's sampled velocity.
 *
 * It exists to hide NETWORK artifacts, not to smooth motion in general. A proxy does not run
 * the physics simulation — it only sees the entity's transform as it replicates, with dropped
 * frames, variable latency and jitter — so a raw per-frame position delta is noisy, and fed
 * straight to the animator it produces visible popping and over/under-shoot. Averaging those
 * position-derived samples back into a stable signal is what makes remote characters look
 * smooth.
 *
 * The local player has none of those problems: the owner reads the physics engine output
 * directly every frame, with no round-trip and no packet loss, so smoothing it would only add
 * latency and blur. Do not use this on the owner.
 *
 * Knows nothing about the animation system. The caller reads {@link averagedVelocity} and
 * routes it wherever it likes.
 */
export class CharacterSpeedSmoother {
  private readonly samples: Vec3[] = new Array<Vec3>(smoothingFrameCount).fill(Vec3.zero);
  private index: number = 0;
  private smoothed: Vec3 = Vec3.zero;

  /** Push this frame's raw world-space velocity and recompute the average. */
  public update(sampledVelocity: Vec3): void {
    this.samples[this.index] = sampledVelocity;
    this.index = (this.index + 1) % this.samples.length;

    let sum = Vec3.zero;
    for (const sample of this.samples) {
      sum = sum.add(sample);
    }
    const mean = sum.mul(1 / this.samples.length);
    const magnitude = mean.magnitude();
    this.smoothed = magnitude > maxSpeedClamp ? mean.normalize().mul(maxSpeedClamp) : mean;
  }

  /** The clamped, smoothed velocity. */
  public get averagedVelocity(): Vec3 {
    return this.smoothed;
  }
}
