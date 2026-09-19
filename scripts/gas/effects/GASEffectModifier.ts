/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {EffectContext} from '../core/EffectContext';
import {MagnitudeAttributeSource, MagnitudeMode, ModifierOperator} from '../core/Enums';
import type {GASAttributeData} from '../attributes/GASAttributeData';
import type {GASMagnitudeCalculator} from './GASMagnitudeCalculator';

export interface GASEffectModifierInit {
  attribute?: GASAttributeData | null;
  operator?: ModifierOperator;
  mode?: MagnitudeMode;
  scalarValue?: number;
  sourceAttributeName?: string;
  attributeSource?: MagnitudeAttributeSource;
  coefficient?: number;
  customCalculator?: GASMagnitudeCalculator | null;
}

export class GASEffectModifier {
  public attribute: GASAttributeData | null;
  public operator: ModifierOperator;
  public mode: MagnitudeMode;

  public scalarValue: number;

  public sourceAttributeName: string;
  public attributeSource: MagnitudeAttributeSource;
  public coefficient: number;

  public customCalculator: GASMagnitudeCalculator | null;

  constructor(init: GASEffectModifierInit = {}) {
    this.attribute = init.attribute ?? null;
    this.operator = init.operator ?? ModifierOperator.Add;
    this.mode = init.mode ?? MagnitudeMode.Scalar;
    this.scalarValue = init.scalarValue ?? 0;
    this.sourceAttributeName = init.sourceAttributeName ?? '';
    this.attributeSource = init.attributeSource ?? MagnitudeAttributeSource.Source;
    this.coefficient = init.coefficient ?? 1;
    this.customCalculator = init.customCalculator ?? null;
  }

  public computeMagnitude(ctx: EffectContext): number {
    switch (this.mode) {
      case MagnitudeMode.Scalar:
        return this.scalarValue;
      case MagnitudeMode.AttributeBased:
        return this.computeAttributeBased(ctx);
      case MagnitudeMode.Custom:
        return this.customCalculator?.calculate(ctx) ?? 0;
      default:
        return 0;
    }
  }

  private computeAttributeBased(ctx: EffectContext): number {
    const owner =
      this.attributeSource === MagnitudeAttributeSource.Source ? ctx.source : ctx.target;
    if (owner == null || this.sourceAttributeName.length === 0) {
      return 0;
    }
    return owner.getAttributeValue(this.sourceAttributeName) * this.coefficient;
  }
}
