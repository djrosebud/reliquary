/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {GASAttributeData} from './GASAttributeData';
import type {Modifier} from './Modifier';

export class GASAttribute {
  public readonly data: GASAttributeData;
  public baseValue: number;
  public currentValue: number;

  private readonly modifierList: Modifier[] = [];

  constructor(data: GASAttributeData) {
    this.data = data;
    this.baseValue = data.defaultValue;
    this.currentValue = data.defaultValue;
  }

  public get modifiers(): ReadonlyArray<Modifier> {
    return this.modifierList;
  }

  public addModifier(mod: Modifier): void {
    this.modifierList.push(mod);
  }

  public removeModifier(mod: Modifier): boolean {
    const idx = this.modifierList.indexOf(mod);
    if (idx < 0) {
      return false;
    }
    this.modifierList.splice(idx, 1);
    return true;
  }
}
