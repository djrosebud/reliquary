/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {property, serializable} from 'meta/worlds';

/**
 * Network-replicable snapshot of one attribute's runtime values.
 *
 * Attribute *definitions* (name / min / max / default) come from code
 * (`getInitialAttributes`) and are identical on every client, so only the
 * dynamic base/current values need to replicate. These snapshots are carried in
 * a `readonly AttributeSnapshot[]` @property on GASComponent because @property
 * cannot replicate the Map that backs GASAttributeSet.
 *
 * All fields are readonly with defaults and the constructor args are optional so
 * the class can be default-constructed by the serialization layer.
 */
@serializable()
export class AttributeSnapshot {
  @property()
  readonly name: string = '';

  @property()
  readonly baseValue: number = 0;

  @property()
  readonly currentValue: number = 0;

  constructor(name?: string, baseValue?: number, currentValue?: number) {
    if (name !== undefined) {
      this.name = name;
    }
    if (baseValue !== undefined) {
      this.baseValue = baseValue;
    }
    if (currentValue !== undefined) {
      this.currentValue = currentValue;
    }
  }
}
