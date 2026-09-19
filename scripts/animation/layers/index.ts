/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

import type {AnimLayer} from './AnimLayer';
import {AirborneLayer} from './AirborneLayer';
import {AttackLayer} from './AttackLayer';
import {DeathLayer} from './DeathLayer';
import {RangedLayer} from './RangedLayer';
import {TakeDamageLayer} from './TakeDamageLayer';

export {AnimLayer, AnimTag, type AnimFrame, type AnimLayerHost, type PlayOptions} from './AnimLayer';
export {AnimAction, TriggeredLayer} from './TriggeredLayer';
export {AirborneLayer} from './AirborneLayer';
export {AttackLayer, AttackTuning} from './AttackLayer';
export {DeathLayer} from './DeathLayer';
export {RangedLayer, RangedTuning} from './RangedLayer';
export {TakeDamageLayer} from './TakeDamageLayer';

/**
 * Every animation layer the character stack ships, in mount order.
 *
 * THIS IS THE ONLY PLACE A LAYER IS NAMED OUTSIDE ITS OWN FILE. Adding one — a magic layer, a
 * block layer, a second weapon family — is a new file beside these plus one line here; the
 * host, the gameplay code and the other layers are untouched. A layer listed here whose
 * `layerName` is not mounted on the character's AnimatorComponent throws at start rather than
 * failing silently, so a typo or a missing `additionalLayers` entry surfaces immediately.
 *
 * A fresh instance per character: layers hold per-character state (combo index, launch time,
 * death flag), so they must not be shared between entities.
 */
export function createAnimLayers(): AnimLayer[] {
  return [
    new AirborneLayer(),
    new AttackLayer(),
    new RangedLayer(),
    new TakeDamageLayer(),
    new DeathLayer(),
  ];
}
