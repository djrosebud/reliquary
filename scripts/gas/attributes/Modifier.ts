/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {ModifierOperator} from '../core/Enums';

// Structural interface for the source-effect back-reference. Avoids importing
// Effect to keep the dependency graph acyclic; Effect satisfies this shape
// structurally via its public stackCount field.
export interface ModifierSourceEffect {
  readonly stackCount: number;
}

// An active modifier on an attribute. The aggregator reads stackCount off
// sourceEffect to compute `magnitude * stack`. sourceEffect may be null
// (ad-hoc modifier constructed by hand, treated as 1 stack).
export class Modifier {
  public readonly attributeName: string;
  public readonly operator: ModifierOperator;
  public readonly magnitude: number;
  public readonly sourceEffect: ModifierSourceEffect | null;

  constructor(
    attributeName: string,
    operator: ModifierOperator,
    magnitude: number,
    sourceEffect: ModifierSourceEffect | null = null,
  ) {
    this.attributeName = attributeName;
    this.operator = operator;
    this.magnitude = magnitude;
    this.sourceEffect = sourceEffect;
  }
}
