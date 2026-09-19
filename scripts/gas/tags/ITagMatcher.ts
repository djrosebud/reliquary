/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

export interface ITagMatcher {
  matches(queryTag: string | null, ownedTags: ReadonlySet<string>): boolean;
}
