/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {property, serializable, Vec3} from 'meta/worlds';
import type {Entity, Maybe} from 'meta/worlds';

/**
 * Network-serializable form of a cue firing, broadcast from the authority to
 * every client via GASComponent.RpcAllExecuteCue. GameplayCueContext carries
 * GASComponent (EffectActor) references which cannot cross the wire, so the
 * source / target are sent as Entity references (resolved back to GASComponent
 * on each receiver) and the spatial / intensity fields are sent by value.
 *
 * All fields are readonly with defaults and the constructor args are optional so
 * the class can be default-constructed by the serialization layer.
 */
@serializable()
export class CuePayload {
  @property()
  readonly tag: string = '';

  @property()
  readonly magnitude: number = 0;

  @property()
  readonly location: Vec3 = Vec3.zero;

  @property()
  readonly normal: Vec3 = new Vec3(0, 1, 0);

  @property()
  readonly sourceEntity: Maybe<Entity> = null;

  @property()
  readonly targetEntity: Maybe<Entity> = null;

  constructor(
    tag?: string,
    magnitude?: number,
    location?: Vec3,
    normal?: Vec3,
    sourceEntity?: Maybe<Entity>,
    targetEntity?: Maybe<Entity>,
  ) {
    if (tag !== undefined) {
      this.tag = tag;
    }
    if (magnitude !== undefined) {
      this.magnitude = magnitude;
    }
    if (location !== undefined) {
      this.location = location;
    }
    if (normal !== undefined) {
      this.normal = normal;
    }
    if (sourceEntity !== undefined) {
      this.sourceEntity = sourceEntity;
    }
    if (targetEntity !== undefined) {
      this.targetEntity = targetEntity;
    }
  }
}
