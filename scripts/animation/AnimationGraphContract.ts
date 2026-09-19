/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 * @format
 */

// Animation Scripts v3

/**
 * AnimationGraphContract — the authored names of the BASE graph
 * (`Assets/Default/Standard_Character.animgraph`), which the host drives directly.
 *
 * Per-LAYER names are not here. Each layer in `animation/layers/` declares its own
 * `layerName`, `restState`, states and graph variables, because a layer that carries its own
 * names can be added or removed as one file. That also disposes of the trap this file used to
 * document: the pass-through state is spelled three different ways across the assets
 * (`empty state`, `Empty State`, `empty_state`), and with each spelling sitting next to the
 * layer it belongs to there is no shared table to pick the wrong row from.
 *
 * A wrong name still fails quietly at the state level — `requestTransitionToState` on an
 * unknown state is dropped and `setGraphVariable` on an unknown variable is a no-op — but a
 * wrong LAYER name now throws at start, because `AnimLayer.attach` fades the layer as its
 * first act and the SDK rejects a layer that is not mounted.
 *
 * Sibling of `animation/AnimKey.ts`, which is a different axis: that file is the set of
 * base-graph keys replicated through `WorldsCharacterStateReplication`. This file is the
 * base graph's variable names, replicated or not.
 */

// Values are authored graph names, so they keep the assets' capitalisation.
/* eslint-disable @typescript-eslint/naming-convention */

/**
 * Base-graph variables.
 *
 * All three are LOCAL on every client — deliberately absent from `animation/AnimKey.ts`, which
 * is the networked set: a replicated speed goes stale into a perpetual sprint, and direction
 * is recoverable from the replicated transform.
 */
export class AnimVar {
  /** Float: horizontal speed, the Blend Space 2D magnitude input. */
  static readonly SPEED = 'Speed';
  /** Float: movement direction in character space, the Blend Space 2D direction input. */
  static readonly MOVEMENT_DIRECTION_YAW = 'MovementDirectionYaw';
  /** Bool: blend locomotion by direction rather than by facing. */
  static readonly SHOULD_STRAFE = 'ShouldStrafe';
}

/* eslint-enable @typescript-eslint/naming-convention */
