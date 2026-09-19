/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {ITagMatcher} from './ITagMatcher';

/**
 * Hierarchical matching: a query matches if it is an ancestor of an owned tag
 * (split on '.') or equal to it.
 *
 *   query "status"          matches owned containing "status.burning" / "status.burn.heavy"
 *   query "status.burning"  matches owned containing "status.burning"            (equal)
 *   query "status.burning"  does NOT match owned containing only "status"        (parents do not grant children)
 *   query "stat"            does NOT match owned containing "status"             (not a path segment)
 *
 * Strict superset of ExactTagMatcher — for the equal case, both behave identically.
 */
export class HierarchicalTagMatcher implements ITagMatcher {
  public matches(queryTag: string | null, ownedTags: ReadonlySet<string>): boolean {
    if (queryTag == null) {
      return false;
    }
    const q = queryTag;
    if (q.length === 0) {
      return false;
    }

    for (const owned of ownedTags) {
      if (owned == null) {
        continue;
      }
      if (owned === q) {
        return true;
      }
      // owned must start with `query + '.'` for query to be considered an ancestor of owned.
      if (owned.length > q.length && owned[q.length] === '.' && owned.startsWith(q)) {
        return true;
      }
    }
    return false;
  }
}
