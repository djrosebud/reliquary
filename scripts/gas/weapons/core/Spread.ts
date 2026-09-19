/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {Vec3} from 'meta/worlds';

/**
 * Perturb a direction within a cone of the given half-angle (degrees), uniformly
 * over the cone's base disc. Used for shotgun spread and per-shot inaccuracy.
 *
 * The reference vector switches when `dir` is near-vertical to keep the cross
 * product non-degenerate.
 */
export function applyConeSpread(dir: Vec3, halfAngleDeg: number): Vec3 {
  const forward = dir.normalize();
  const reference = Math.abs(forward.y) > 0.99 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
  const right = forward.cross(reference).normalize();
  const up = right.cross(forward);

  const maxOffset = Math.tan((halfAngleDeg * Math.PI) / 180);
  const azimuth = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * maxOffset;
  const x = Math.cos(azimuth) * radius;
  const y = Math.sin(azimuth) * radius;

  return forward.add(right.mul(x)).add(up.mul(y)).normalize();
}
