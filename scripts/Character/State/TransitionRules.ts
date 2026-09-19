/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Character Scripts v1

export interface TransitionRule {
  to: string;
  condition: () => boolean;
}

export interface StateDefinition {
  id: string;
  transitions: TransitionRule[];
  allowedFrom?: string[];
  canEnter?: () => boolean;
  onEnter?: () => void;
  onUpdate?: (dt: number) => void;
  onExit?: () => void;
}
