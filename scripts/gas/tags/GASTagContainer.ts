/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import {ExactTagMatcher} from './ExactTagMatcher';
import {HierarchicalTagMatcher} from './HierarchicalTagMatcher';
import type {ITagMatcher} from './ITagMatcher';

/**
 * Internal sub-manager — GASComponent creates one automatically at startup.
 * Configuration (initialTags / useHierarchicalMatcher) is supplied by GASComponent.
 *
 * Flat tag map with reference counting. Listeners are invoked only on the
 * 0→1 / 1→0 transitions; intermediate stack-adds do NOT re-fire.
 *
 * `useHierarchicalMatcher = true` (default) selects HierarchicalTagMatcher
 * (a strict superset of ExactTagMatcher); `false` falls back to Exact.
 */

export interface GASTagContainerOptions {
  initialTags?: ReadonlyArray<string>;
  useHierarchicalMatcher?: boolean;
}

type TagListener = (tag: string) => void;

export class GASTagContainer {
  public readonly initialTags: ReadonlyArray<string>;
  public readonly useHierarchicalMatcher: boolean;

  private readonly stacks: Map<string, number> = new Map<string, number>();
  private readonly tagSet: Set<string> = new Set<string>();
  private currentMatcher: ITagMatcher;

  private readonly tagAddedListeners: Set<TagListener> = new Set<TagListener>();
  private readonly tagRemovedListeners: Set<TagListener> = new Set<TagListener>();

  // Fires on ANY stack change (add / remove / stack-count delta), unlike the
  // add/remove listeners which only fire on 0<->1 presence transitions. The
  // authority uses this to know when to republish the replicated tag snapshot,
  // so stack-only changes (e.g. 1->2) are not missed.
  private readonly changedListeners: Set<() => void> = new Set<() => void>();

  constructor(options: GASTagContainerOptions = {}) {
    this.initialTags = options.initialTags ?? [];
    this.useHierarchicalMatcher = options.useHierarchicalMatcher ?? true;
    this.currentMatcher = this.useHierarchicalMatcher
      ? new HierarchicalTagMatcher()
      : new ExactTagMatcher();

    for (const tag of this.initialTags) {
      if (tag != null) {
        this.addTag(tag);
      }
    }
  }

  public get matcher(): ITagMatcher {
    return this.currentMatcher;
  }

  public set matcher(value: ITagMatcher | null) {
    this.currentMatcher = value ?? new ExactTagMatcher();
  }

  public addTag(tag: string | null, stacks: number = 1): void {
    if (tag == null || stacks <= 0) {
      return;
    }
    const wasNew = !this.stacks.has(tag);
    this.stacks.set(tag, (this.stacks.get(tag) ?? 0) + stacks);
    if (wasNew) {
      this.tagSet.add(tag);
      this.emitTagAdded(tag);
    }
    this.emitChanged();
  }

  public removeTag(tag: string | null, stacks: number = 1): void {
    if (tag == null || stacks <= 0) {
      return;
    }
    const current = this.stacks.get(tag);
    if (current === undefined) {
      return;
    }
    const newCount = current - stacks;
    if (newCount <= 0) {
      this.stacks.delete(tag);
      this.tagSet.delete(tag);
      this.emitTagRemoved(tag);
    } else {
      this.stacks.set(tag, newCount);
    }
    this.emitChanged();
  }

  // Proxy-side entry point: reconcile the local tag set against the authority's
  // replicated snapshot. Tags absent from `desired` are removed; present tags
  // have their stack count overwritten. Fires onTagAdded / onTagRemoved only on
  // 0<->1 presence transitions, matching normal add/remove semantics, so UI
  // bound to those listeners behaves identically on proxies. Does NOT emit the
  // internal `changed` signal — proxies never republish.
  public applyReplicatedTags(desired: ReadonlyMap<string, number>): void {
    for (const tag of [...this.stacks.keys()]) {
      if (!desired.has(tag)) {
        this.stacks.delete(tag);
        this.tagSet.delete(tag);
        this.emitTagRemoved(tag);
      }
    }
    for (const [tag, count] of desired) {
      if (count <= 0) {
        continue;
      }
      const wasPresent = this.stacks.has(tag);
      this.stacks.set(tag, count);
      if (!wasPresent) {
        this.tagSet.add(tag);
        this.emitTagAdded(tag);
      }
    }
  }

  public hasTag(tag: string | null): boolean {
    return tag != null && this.currentMatcher.matches(tag, this.tagSet);
  }

  public getStackCount(tag: string): number {
    return this.stacks.get(tag) ?? 0;
  }

  public getAllTags(): ReadonlySet<string> {
    return this.tagSet;
  }

  public hasAllTags(tags: Iterable<string>): boolean {
    for (const tag of tags) {
      if (!this.hasTag(tag)) {
        return false;
      }
    }
    return true;
  }

  public hasAnyTag(tags: Iterable<string>): boolean {
    for (const tag of tags) {
      if (this.hasTag(tag)) {
        return true;
      }
    }
    return false;
  }

  public hasNoneOfTags(tags: Iterable<string>): boolean {
    for (const tag of tags) {
      if (this.hasTag(tag)) {
        return false;
      }
    }
    return true;
  }

  public onTagAdded(listener: TagListener): () => void {
    this.tagAddedListeners.add(listener);
    return (): void => {
      this.tagAddedListeners.delete(listener);
    };
  }

  public onTagRemoved(listener: TagListener): () => void {
    this.tagRemovedListeners.add(listener);
    return (): void => {
      this.tagRemovedListeners.delete(listener);
    };
  }

  public onChanged(listener: () => void): () => void {
    this.changedListeners.add(listener);
    return (): void => {
      this.changedListeners.delete(listener);
    };
  }

  private emitChanged(): void {
    for (const listener of this.changedListeners) {
      listener();
    }
  }

  private emitTagAdded(tag: string): void {
    for (const listener of this.tagAddedListeners) {
      listener(tag);
    }
  }

  private emitTagRemoved(tag: string): void {
    for (const listener of this.tagRemovedListeners) {
      listener(tag);
    }
  }
}
