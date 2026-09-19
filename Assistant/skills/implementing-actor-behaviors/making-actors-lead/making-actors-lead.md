---
name: making-actors-lead
description: Makes an NPC guide the player to a destination with LeadBehavior, walking ahead while watching the player's distance and waiting for them to catch up when they fall behind.
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

# Making an NPC Lead the Player to a Destination

Sets up an actor to lead the player to a destination using `LeadBehavior`. The NPC walks toward a target point while monitoring the player's distance — if the player falls too far behind, the NPC stops, turns to face the player, and waits until they catch up.

Two destination modes are supported:

| Mode | When to use | How destination is set |
|------|-------------|----------------------|
| **Entity/Position** (default) | Destination exists at edit-time | Link entity or set Vec3 directly |
| **Tag-based** | Destination is spawned at runtime or identified by tag | Set `destinationTag` to find closest tagged entity |

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC lead me to the castle"
- "Have the NPC guide the player to a location"
- "Make this goblin lead me to the sword of destiny"
- "Walk the player to a destination"
- Any variation involving an NPC leading, guiding, or escorting

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a movement controller `ActorTransformMoveComponent`
- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC leads around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Option A: Lead to Entity (Direct Linking)

Use when the destination entity exists in the scene at edit-time.

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
  TransformComponent,
} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {LeadBehavior} from '../scripts/Actor/Behaviors/LeadBehavior';

@component({description: 'Makes this NPC lead the player to a destination'})
export class StartLeadComponent extends Component {
  @property() destination: Entity | null = null;
  @property() leadSpeed: number = 2.0;
  @property() maxPlayerDistance: number = 8.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartLeadComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    if (!this.destination) {
      console.warn('[StartLeadComponent] No destination entity set');
      return;
    }

    const destTransform = this.destination.getComponent(TransformComponent);
    if (!destTransform) return;

    const lead = new LeadBehavior();
    lead.name = 'LeadToDestination';
    lead.destination = destTransform.worldPosition;
    lead.leadSpeed = this.leadSpeed;
    lead.maxPlayerDistance = this.maxPlayerDistance;
    lead.resumePlayerDistance = this.maxPlayerDistance * 0.5;
    lead.followClosestPlayer = true;
    lead.arrivalThreshold = 2.0;
    lead.basePriority = 30;

    actorLogic.addBehavior(lead);
  }
}
```

## Option B: Lead to Tagged Entity

Use when the destination is identified by a tag (e.g., "lead me to the sword of destiny"). The behavior finds the closest entity with the tag at initialization time.

Tag the destination entity: add the `ActorSdkTagComponent` component (provided by `meta/worlds`) → tags: ["sword_of_destiny"]

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {LeadBehavior} from '../scripts/Actor/Behaviors/LeadBehavior';

@component({description: 'Makes this NPC lead the player to a tagged destination'})
export class StartLeadToTagComponent extends Component {
  @property() destinationTag: string = 'sword_of_destiny';
  @property() leadSpeed: number = 2.0;
  @property() maxPlayerDistance: number = 8.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) return;

    const lead = new LeadBehavior();
    lead.name = 'LeadToTag';
    lead.destinationTag = this.destinationTag;
    lead.leadSpeed = this.leadSpeed;
    lead.maxPlayerDistance = this.maxPlayerDistance;
    lead.resumePlayerDistance = this.maxPlayerDistance * 0.5;
    lead.followClosestPlayer = true;
    lead.arrivalThreshold = 2.0;
    lead.basePriority = 30;

    actorLogic.addBehavior(lead);
  }
}
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `destination` | `Vec3(0,0,0)` | World position to lead the player to |
| `destinationTag` | `''` | Tag of destination entity. If set, overrides `destination` with closest tagged entity's position |
| `leadSpeed` | `2.0` | Movement speed (m/s) |
| `arrivalThreshold` | `1.0` | Distance from destination to consider "arrived" |
| `maxPlayerDistance` | `8.0` | Distance at which the NPC stops to wait |
| `resumePlayerDistance` | `4.0` | Distance at which the NPC resumes leading |
| `followClosestPlayer` | `true` | Auto-target the closest player |
| `basePriority` | `30` | Behavior priority |

## How the Lead State Machine Works

1. **Leading** — NPC walks toward destination, monitoring player distance
2. **WaitingForPlayer** — Player fell behind (`> maxPlayerDistance`), NPC stops and faces player
3. **Arrived** — NPC reached destination, behavior finishes (`isFinished = true`)

When the behavior finishes, it can be chained with other behaviors using `SequentialBehavior` (see `sequencing-actor-behaviors` skill).

## Validation

- [ ] NPC has `ActorSdkLogicComponent` on root
- [ ] NPC has movement controller
- [ ] Either `destination` entity is set, OR `destinationTag` is set with matching tagged entities in scene
- [ ] If tag-based: destination entity has `ActorSdkTagComponent` with matching tag (case-sensitive) — the producer half (same rule as "The Tag Targeting Contract" in the parent skill). `LeadBehavior` reads it via `destinationTag` (a single tag), not `targetTags`.
- [ ] Start script uses `ExecuteOn.Owner`
- [ ] `maxPlayerDistance` > `resumePlayerDistance` (otherwise NPC jitters)
