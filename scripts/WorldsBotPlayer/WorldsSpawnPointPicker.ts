/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Bot Player Scripts v1

import {
  type Entity,
  EntityService,
  Quaternion,
  SpawnPointComponent,
  TransformComponent,
  Vec3,
  type Maybe,
} from 'meta/worlds';

/** A world-space placement resolved from a SpawnPoint. */
export interface SpawnPointPlacement {
  position: Vec3;
  rotation: Quaternion;
}

/**
 * Picks a world SpawnPoint the same way the engine does for a human player.
 *
 * WHY THIS EXISTS
 * SpawnPoint placement is applied by the engine's LOCAL-PLAYER creation path,
 * not by entity spawning. `WorldService.spawnTemplate()` only ever applies the
 * position/rotation you hand it, so an entity spawned from the player template
 * lands on the template's authored transform (typically the world origin) and
 * silently ignores every SpawnPoint in the scene. To place a bot where a human
 * would start, the spawn point has to be resolved in script and passed in.
 *
 * The `SpawnPointComponent` fields this needs (`allowStart`, `stateEnabled`,
 * `tags`) ARE exposed to the TS SDK, so this is pure TypeScript -- no C++, no
 * WSDK.
 *
 * SELECTION -- MIRRORS THE ENGINE
 * Filter to eligible spawn points, then take a uniformly random one, so bots
 * and humans draw from the same set and land the same way. Like the engine,
 * this does NOT avoid stacking -- there is no occupancy check, so two bots can
 * pick the same spawn point.
 *
 * A spawn point with no TransformComponent has no placement to give, so it is
 * excluded before the pick rather than after. Excluding it after would let one
 * malformed spawn point, drawn at random, drop the bot at the world origin even
 * though the scene is full of usable ones.
 *
 * TAGS
 * Passing a tag narrows to spawn points carrying it and, matching the engine's
 * travel-hint behaviour, ignores `allowStart`/`stateEnabled` for a tag match. If
 * no spawn point carries the tag, selection falls back to the untagged rules
 * rather than failing.
 *
 * COST
 * Each call queries the scene and crosses the native bridge. Fine per spawn;
 * do not call it per frame.
 */
export function pickPlayerSpawnPoint(
  tag?: Maybe<string>,
): Maybe<SpawnPointPlacement> {
  // Require a transform up front, so every survivor can actually be used. A
  // spawn point without one cannot place anything, and leaving it in the pool
  // would let a random draw land on it and silently forfeit the placement.
  const all = EntityService.findEntitiesWithComponent(SpawnPointComponent).filter(
    entity => entity.getComponent(TransformComponent) != null,
  );

  let candidates: Entity[] = [];
  if (tag != null && tag !== '') {
    candidates = all.filter(entity => {
      const spawnPoint = entity.getComponent(SpawnPointComponent);
      return spawnPoint != null && spawnPoint.tags.includes(tag);
    });
  }
  // No tag, or the tag matched nothing: fall back to the normal start set.
  if (candidates.length === 0) {
    candidates = all.filter(entity => {
      const spawnPoint = entity.getComponent(SpawnPointComponent);
      return (
        spawnPoint != null && spawnPoint.allowStart && spawnPoint.stateEnabled
      );
    });
  }
  if (candidates.length === 0) {
    return null;
  }

  // Uniformly random, so candidate order cannot affect the outcome. The engine
  // sorts by entity id before indexing because its generator can be seeded for
  // reproducible runs; Math.random() has no seed to reproduce, so ordering here
  // would be pure cost.
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const transform = chosen.getComponent(TransformComponent);
  if (transform == null) {
    // Unreachable: candidates were filtered on having a transform. Kept for the
    // type narrowing, and in case the component is removed mid-frame.
    return null;
  }
  return {
    position: transform.worldPosition,
    rotation: transform.worldRotation,
  };
}
