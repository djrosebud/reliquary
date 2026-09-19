/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {EffectContext} from '../core/EffectContext';
import {ModifierOperator} from '../core/Enums';
import type {Effect} from '../effects/Effect';
import {AttributeAggregator} from './AttributeAggregator';
import {GASAttribute} from './GASAttribute';
import {GASAttributeData} from './GASAttributeData';
import type {Modifier} from './Modifier';

// Structural interface for the AttributeSet's owner. Avoids importing
// GASComponent to keep the dependency graph acyclic; GASComponent satisfies
// this shape structurally via its three invoke* bridge methods.
export interface AttributeSetOwner {
  invokePreAttributeChange(attributeName: string, newValue: number): number;
  invokePreAttributeBaseChange(attributeName: string, newValue: number): number;
  invokePostGameplayEffectExecute(
    ctx: EffectContext,
    attribute: GASAttribute,
    magnitudeDelta: number,
  ): void;
}

export interface GASAttributeSetOptions {
  owner: AttributeSetOwner;
  attributes?: ReadonlyArray<GASAttributeData>;
}

type AttributeChangedListener = (
  attributeName: string,
  oldValue: number,
  newValue: number,
) => void;

type AttributeBaseChangedListener = (
  attributeName: string,
  oldBase: number,
  newBase: number,
) => void;

type GameplayEffectExecutedListener = (
  ctx: EffectContext,
  attribute: GASAttribute,
  magnitudeDelta: number,
) => void;

export class GASAttributeSet {
  public readonly attributes: GASAttributeData[] = [];

  private readonly attributeMap: Map<string, GASAttribute> = new Map<string, GASAttribute>();
  private readonly owner: AttributeSetOwner;

  private readonly attributeChangedListeners: Set<AttributeChangedListener> =
    new Set<AttributeChangedListener>();
  private readonly attributeBaseChangedListeners: Set<AttributeBaseChangedListener> =
    new Set<AttributeBaseChangedListener>();
  private readonly gameplayEffectExecutedListeners: Set<GameplayEffectExecutedListener> =
    new Set<GameplayEffectExecutedListener>();

  constructor(options: GASAttributeSetOptions) {
    this.owner = options.owner;

    if (options.attributes) {
      for (const def of options.attributes) {
        if (def.attributeName.length === 0) {
          console.warn(`GASAttributeSet: GASAttributeData has empty name, skipping.`);
          continue;
        }
        if (this.attributeMap.has(def.attributeName)) {
          console.warn(`GASAttributeSet: duplicate attribute '${def.attributeName}', skipping.`);
          continue;
        }
        this.attributeMap.set(def.attributeName, new GASAttribute(def));
        this.attributes.push(def);
      }
    }
  }

  public hasAttribute(name: string): boolean {
    return this.attributeMap.has(name);
  }

  public getValue(name: string): number {
    return this.attributeMap.get(name)?.currentValue ?? 0;
  }

  public getBase(name: string): number {
    return this.attributeMap.get(name)?.baseValue ?? 0;
  }

  // Inject a new attribute at runtime (e.g. equipping a module that unlocks
  // a new stat, or test setup).
  public tryAddAttribute(data: GASAttributeData): boolean {
    if (data.attributeName.length === 0) {
      return false;
    }
    if (this.attributeMap.has(data.attributeName)) {
      return false;
    }
    this.attributeMap.set(data.attributeName, new GASAttribute(data));
    this.attributes.push(data);
    return true;
  }

  public getAttribute(name: string): GASAttribute | null {
    return this.attributeMap.get(name) ?? null;
  }

  public setBase(name: string, value: number): void {
    const attr = this.attributeMap.get(name);
    if (!attr) {
      return;
    }
    const oldBase = attr.baseValue;
    const newValue = this.owner.invokePreAttributeBaseChange(name, value);
    attr.baseValue = newValue;
    if (!isApproxEqual(oldBase, newValue)) {
      this.emitAttributeBaseChanged(name, oldBase, newValue);
    }
    this.recompute(name);
  }

  public applyInstantModifier(
    name: string,
    op: ModifierOperator,
    magnitude: number,
  ): void {
    const attr = this.attributeMap.get(name);
    if (!attr) {
      return;
    }
    const oldBase = attr.baseValue;
    let newBase: number;
    switch (op) {
      case ModifierOperator.Add:
        newBase = oldBase + magnitude;
        break;
      case ModifierOperator.Multiply:
        newBase = oldBase * (1 + magnitude);
        break;
      case ModifierOperator.Override:
        newBase = magnitude;
        break;
      default:
        newBase = oldBase;
        break;
    }
    this.setBase(name, newBase);
  }

  public addModifier(mod: Modifier): void {
    const attr = this.attributeMap.get(mod.attributeName);
    if (!attr) {
      return;
    }
    attr.addModifier(mod);
    this.recompute(mod.attributeName);
  }

  public removeModifier(mod: Modifier): void {
    const attr = this.attributeMap.get(mod.attributeName);
    if (!attr) {
      return;
    }
    if (attr.removeModifier(mod)) {
      this.recompute(mod.attributeName);
    }
  }

  public recompute(name: string): void {
    const attr = this.attributeMap.get(name);
    if (!attr) {
      return;
    }
    const oldCurrent = attr.currentValue;
    let newCurrent = AttributeAggregator.aggregate(
      attr.baseValue,
      attr.modifiers,
      attr.data.minValue,
      attr.data.maxValue,
    );
    newCurrent = this.owner.invokePreAttributeChange(name, newCurrent);
    newCurrent = Math.min(Math.max(newCurrent, attr.data.minValue), attr.data.maxValue);
    attr.currentValue = newCurrent;
    if (!isApproxEqual(oldCurrent, newCurrent)) {
      this.emitAttributeChanged(name, oldCurrent, newCurrent);
    }
  }

  public recomputeForEffect(effect: Effect): void {
    for (const mod of effect.appliedModifiers) {
      this.recompute(mod.attributeName);
    }
  }

  // Client-side (proxy) entry point: overwrite an attribute's replicated values
  // without running the aggregator — the authority already computed them. Fires
  // the same change listeners so UI bound to onAttribute[Base]Changed updates
  // identically on proxies. preAttributeChange is intentionally NOT invoked;
  // clamping / routing is authority-side gameplay logic. The attribute is
  // expected to already exist (definitions come from code on every client); an
  // unknown name is ignored.
  public applyReplicatedSnapshot(
    name: string,
    baseValue: number,
    currentValue: number,
  ): void {
    const attr = this.attributeMap.get(name);
    if (!attr) {
      return;
    }
    const oldBase = attr.baseValue;
    if (!isApproxEqual(oldBase, baseValue)) {
      attr.baseValue = baseValue;
      this.emitAttributeBaseChanged(name, oldBase, baseValue);
    }
    const oldCurrent = attr.currentValue;
    if (!isApproxEqual(oldCurrent, currentValue)) {
      attr.currentValue = currentValue;
      this.emitAttributeChanged(name, oldCurrent, currentValue);
    }
  }

  public invokePostExecute(
    ctx: EffectContext,
    attr: GASAttribute,
    magnitudeDelta: number,
  ): void {
    this.owner.invokePostGameplayEffectExecute(ctx, attr, magnitudeDelta);
    for (const listener of this.gameplayEffectExecutedListeners) {
      listener(ctx, attr, magnitudeDelta);
    }
  }

  public onAttributeChanged(listener: AttributeChangedListener): () => void {
    this.attributeChangedListeners.add(listener);
    return (): void => {
      this.attributeChangedListeners.delete(listener);
    };
  }

  public onAttributeBaseChanged(listener: AttributeBaseChangedListener): () => void {
    this.attributeBaseChangedListeners.add(listener);
    return (): void => {
      this.attributeBaseChangedListeners.delete(listener);
    };
  }

  public onGameplayEffectExecuted(listener: GameplayEffectExecutedListener): () => void {
    this.gameplayEffectExecutedListeners.add(listener);
    return (): void => {
      this.gameplayEffectExecutedListeners.delete(listener);
    };
  }

  private emitAttributeChanged(name: string, oldValue: number, newValue: number): void {
    for (const listener of this.attributeChangedListeners) {
      listener(name, oldValue, newValue);
    }
  }

  private emitAttributeBaseChanged(name: string, oldBase: number, newBase: number): void {
    for (const listener of this.attributeBaseChangedListeners) {
      listener(name, oldBase, newBase);
    }
  }
}

function isApproxEqual(a: number, b: number): boolean {
  if (a === b) {
    return true;
  }
  const tolerance = 1e-6 * Math.max(1, Math.abs(a));
  return Math.abs(a - b) <= tolerance;
}
