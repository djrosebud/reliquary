/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {CollisionLayerMask, PhysicsService, TransformComponent} from 'meta/worlds';
import type {Entity, Maybe, Vec3} from 'meta/worlds';
import {GASComponent} from '../../core/GASComponent';

/** Tag-based target filter (uses the candidate's GAS tags). */
export interface TargetFilter {
  required?: string[]; // candidate must have ALL of these
  blocked?: string[]; // candidate must have NONE of these
}

export interface TargetQueryOptions {
  // Collision layers to search. Defaults to every layer: characters, props and
  // NPCs are routinely authored on different ones (a player capsule sits on
  // Layer1, a freshly created collider on Layer2), and the GAS + tag filtering
  // below is what decides who is a target. Narrow it only as an optimisation.
  collisionLayerMask?: CollisionLayerMask;
  exclude?: Entity; // skip this entity (e.g. the caster)
}

/**
 * The physics query reports colliders and physics bodies, which on a character
 * are child entities — a player's capsule and its KinematicCharacter body both
 * hang off the root that actually carries the GASComponent. Walk up to the
 * first ancestor that has one; that entity is the target.
 */
function resolveGasEntity(hit: Entity): {entity: Entity; gas: GASComponent} | null {
  let current: Maybe<Entity> = hit;
  while (current != null && !current.isDestroyed()) {
    const gas = current.getComponent(GASComponent);
    if (gas) {
      return {entity: current, gas};
    }
    current = current.parent;
  }
  return null;
}

/**
 * Every GAS-bearing entity overlapping the sphere that passes `filter`, paired
 * with its squared distance from `origin` and sorted nearest-first.
 *
 * Both reported arrays are scanned: `overlappingActorEntities` misses a
 * collider whose physics body lives on a sibling, `overlappingShapeEntities`
 * misses a body with no collider of its own. Several hits routinely resolve to
 * one character, so results are deduplicated by the resolved entity.
 */
async function collectTargets(
  origin: Vec3,
  radius: number,
  filter: TargetFilter,
  options?: TargetQueryOptions,
): Promise<Array<{entity: Entity; distSq: number}>> {
  const exclude = options?.exclude;
  const output = await PhysicsService.get().sphereOverlapQuery({
    center: origin,
    radius,
    collisionLayerMask: options?.collisionLayerMask ?? CollisionLayerMask.AllLayers,
    reportOverlappingEntities: true,
    includeTriggers: true,
    excludeEntities: exclude ? ([exclude] as [Entity]) : undefined,
  });

  const seen = new Set<Entity>();
  const matches: Array<{entity: Entity; distSq: number}> = [];
  for (const hit of [...output.overlappingActorEntities, ...output.overlappingShapeEntities]) {
    if (!hit || hit.isDestroyed()) {
      continue;
    }
    const resolved = resolveGasEntity(hit);
    if (!resolved) {
      continue;
    }
    const {entity, gas} = resolved;
    // The query's excludeEntities only drops the caster's own entity; its
    // collider and body children still come back and resolve up to it here.
    if (entity === exclude || seen.has(entity)) {
      continue;
    }
    seen.add(entity);
    if (filter.required && filter.required.length > 0 && !gas.hasAllTags(filter.required)) {
      continue;
    }
    if (filter.blocked && filter.blocked.length > 0 && !gas.hasNoneOfTags(filter.blocked)) {
      continue;
    }
    const transform = entity.getComponent(TransformComponent);
    if (!transform) {
      continue;
    }
    matches.push({entity, distSq: transform.worldPosition.distanceSquared(origin)});
  }
  matches.sort((a, b) => a.distSq - b.distSq);
  return matches;
}

/**
 * Shared, cross-ability target selection. Returns the nearest entity within
 * `radius` of `origin` that has a GASComponent matching `filter` (by GAS tags).
 * That is the GAS-owning entity, not the collider that was hit — see
 * {@link resolveGasEntity}.
 *
 * Genre-agnostic: any ability (projectile homing, melee, aura) can use it.
 * Async because it runs a physics overlap query — await it before acting (e.g.
 * pick the target, then launch a homing projectile at it).
 */
export async function nearestTargetInRadius(
  origin: Vec3,
  radius: number,
  filter: TargetFilter,
  options?: TargetQueryOptions,
): Promise<Entity | null> {
  const matches = await collectTargets(origin, radius, filter, options);
  return matches.length > 0 ? matches[0].entity : null;
}

/**
 * Like {@link nearestTargetInRadius}, but returns every matching entity within
 * `radius` of `origin`, sorted nearest-first.
 */
export async function allTargetsInRadius(
  origin: Vec3,
  radius: number,
  filter: TargetFilter,
  options?: TargetQueryOptions,
): Promise<Entity[]> {
  const matches = await collectTargets(origin, radius, filter, options);
  return matches.map(m => m.entity);
}
