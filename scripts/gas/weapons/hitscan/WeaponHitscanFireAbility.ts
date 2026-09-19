/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {
  CastMode,
  CollisionLayerMask,
  PhysicsService,
  type Entity,
  type Vec3,
} from 'meta/worlds';
import {GASComponent} from '../../core/GASComponent';
import {WeaponFireAbilityBase} from '../core/WeaponFireAbilityBase';
import type {WeaponAbilitySpec} from '../core/WeaponSetup';
import type {
  WeaponConfigProvider,
  WeaponFireConfigBase,
} from '../core/WeaponFireAbilityBase';

/** Target filter matched against the candidate's GAS tags. */
export interface TagFilter {
  /** Target must have ALL of these. */
  required?: string[];

  /** Target must have NONE of these. */
  blocked?: string[];
}

/**
 * One resolved hit. Carries everything the ability already computed so the game
 * can express any damage model without the ability knowing about it.
 */
export interface HitResult {
  /** Apply the damage effect to this — the GAS-owning root, not the collider. */
  gasEntity: Entity;

  /** The exact collider hit, often a child of `gasEntity` → headshot / limb logic. */
  colliderEntity: Entity;

  hitPoint: Vec3;

  /** Ray origin → hit distance, for damage falloff. */
  distance: number;

  /** 0-based order along the ray, for per-pierce falloff. */
  hitIndex: number;

  direction: Vec3;
}

/**
 * What a hitscan shot needs on top of the shared weapon config: how far the ray
 * reaches, how many targets it may pass through, and what a hit means.
 */
export interface HitscanFireConfig extends WeaponFireConfigBase {
  /** Max trace distance in meters. */
  range: number;

  /** Targets one ray may damage. 1 = no penetration; >1 = pierce. */
  maxHits?: number;

  /** Entities the ray ignores. At most 4 are honored; extras are dropped. */
  excludeEntities?: Entity[];

  /** Which hits count as targets. Omit = any GAS entity. */
  targetFilter?: TagFilter;

  /**
   * Invoked once per valid target, closest-first. The game applies its damage
   * effect here and may shape it by collider, distance, and hit index.
   */
  onHit(hit: HitResult): void;
}

/** Supplies the per-shot config. Implemented by the weapon component. */
export type HitscanConfigProvider = WeaponConfigProvider<HitscanFireConfig>;

/**
 * Extra hit slots requested on top of `maxHits`, so non-target colliders (walls,
 * props, the wielder's body) cannot consume the whole result buffer.
 */
const NON_TARGET_HIT_HEADROOM = 5;

/**
 * Instant-trace delivery. Everything around the shot — cooldown, burst, pellets,
 * spread, muzzle — comes from {@link WeaponFireAbilityBase}; this class is only
 * the ray and what it resolves to.
 *
 * It applies no damage: `config.onHit` is the game's, called once per valid
 * target, closest-first.
 */
export class WeaponHitscanFireAbility extends WeaponFireAbilityBase<HitscanFireConfig> {
  private readonly physics = PhysicsService.get();

  /**
   * One ray: trace, keep only GAS entities passing the tag filter, de-dup a
   * target's child colliders, and invoke `onHit` for up to `maxHits` targets
   * closest-first.
   */
  protected override async deliver(
    config: HitscanFireConfig,
    origin: Vec3,
    direction: Vec3,
  ): Promise<void> {
    const owner = this.ownerGas;
    const maxHits = Math.max(1, Math.floor(config.maxHits ?? 1));
    const exclude = config.excludeEntities ?? [owner.entity];

    // Always over-fetch, even for a single-target weapon: CastMode.ClosestHit
    // returns ONE hit, and on an avatar that hit is routinely the shooter's own
    // body — excludeEntities covers the root entity, never its collider
    // children. Discarding it would silently eat the shot.
    const result = await this.physics.rayCast({
      mode: CastMode.UnsortedHits,
      origin,
      dir: direction,
      distance: config.range,
      collisionLayerMask: CollisionLayerMask.AllLayers,
      includeTriggers: false,
      excludeEntities: toExcludeTuple(exclude),
      maxUnsortedHits: maxHits + NON_TARGET_HIT_HEADROOM,
    });
    if (owner.entity.isDestroyed()) {
      return;
    }
    if (!result.hasHitSomething || !result.hits || result.hits.length === 0) {
      return;
    }
    const hits = [...result.hits].sort((a, b) => a.distance - b.distance);

    const ownerEntity = owner.entity;
    const damaged: Entity[] = [];
    for (const hit of hits) {
      const collider = hit.actorEntity;
      if (!collider || collider.isDestroyed()) {
        continue;
      }
      const gasEntity = findGasEntity(collider);

      // The wielder is reached through its collider children, which the raycast
      // exclude list cannot cover — this is what prevents self-hits.
      if (gasEntity === ownerEntity) {
        continue;
      }
      const targetGas = gasEntity?.getComponent(GASComponent) ?? null;
      if (!gasEntity || !targetGas || !passesFilter(targetGas, config.targetFilter)) {
        // A penetrating shot walks past cover; a single-target shot stops on it.
        if (maxHits > 1) {
          continue;
        }
        return;
      }
      if (damaged.indexOf(gasEntity) >= 0) {
        continue; // child colliders of one target count as a single hit
      }
      const hitIndex = damaged.length;
      damaged.push(gasEntity);
      config.onHit({
        gasEntity,
        colliderEntity: collider,
        hitPoint: origin.add(direction.mul(hit.distance)),
        distance: hit.distance,
        hitIndex,
        direction,
      });
      if (damaged.length >= maxHits) {
        return;
      }
    }
  }
}

/** Ability pair granted for a hitscan weapon. */
export const HITSCAN_ABILITIES: WeaponAbilitySpec = {
  fireAbility: WeaponHitscanFireAbility,
  fireAbilityName: 'weapon.hitscan.fire',
  reloadAbilityName: 'weapon.hitscan.reload',
};

/** True when the target's GAS tags satisfy the filter. No filter passes everything. */
function passesFilter(gas: GASComponent, filter?: TagFilter): boolean {
  if (!filter) {
    return true;
  }
  if (filter.required && filter.required.length > 0 && !gas.hasAllTags(filter.required)) {
    return false;
  }
  if (filter.blocked && filter.blocked.length > 0 && !gas.hasNoneOfTags(filter.blocked)) {
    return false;
  }
  return true;
}

/**
 * Walk up from a hit collider to the entity carrying the GASComponent — colliders
 * are frequently descendants of the GAS-owning root.
 */
function findGasEntity(entity: Entity): Entity | null {
  let current: Entity | null = entity;
  while (current) {
    if (current.getComponent(GASComponent)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** rayCast types excludeEntities as a 1–4 element tuple, not an array. */
type ExcludeEntities =
  | [Entity]
  | [Entity, Entity]
  | [Entity, Entity, Entity]
  | [Entity, Entity, Entity, Entity];

/**
 * Build the tuple shape rayCast wants. It honors AT MOST 4 excludes — entities
 * beyond the fourth are silently dropped, so callers must pass at most 4.
 */
function toExcludeTuple(list: Entity[]): ExcludeEntities | undefined {
  switch (Math.min(list.length, 4)) {
    case 1:
      return [list[0]];
    case 2:
      return [list[0], list[1]];
    case 3:
      return [list[0], list[1], list[2]];
    case 4:
      return [list[0], list[1], list[2], list[3]];
    default:
      return undefined;
  }
}
