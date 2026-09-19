---
name: making-actors-flee
description: Makes an NPC run away from a target with FleeBehavior, keeping a minimum safe distance and optionally leashed to its start position. The inverse of following — flee keeps the actor far from the target.
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

# Making an NPC Flee from a Target

Sets up an actor to flee from a target entity using `FleeBehavior`. The NPC maintains a minimum safe distance from the target — when the target gets too close, the NPC runs directly away. A leash system optionally prevents the NPC from fleeing too far from its starting position.

This is the inverse of `FollowBehavior`: follow keeps the actor CLOSE to a target, flee keeps the actor FAR from a target.

Two target modes are supported:

| Mode | When to use | How target is set |
|------|-------------|-------------------|
| **Tag-based** (default) | Target identified by tag (e.g. flee from `"player"`) | `FleeTaggedEntityBehavior` resolves closest tagged entity |
| **Direct entity** | Target entity is known at setup time | `FleeBehavior` with `targetEntity` set directly |

## Trigger Conditions

Activate when the user asks to make an NPC flee, run away, retreat, escape, keep distance, avoid, or be scared of something.

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a movement controller `ActorTransformMoveComponent`
- If animated: `CharacterAnimationController` on root with `animatorEntity` set
- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC flees around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

---

## Tag-Based Mode (Default)

Use `FleeTaggedEntityBehavior` when the target is identified by a tag. This is the recommended approach — it mirrors `FollowTaggedEntityBehavior` and handles dynamic target resolution automatically.

### Step 1: Ensure the Target Has a Tag

**If fleeing from the player:**
- Tag: `"player"` — auto-applied by `ActorSdkTagPlayerService`, no manual setup needed

**If fleeing from another entity:**
- Add `ActorSdkTagComponent` to the target entity
- Set the `tags` property (e.g. `"threat"`, `"enemy"`, `"fire"`)

### Step 2: Create a Start Behavior Script

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {FleeTaggedEntityBehavior} from '../scripts/Actor/Tagging/FleeTaggedEntityBehavior';

@component({description: 'Makes this NPC flee from the closest entity with a matching tag'})
export class StartFleeComponent extends Component {
  // --- Tags of the entity to flee from (comma-separated, e.g. "player", "player, enemy") ---
  @property() targetTags: string = 'player';

  // --- How far to flee: NPC runs until at least this many meters from target ---
  @property() fleeDistance: number = 10.0;

  // --- Flee speed (m/s) - typically faster than normal walk ---
  @property() fleeSpeed: number = 6.0;

  // --- Leash: max distance from starting position the NPC can flee to ---
  // Set to 0 to disable (NPC can flee infinitely far).
  // When the leash prevents full retreat, the NPC flees as far as
  // the leash allows and stays at the boundary.
  @property() leashRadius: number = 0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartFleeComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const flee = new FleeTaggedEntityBehavior();
    flee.name = 'FleeFromPlayer';
    flee.basePriority = 40;

    // Targeting
    flee.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);

    // Distance
    flee.fleeDistance = this.fleeDistance;
    flee.fleeSpeed = this.fleeSpeed;
    flee.arrivalDistance = 1.0;

    // Leash
    flee.leashRadius = this.leashRadius;

    // Body direction
    flee.rotateTowardsMovement = true;
    flee.bodyDirectionAngularSpeed = 3.14;

    actorLogic.addBehavior(flee);
  }
}
```

### Step 3: Attach and Configure

1. Add the script to the NPC entity
2. Set `targetTags` to the tags of the entity to flee from (array, e.g. `["player"]`)
3. Tune `fleeDistance`, `fleeSpeed`, and `leashRadius` in the editor

---

## Direct Entity Mode

Use `FleeBehavior` directly when the target entity is known at setup time (e.g. linked via an editor property).

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {FleeBehavior} from '../scripts/Actor/Behaviors/FleeBehavior';

@component({description: 'Makes this NPC flee from a specific entity'})
export class StartFleeFromEntityComponent extends Component {
  // --- The entity to flee from (link in editor) ---
  @property() fleeTarget: Entity | null = null;

  @property() fleeDistance: number = 10.0;
  @property() fleeSpeed: number = 6.0;
  @property() leashRadius: number = 0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic || !this.fleeTarget) return;

    const flee = new FleeBehavior();
    flee.name = 'FleeFromEntity';
    flee.basePriority = 40;
    flee.targetEntity = this.fleeTarget;
    flee.fleeDistance = this.fleeDistance;
    flee.fleeSpeed = this.fleeSpeed;
    flee.leashRadius = this.leashRadius;
    flee.rotateTowardsMovement = true;
    flee.bodyDirectionAngularSpeed = 3.14;

    actorLogic.addBehavior(flee);
  }
}
```

---

## Choosing Between Modes

**Default to tag-based mode.** It handles dynamic target resolution (targets spawning/despawning), closest-target selection, and works with the tagging system used by all other actor skills.

| Scenario | Mode | Why |
|----------|------|-----|
| Flee from the player | Tag-based | Players are auto-tagged `"player"` |
| Flee from closest enemy | Tag-based | Resolves nearest `"enemy"` dynamically |
| Flee from a specific scene object | Direct entity | Known at edit time, link in editor |
| Target may not exist yet at NPC spawn | Tag-based | Waits until tagged entity appears |

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `targetTags` | `[]` | Tags to flee from (tag-based mode only), e.g. `["player"]`, `["enemy"]` |
| `targetEntity` | `null` | Direct entity to flee from (direct mode only) |
| `fleeDistance` | `10.0` | Minimum safe distance (meters) from target. NPC flees when closer. |
| `fleeSpeed` | `6.0` | Movement speed while fleeing (m/s). Typically faster than walk speed. |
| `leashRadius` | `0` | Max distance (meters) from starting position. 0 = unlimited. |
| `arrivalDistance` | `1.0` | Distance (meters) at which the NPC considers itself at the flee point. |
| `rotateTowardsMovement` | `true` | Face direction of movement while fleeing. |
| `bodyDirectionAngularSpeed` | `3.14` | Rotation speed (radians/sec). |
| `basePriority` | `40` | Behavior priority (higher wins). Should be higher than idle/wander. |

## How It Works

1. Each frame, the behavior checks horizontal (XZ) distance from the actor to the target
2. If distance >= `fleeDistance` → safe, the behavior releases controllers and does nothing
3. If distance < `fleeDistance` → computes a flee point:
   - Direction = directly away from target (actor position - target position, normalized)
   - Flee point = `fleeDistance` meters from target in the away direction
   - If leash is active and the flee point exceeds `leashRadius` from anchor → clamped to leash boundary
4. GotoBehavior drives the actor toward the flee point
5. When the target moves closer again, a new flee point is recalculated

## How the Leash Interacts with Fleeing

| Scenario | What happens |
|----------|-------------|
| Flee point is inside leash | Actor flees to it normally |
| Flee point is outside leash | Clamped to leash boundary — actor goes as far as possible |
| Target enters leash zone | Actor flees away, staying within leash |
| Target pushes actor to leash edge | Actor stays at boundary — won't leave leash zone |

## Combining with Other Behaviors

| Behavior | Priority | Effect |
|----------|----------|--------|
| IdleWander | 10 | Wanders when nothing else is happening |
| Follow | 30 | Follows a companion |
| Flee | 40 | Flees from threat (overrides follow and wander) |
| Attack | 50 | Attacks when in combat (overrides everything) |

## Validation

- [ ] NPC has `ActorSdkLogicComponent` on root
- [ ] NPC has movement controller `ActorTransformMoveComponent`
- [ ] If animated: `CharacterAnimationController` on root with `animatorEntity` set
- [ ] Start script uses `ExecuteOn.Owner`
- [ ] Target is specified: `targetTags` set (tag mode) or `targetEntity` linked (direct mode)
- [ ] Tag-based: target entity has `ActorSdkTagComponent` with matching tag (players are auto-tagged) (see "The Tag Targeting Contract" in the parent skill).
- [ ] `fleeDistance` > 0
- [ ] If using leash: `leashRadius` > 0 and ideally >= `fleeDistance`
- [ ] `basePriority` is higher than idle/wander behaviors

## Common Mistakes

1. **Tag mismatch** — the behavior's `targetTags` is `["Player"]` but the auto-tagged value is `"player"` (lowercase), so it must be `["player"]`. Tags are case-sensitive.
2. **NPC doesn't flee** — `fleeDistance` is too low, or the target never gets close enough. Increase `fleeDistance`.
3. **NPC flees but gets stuck at leash edge** — `leashRadius` < `fleeDistance` and the target is inside the leash zone. Increase `leashRadius`.
4. **NPC slides without animating** — Missing `CharacterAnimationController`.
5. **Priority conflict with follow** — If flee priority ≤ follow priority, the NPC chases instead of fleeing. Ensure flee priority > follow priority.
6. **Direct mode: target is null** — `fleeTarget` property not linked in the editor. The behavior does nothing without a target.
