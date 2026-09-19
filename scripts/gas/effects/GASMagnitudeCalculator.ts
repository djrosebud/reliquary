/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {EffectContext} from '../core/EffectContext';

// Abstract base for custom magnitude formulas. Subclass and override
// `calculate` to read multiple attributes / context fields and return a
// derived magnitude.
export abstract class GASMagnitudeCalculator {
  public abstract calculate(ctx: EffectContext): number;
}
