/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

// Structural interface for the source / target actor. Avoids importing
// GASComponent to keep the dependency graph acyclic; GASComponent satisfies
// this shape structurally via its public getAttributeValue method.
export interface EffectActor {
  getAttributeValue(name: string): number;
}

export class EffectContext {
  public readonly source: EffectActor | null;
  public readonly target: EffectActor;
  public readonly level: number;

  constructor(source: EffectActor | null, target: EffectActor, level: number = 1) {
    this.source = source;
    this.target = target;
    this.level = level;
  }
}
