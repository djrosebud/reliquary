/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {ITagMatcher} from './ITagMatcher';

export class ExactTagMatcher implements ITagMatcher {
  public matches(queryTag: string | null, ownedTags: ReadonlySet<string>): boolean {
    return queryTag != null && ownedTags.has(queryTag);
  }
}
