---
name: sequencing-actor-behaviors
description: Chains, sequences, alternates, or cycles multiple behaviors with SequentialBehavior, running each step exclusively until it finishes and then starting the next. Use for strictly ordered multi-step tasks and timed phase loops.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
---

# Chaining NPC Behaviors in Sequence

Uses `SequentialBehavior` to run behaviors one after another. Each step runs exclusively until it sets `isFinished = true`, then the next step initializes and starts.

**Use SequentialBehavior when** steps are strictly ordered with no persistent default to return to (go to A, pick up B, deliver to C).

**Do NOT use SequentialBehavior when** the user describes a conditional/reactive pattern like "follow the player, but if X is nearby, do Y". That pattern uses **priority-based activation** — see `working-with-actor-behaviors` skill.

| User says | Correct pattern |
|-----------|----------------|
| "Go to A, pick up B, deliver to C" | SequentialBehavior |
| "Follow me, but pick up nearby items" | Priority-based (follow at 10, pickup at 20 with detectionRange) |
| "Patrol between waypoints, then fetch an item" | SequentialBehavior with loop |
| "Follow me, and when near the pyramid, grab it, then keep following" | Priority-based (NOT sequential) |

## Trigger Conditions

Activate when the user asks to:
- "Make the NPC go to the ball, pick it up, then bring it to me"
- "NPC should patrol to the station, grab the item, bring it back"
- "Chain these behaviors: first go here, then do that"
- Strictly ordered multi-step tasks with no persistent default behavior

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- Each step behavior must have its own prerequisites (movement controller, pickup controller, etc.)
- Actor Framework deployed — checked in at `scripts/Actor/`

## Step 1: Create a Start Behavior Script

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SequentialBehavior} from '../scripts/Actor/Behaviors/SequentialBehavior';
import {SearchAndPickupBehavior} from '../scripts/Actor/Tagging/SearchAndPickupBehavior';
import {FollowTaggedEntityBehavior} from '../scripts/Actor/Tagging/FollowTaggedEntityBehavior';
import {PickupItemSlot} from 'meta/worlds';

@component({description: 'NPC goes to blue sphere, picks it up, then follows the player'})
export class StartSequentialComponent extends Component {
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) return;

    // Step 1: Find the blue sphere, walk to it, pick it up
    const pickup = new SearchAndPickupBehavior();
    pickup.targetTags = ['blue_sphere'];
    pickup.pickupRange = 2.0;
    pickup.followSpeed = 4.0;
    pickup.pickupSlot = PickupItemSlot.RightHand;

    // Step 2: Follow the player
    const follow = new FollowTaggedEntityBehavior();
    follow.targetTags = ['player'];
    follow.followRange = 3.0;
    follow.followSpeed = 5.0;

    // Chain them
    const sequence = new SequentialBehavior();
    sequence.basePriority = 30;
    sequence.addStep(pickup);
    sequence.addStep(follow);

    actorLogic.addBehavior(sequence);
  }
}
```

## Example: Looping Patrol with Fetch

```typescript
const sequence = new SequentialBehavior();
sequence.basePriority = 30;
sequence.loop = true; // Repeat forever

// Step 1: Go to the station
const goToStation = new GotoBehavior();
goToStation.targetPosition = stationPosition;
goToStation.desiredSpeed = 3.0;

// Step 2: Pick up a meal
const pickup = new SearchAndPickupBehavior();
pickup.targetTags = ['meal'];
pickup.pickupRange = 1.5;

// Step 3: Deliver to the counter
const deliver = new DeliverToTagBehavior();
deliver.targetTags = ['counter'];
deliver.dropRange = 2.0;

sequence.addStep(goToStation);
sequence.addStep(pickup);
sequence.addStep(deliver);
actorLogic.addBehavior(sequence);
```

> **`GotoBehavior` steps are destinations to visit, not detour waypoints.** Each
> `targetPosition` above is a place the NPC should actually go (a station, a
> counter). Do NOT add `GotoBehavior` steps at hand-picked "gap" points to route an
> NPC around a wall/obstacle — that bypasses the NavMesh and hardcodes a fragile
> route. For obstacle avoidance, use ONE `GotoBehavior` with the final destination
> and let a baked NavMesh compute the detour (see `adding-navigation` and
> `making-actors-go-to-point`).

## How Steps Work

1. Only the current step receives `update()` calls and claims controllers
2. When a step sets `isFinished = true`, it is cleaned up and the next step initializes
3. Controller priority is delegated to the current step
4. With `loop = true`, all steps reset and replay from step 1 after the last step finishes

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `loop` | `false` | If true, restarts from step 1 after all steps complete |
| `basePriority` | `0` | Priority used externally; each step claims controllers at its own priority internally |

## Compatible Step Behaviors

Any behavior that sets `isFinished = true` when done works as a step:

| Behavior | Finishes when | Skill |
|----------|---------------|-------|
| `SearchAndPickupBehavior` | Item picked up (one-shot mode) | `actor-search-and-pickup` |
| `DeliverToTagBehavior` | Item dropped at target | `actor-deliver-to-tag` |
| `GotoBehavior` | Arrived at destination | (built-in) |
| `LeadBehavior` | Arrived at destination | `actor-lead` |
| `FollowTaggedEntityBehavior` | Never (stays active) — use as last step | `making-actors-follow` |

**Note:** `FollowTaggedEntityBehavior` never finishes on its own, so place it as the **last** step in a non-looping sequence.

## Validation

- [ ] NPC has `ActorSdkLogicComponent` on root
- [ ] Each step's prerequisites are met (movement controller, pickup controller, etc.)
- [ ] Non-finishing behaviors (follow) are only used as the last step in non-looping sequences
- [ ] Start script uses `ExecuteOn.Owner`
