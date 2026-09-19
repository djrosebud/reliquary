/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import type {GASEffectData} from '../effects/GASEffectData';

export interface GASAbilityDataInit {
  abilityId?: string;
  cooldown?: number;
  costEffect?: GASEffectData | null;
  tagsAppliedToOwner?: string[];
  requiredTags?: string[];
  blockedByTags?: string[];
  gameplayCueTagsOnActivate?: string[];
  gameplayCueTagsOnEnd?: string[];
}

export class GASAbilityData {
  public abilityId: string;
  public cooldown: number;
  public costEffect: GASEffectData | null;
  public tagsAppliedToOwner: string[];
  public requiredTags: string[];
  public blockedByTags: string[];
  public gameplayCueTagsOnActivate: string[];
  public gameplayCueTagsOnEnd: string[];

  constructor(init: GASAbilityDataInit = {}) {
    this.abilityId = init.abilityId ?? '';
    this.cooldown = init.cooldown ?? 0;
    this.costEffect = init.costEffect ?? null;
    this.tagsAppliedToOwner = init.tagsAppliedToOwner ?? [];
    this.requiredTags = init.requiredTags ?? [];
    this.blockedByTags = init.blockedByTags ?? [];
    this.gameplayCueTagsOnActivate = init.gameplayCueTagsOnActivate ?? [];
    this.gameplayCueTagsOnEnd = init.gameplayCueTagsOnEnd ?? [];
  }
}
