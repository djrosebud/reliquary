/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Navigation Scripts v1

import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
  EntityService,
  NavMeshComponent,
  type Region2D,
} from 'meta/worlds';

// Covers the whole world. The native PathfindingRecastSystem clamps this to each
// NavMesh's actual tile half-extents, so the literal extent is not a cost knob —
// shrinking it does NOT shrink the bake.
const FULL_WORLD_REBUILD_REGION: Region2D = {
  minX: -10000,
  minZ: -10000,
  maxX: 10000,
  maxZ: 10000,
};

/**
 * Rebakes every NavMesh in the world once at load time.
 *
 * Place this component on a SINGLE dedicated scene entity (e.g. "NavMeshServices").
 * It is independent of the Actor Framework, so any world with a NavMesh can use it.
 *
 * Why this exists: HAS skills can mutate world geometry (add objects, move walls,
 * change colliders) with no way to signal the NavMesh to rebake. As a stopgap we
 * rebake on load. Remove once native invalidation lands in PathfindingRecastSystem
 * (tracking task: T274540933).
 *
 * The rebake is asynchronous and intentionally not awaited by onStart: actors that
 * begin pathfinding before it completes fall back to straight-line movement (see
 * GotoBehavior). Runs on every peer (ExecuteOn.Everywhere) so editor preview — where
 * the local peer is the owner, not the server — also rebakes.
 */
@component({
  description:
    'Rebakes all NavMeshes once on world load. Place on a single dedicated scene entity.',
})
export class NavMeshRebuildOnLoad extends Component {
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    void this.rebuildAllNavMeshes();
  }

  private async rebuildAllNavMeshes(): Promise<void> {
    const navMeshEntities =
      EntityService.findEntitiesWithComponent(NavMeshComponent);

    // Sequential, not parallel: rebuildRegion is an expensive multi-frame Recast
    // bake. Awaiting each in turn avoids a rebuild storm during the load phase,
    // when frame budget and worker threads are already saturated.
    for (const entity of navMeshEntities) {
      const navMesh = entity.getComponent(NavMeshComponent);
      if (navMesh == null) {
        continue;
      }
      // Capture the name before the await: the entity can be destroyed mid-rebake
      // (world unload, undo, respawn), after which reading entity.name is unsafe.
      const entityName = entity.name;
      try {
        const success = await navMesh.rebuildRegion(FULL_WORLD_REBUILD_REGION);
        if (success) {
          console.log(
            `[NavMeshRebuildOnLoad] Rebuilt navmesh for entity ${entityName}`,
          );
        } else {
          console.warn(
            `[NavMeshRebuildOnLoad] Failed to rebuild navmesh for entity ${entityName}`,
          );
        }
      } catch (error: unknown) {
        // The likeliest rejection is the entity being destroyed during the bake
        // (NavMeshManager::removeNavMesh rejects the AsyncResult on destroy). That
        // is benign teardown, not a real failure — log at info level, not error.
        console.log(
          `[NavMeshRebuildOnLoad] Rebuild interrupted for entity ${entityName} (likely destroyed during rebake):`,
          error,
        );
      }
    }
  }
}
