/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

export enum DurationPolicy {
  Instant = 'Instant',
  Durational = 'Durational',
  Infinite = 'Infinite',
}

export enum ModifierOperator {
  Add = 'Add',
  Multiply = 'Multiply',
  Override = 'Override',
}

export enum MagnitudeMode {
  Scalar = 'Scalar',
  AttributeBased = 'AttributeBased',
  Custom = 'Custom',
}

export enum MagnitudeAttributeSource {
  Source = 'Source',
  Target = 'Target',
}

// Stacking semantics — four independent enums, orthogonally configured.

export enum StackingPolicy {
  // Each apply creates an independent Effect instance.
  None = 'None',

  // Same (Source, Data) merges; different Sources each occupy their own slot.
  AggregateBySource = 'AggregateBySource',

  // Same Data merges, regardless of Source.
  AggregateByTarget = 'AggregateByTarget',
}

export enum StackDurationRefreshPolicy {
  // Duration is set on first apply only; stacking does not refresh it.
  NeverRefresh = 'NeverRefresh',

  // Each stack-add resets RemainingDuration to Data.Duration.
  RefreshOnAdd = 'RefreshOnAdd',
}

export enum StackPeriodResetPolicy {
  // Period countdown continues uninterrupted across stack-adds.
  NeverReset = 'NeverReset',

  // Each stack-add resets the period countdown to zero.
  ResetOnAdd = 'ResetOnAdd',
}

export enum StackExpirationPolicy {
  // When Duration expires, the entire stack is cleared at once.
  ClearEntireStack = 'ClearEntireStack',

  // When Duration expires, decrement StackCount by 1, reset Duration, and keep ticking.
  RemoveSingleStack = 'RemoveSingleStack',
}
