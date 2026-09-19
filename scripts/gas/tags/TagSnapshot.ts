/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {property, serializable} from 'meta/worlds';

/**
 * Network-replicable snapshot of one owned tag and its stack count.
 *
 * The tag *set* is dynamic (tags come and go at runtime), so unlike attributes
 * there is no fixed code-derived structure — the full owned set is flattened
 * into a `readonly TagSnapshot[]` @property on GASComponent and replicated as a
 * whole. Proxies reconcile their local GASTagContainer against this list.
 *
 * All fields are readonly with defaults and the constructor args are optional so
 * the class can be default-constructed by the serialization layer.
 */
@serializable()
export class TagSnapshot {
  @property()
  readonly name: string = '';

  @property()
  readonly stackCount: number = 0;

  constructor(name?: string, stackCount?: number) {
    if (name !== undefined) {
      this.name = name;
    }
    if (stackCount !== undefined) {
      this.stackCount = stackCount;
    }
  }
}
