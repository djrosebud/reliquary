/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {GameplayCueContext} from './GameplayCueContext';

/**
 * A handler declares its tagPrefix; the CueManager routes any cue whose tag
 * is the prefix or a descendant of it to the handler. For example, a handler
 * with `tagPrefix = "cue.vfx"` receives all `"cue.vfx.*"` cues plus the bare
 * `"cue.vfx"` cue. Game-side implementations: VfxCueHandler, AudioCueHandler,
 * ScreenShakeCueHandler, etc.
 */
export interface IGameplayCueHandler {
  readonly tagPrefix: string;
  handleCue(tag: string, ctx: GameplayCueContext): void;
}
