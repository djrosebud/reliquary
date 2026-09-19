/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {GameplayCueContext} from './GameplayCueContext';
import type {IGameplayCueHandler} from './IGameplayCueHandler';

/**
 * Cue routing manager. Multiple handlers may listen to the same prefix (VFX
 * and SFX can both respond to a `cue.hit_spark` tag, for example). Prefix
 * matching follows '.'-segmented ancestor semantics, identical to
 * HierarchicalTagMatcher but for a single tag rather than a set.
 */
export class GameplayCueManager {
  private readonly handlers: IGameplayCueHandler[] = [];

  public registerHandler(handler: IGameplayCueHandler): void {
    if (this.handlers.indexOf(handler) >= 0) {
      return;
    }
    this.handlers.push(handler);
  }

  public unregisterHandler(handler: IGameplayCueHandler): void {
    const idx = this.handlers.indexOf(handler);
    if (idx < 0) {
      return;
    }
    this.handlers.splice(idx, 1);
  }

  public executeCue(tag: string, ctx: GameplayCueContext): void {
    for (const handler of this.handlers) {
      if (handler.tagPrefix.length === 0) {
        continue;
      }
      if (isDescendantOrEqual(handler.tagPrefix, tag)) {
        handler.handleCue(tag, ctx);
      }
    }
  }
}

// `tag` is the prefix itself or its descendant ('.'-segmented).
function isDescendantOrEqual(prefix: string, tag: string): boolean {
  if (prefix === tag) {
    return true;
  }
  if (prefix.length === 0) {
    return false;
  }
  return (
    tag.length > prefix.length && tag[prefix.length] === '.' && tag.startsWith(prefix)
  );
}
