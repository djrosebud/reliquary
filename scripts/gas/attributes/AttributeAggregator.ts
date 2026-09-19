/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {ModifierOperator} from '../core/Enums';
import type {Modifier} from './Modifier';

// CurrentValue =
//   hasOverride
//     ? overrideValue
//     : (baseValue + Σ Add·stack) × (1 + Σ Mul·stack)
//   clamped to [min, max].
//
// Add and Multiply scale by Effect.StackCount; Override does not (an
// "override to X" is layer-independent). Multiply is additive-multiplicative:
// three +25% stacks yield +75%, not (1.25)^3.
export const AttributeAggregator = {
  aggregate(
    baseValue: number,
    modifiers: ReadonlyArray<Modifier>,
    min: number,
    max: number,
  ): number {
    let additive = 0;
    let multiplicative = 0;
    let hasOverride = false;
    let overrideValue = 0;

    for (const mod of modifiers) {
      const stack = mod.sourceEffect?.stackCount ?? 1;
      const effectiveMagnitude = mod.magnitude * stack;

      switch (mod.operator) {
        case ModifierOperator.Add:
          additive += effectiveMagnitude;
          break;
        case ModifierOperator.Multiply:
          multiplicative += effectiveMagnitude;
          break;
        case ModifierOperator.Override:
          hasOverride = true;
          overrideValue = mod.magnitude;
          break;
      }
    }

    const result = hasOverride
      ? overrideValue
      : (baseValue + additive) * (1 + multiplicative);
    return Math.min(Math.max(result, min), max);
  },
};
