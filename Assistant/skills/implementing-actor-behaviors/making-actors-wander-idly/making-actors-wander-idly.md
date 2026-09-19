---
name: making-actors-wander-idly
description: Makes an NPC wander randomly around a region with IdleWanderBehavior — idle, pick a nearby point, walk to it, idle again — with a leash that stops it drifting away from its start position. Use for ambient or idle NPC movement with no fixed route.
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

# Making an NPC Idle Wander

Sets up an actor to wander randomly around a region using `IdleWanderBehavior`. The NPC idles for a random duration, picks a random nearby position, walks to it, then idles again. A leash system prevents the NPC from drifting too far from its starting position.

## Trigger Conditions

Activate when the user asks to make an NPC wander, roam, idle walk, meander, patrol randomly, pace around aimlessly, or mill about.

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a movement controller `ActorTransformMoveComponent`
- If animated: `CharacterAnimationController` on root with `animatorEntity` set
- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC wanders around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

---

## Step 1: Create a Start Behavior Script

Create a script component that wires up `IdleWanderBehavior` on the NPC.

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {IdleWanderBehavior} from '../scripts/Actor/Behaviors/IdleWanderBehavior';

@component({description: 'Makes this NPC wander randomly around the area'})
export class StartIdleWanderComponent extends Component {
  // --- Timing: how long to idle before picking a new spot ---
  // Actual wait is randomized between min and max each time
  @property() wanderIntervalMin: number = 5.0;
  @property() wanderIntervalMax: number = 10.0;

  // --- Radius: how far from current position to pick a new spot ---
  // A random distance in [min, max] is chosen each time
  @property() wanderRadiusMin: number = 5.0;
  @property() wanderRadiusMax: number = 7.0;

  // --- Leash: max distance from starting position the NPC can wander ---
  // Set to 0 to disable (unlimited range). If a random target would
  // exceed this, it is clamped back to the leash boundary.
  @property() leashRadius: number = 20.0;

  // --- Movement ---
  @property() wanderSpeed: number = 2.0;
  @property() arrivalDistance: number = 1.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartIdleWanderComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const wander = new IdleWanderBehavior();
    wander.name = 'IdleWander';
    wander.basePriority = 10;

    // Timing
    wander.wanderIntervalMin = this.wanderIntervalMin;
    wander.wanderIntervalMax = this.wanderIntervalMax;

    // Distance
    wander.wanderRadiusMin = this.wanderRadiusMin;
    wander.wanderRadiusMax = this.wanderRadiusMax;

    // Leash
    wander.leashRadius = this.leashRadius;

    // Movement
    wander.wanderSpeed = this.wanderSpeed;
    wander.arrivalDistance = this.arrivalDistance;
    wander.rotateTowardsMovement = true;
    wander.bodyDirectionAngularSpeed = 3.14;

    actorLogic.addBehavior(wander);
  }
}
```

## Step 2: Attach and Configure

1. Add the script to the NPC entity
2. Configure properties in the editor:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `wanderIntervalMin` | `5.0` | Minimum idle time (seconds) before picking a new wander target |
| `wanderIntervalMax` | `10.0` | Maximum idle time (seconds) before picking a new wander target |
| `wanderRadiusMin` | `5.0` | Minimum distance (meters) from current position for the next target |
| `wanderRadiusMax` | `7.0` | Maximum distance (meters) from current position for the next target |
| `leashRadius` | `20.0` | Maximum distance (meters) from starting position the NPC can ever reach. Set to 0 to disable. |
| `wanderSpeed` | `2.0` | Walking speed (m/s) |
| `arrivalDistance` | `1.0` | Distance (meters) at which the NPC considers itself arrived at the target |
| `basePriority` | `10` | Behavior priority (higher wins). Use low priority so other behaviors can override. |

## Example Configuration

"Every 5–10 seconds, go to a random spot 5–7 m away, never more than 20 m from start":

```typescript
wander.wanderIntervalMin = 5.0;   // wait at least 5s
wander.wanderIntervalMax = 10.0;  // wait at most 10s
wander.wanderRadiusMin = 5.0;     // walk at least 5m
wander.wanderRadiusMax = 7.0;     // walk at most 7m
wander.leashRadius = 20.0;        // never exceed 20m from start
```

## How the Leash Works

The leash constrains the NPC to a circle centered on the position where the behavior first initialized (the "anchor"). When the NPC picks a new random target:

1. A random direction and distance are chosen relative to the NPC's **current** position
2. If the resulting point is **inside** the leash radius from the anchor → accepted as-is
3. If the resulting point is **outside** the leash radius → it is projected back onto the leash circle boundary

This means NPCs near the edge of the leash zone will naturally tend to wander back toward the center, since outward picks get clamped while inward picks pass through. The NPC will never teleport — it always walks smoothly to the clamped position.

Set `leashRadius = 0` to disable leashing entirely.

## Combining with Other Behaviors

IdleWander works well as a low-priority "default" behavior that runs when no other behavior is active:

| Behavior | Priority | Effect |
|----------|----------|--------|
| IdleWander | 10 | Wanders when nothing else is happening |
| Follow | 30 | Follows player when in range (overrides wander) |
| Attack | 50 | Attacks when in combat (overrides everything) |

When a higher-priority behavior activates, it claims the movement controller and IdleWander's movement is suppressed. When the higher-priority behavior finishes or goes inactive, IdleWander resumes.

## Validation

- [ ] NPC has `ActorSdkLogicComponent` on root
- [ ] NPC has movement controller `ActorTransformMoveComponent`
- [ ] If animated: `CharacterAnimationController` on root with `animatorEntity` set
- [ ] Start script uses `ExecuteOn.Owner`
- [ ] `wanderRadiusMin` ≤ `wanderRadiusMax`
- [ ] `wanderIntervalMin` ≤ `wanderIntervalMax`
- [ ] `leashRadius` is ≥ `wanderRadiusMax` (otherwise most picks get clamped)
- [ ] `basePriority` is lower than combat/follow behaviors so they can override

## Common Mistakes

1. **Leash too small** — If `leashRadius` < `wanderRadiusMax`, most random picks overshoot the leash and get clamped to the boundary. The NPC ends up walking to the same edge repeatedly. Set `leashRadius` to at least 2× `wanderRadiusMax` for natural-looking movement.
2. **Priority too high** — IdleWander should be a background behavior (priority 10–15). If it's higher than follow/attack behaviors, it will claim the movement controller and block them.
3. **NPC slides without animating** — Missing `CharacterAnimationController`. Add it to the root entity and set `animatorEntity` to the child with `AnimatorComponent`.
4. **NPC doesn't move** — Check that `wanderIntervalMin` isn't extremely high. Also verify the NPC has ground underneath it for the movement controller to work.
5. **NPC clusters at leash edge** — `leashRadius` is too close to `wanderRadiusMax`. Increase `leashRadius` or decrease `wanderRadiusMax`.
