---
name: making-actors-patrol
description: Makes an NPC cycle a fixed sequence of waypoints with PatrolBehavior, optionally pausing at each one before moving on and looping. Use when the route is a known set of points, such as a guard walking a beat.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
consider_skills:
  - adding-navigation
---

# Making an NPC Patrol Waypoints

Sets up an actor to cycle through a sequence of waypoints using `PatrolBehavior`. The NPC walks to each waypoint in order, optionally pauses, then moves to the next and loops.

Two target modes are supported:

| Mode | When to use | How targets are set |
|------|-------------|---------------------|
| **Entity list** (default) | Waypoints exist at edit-time | Link entities directly via `patrolEntities` |
| **Tag-based** | Waypoints spawned at runtime (can't be linked in editor) | Tag entities as `{prefix}_0`, `{prefix}_1`, etc. |

## Trigger Conditions

Activate when the user asks to make an NPC patrol, pace, guard, or walk between points.

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a movement controller `ActorTransformMoveComponent`
- If animated: `CharacterAnimationController` on root with `animatorEntity` set
- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC patrols around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

---

## Step 1: Choose Mode and Set Up Waypoints

### Entity list mode

Best for edit-time placed waypoints the user selects in the scene. Create or identify waypoint entities and position them where the NPC should walk.

### Tag-based mode

Best for runtime-spawned waypoints or when multiple NPCs share routes. Each waypoint carries a tag following `{prefix}_{index}` pattern. The prefix should be **unique per patrol route** to avoid collisions.

**Examples of good tag prefixes:**

| Scenario | Prefix | Tags |
|----------|--------|------|
| Red NPC patrolling red markers | `red_patrol` | `red_patrol_0`, `red_patrol_1`, ... |
| Blue NPC patrolling blue markers | `blue_patrol` | `blue_patrol_0`, `blue_patrol_1`, ... |
| Guard patrolling perimeter | `perimeter` | `perimeter_0`, `perimeter_1`, ... |

Add `ActorSdkTagComponent` (provided by `meta/worlds`) to each waypoint entity and set `tags` to the appropriate `{prefix}_{index}` value. For runtime spawned waypoints, add `ActorSdkTagComponent` to the template or register tags programmatically via `ActorTaggingBlackboard.registerTags(entity, ['{prefix}_{index}'])`.

## Step 2: Create a Start Behavior Script

Create a script that wires up `PatrolBehavior` on the NPC. The script supports both modes — use `patrolEntities` for entity list or `patrolTagPrefix` for tag-based. If both are set, entity list takes precedence.

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {PatrolBehavior} from '../scripts/Actor/Behaviors/PatrolBehavior';

@component({description: 'Makes this NPC patrol through waypoints'})
export class StartPatrolComponent extends Component {
  // --- Entity list mode: link waypoints here (add more properties as needed) ---
  @property() patrolPoint0: Entity | null = null;
  @property() patrolPoint1: Entity | null = null;
  @property() patrolPoint2: Entity | null = null;
  @property() patrolPoint3: Entity | null = null;

  // --- Tag-based mode: set prefix instead (e.g. "red_patrol" → red_patrol_0, red_patrol_1, ...) ---
  @property() patrolTagPrefix: string = '';

  @property() patrolSpeed: number = 3.0;
  @property() arrivalDistance: number = 0.3;
  @property() waitTimeAtWaypoint: number = 0.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) return;

    const patrol = new PatrolBehavior();
    patrol.name = 'Patrol';
    patrol.basePriority = 20;
    patrol.patrolSpeed = this.patrolSpeed;
    patrol.arrivalDistance = this.arrivalDistance;
    patrol.waitTimeAtWaypoint = this.waitTimeAtWaypoint;
    patrol.loop = true;

    if (this.patrolTagPrefix.length > 0) {
      patrol.patrolTagPrefix = this.patrolTagPrefix;
    } else {
      const points: Entity[] = [];
      for (const p of [this.patrolPoint0, this.patrolPoint1, this.patrolPoint2, this.patrolPoint3]) {
        if (p) points.push(p);
      }
      if (points.length < 2) return;
      patrol.patrolEntities = points;
    }

    actorLogic.addBehavior(patrol);
  }
}
```

## Step 3: Attach and Configure

1. Add the script to the NPC entity
2. **Entity list mode**: link waypoint entities to `patrolPoint0`, `patrolPoint1`, etc.
3. **Tag-based mode**: set `patrolTagPrefix` to the unique prefix (e.g. `"red_patrol"`)
4. NPC visits waypoints in order: 0 → 1 → 2 → ... → back to 0

---

## Choosing Between Modes

**Default to entity list mode.** It's simpler and covers most cases. Only use tag-based mode when waypoints are created at runtime and cannot be linked in the editor.

| Scenario | Mode | Why |
|----------|------|-----|
| User selects existing scene entities as waypoints | Entity list | Direct linking, simplest setup |
| Multiple NPCs with different edit-time routes | Entity list | Just link different entities to each NPC's starter |
| Waypoints won't change at runtime | Entity list | No need for dynamic resolution |
| Waypoints are **spawned at runtime** from templates | **Tag-based** | Runtime entities can't be linked in the editor |
| Patrol route is **generated procedurally** at runtime | **Tag-based** | Waypoints don't exist until the game creates them |

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `patrolEntities` | `[]` | Direct entity references (entity list mode) |
| `patrolTagPrefix` | `''` | Tag prefix for tag-based mode (e.g. `"red_patrol"` → `red_patrol_0`, `red_patrol_1`) |
| `patrolSpeed` | `3.0` | Movement speed (m/s) |
| `arrivalDistance` | `0.3` | Distance that triggers arrival (meters) |
| `waitTimeAtWaypoint` | `0.0` | Pause at each waypoint (seconds, 0 = no pause) |
| `loop` | `true` | Loop back to first after last. If false, behavior finishes. |
| `basePriority` | `20` | Behavior priority (higher wins) |

## Validation

- [ ] NPC has `ActorSdkLogicComponent` on root
- [ ] NPC has movement controller and (if animated) `CharacterAnimationController`
- [ ] At least 2 waypoints provided
- [ ] Entity list: waypoint entities linked to correct properties
- [ ] Tag-based: each waypoint has `ActorSdkTagComponent` with `{prefix}_{index}` tag
- [ ] Tag-based: indices are sequential from 0 (no gaps)
- [ ] Tag-based: prefix is unique per patrol route (avoid tag collisions between NPCs)
- [ ] Start script uses `ExecuteOn.Owner`

## Common Mistakes

1. **Tag collisions** — Two NPCs using the same tag prefix (e.g. both use `"patrol"`) will resolve the same waypoints. Use unique prefixes like `"red_patrol"`, `"blue_patrol"`.
2. **Tag index gaps** — Tags must be sequential from 0. If `{prefix}_1` is missing, only `{prefix}_0` is used.
3. **Only 1 waypoint** — Need at least 2 for a patrol route.
4. **Tag case mismatch** — Tags are case-sensitive. `"Patrol_0"` ≠ `"patrol_0"`.
5. **NPC slides without animating** — Missing `CharacterAnimationController`.
