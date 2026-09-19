---
name: making-actors-fetch
description: Makes an NPC fetch a specific item, pick it up, carry it to a drop-off point, and drop it, using SimpleFetchBehavior plus the pickup component for hand-slot mechanics.
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

# Making an NPC Fetch and Deliver an Item

Sets up an actor to fetch a specific item entity, pick it up, carry it to a drop-off point, and drop it using `SimpleFetchBehavior`. The NPC needs `ActorPickupItemComponent` for hand-slot pickup/drop mechanics.

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC fetch the ball"
- "Have the NPC pick up the sword and bring it here"
- "Make the NPC carry items from A to B"
- "NPC should retrieve the key and deliver it"
- Any variation involving fetching, carrying, or transporting a specific item

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a movement controller
- NPC entity **MUST** have `ActorPickupItemComponent` for pickup/drop
- The item entity should have a child entity named `GripPoint` for proper hand positioning
- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC walks to and from the item around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Step 1: Set Up ActorPickupItemComponent on the NPC

Add `ActorPickupItemComponent` to the NPC entity. It auto-resolves hand slots by searching for child entities named `RightHandSocket`/`RightHandSlot` or `LeftHandSocket`/`LeftHandSlot`.

## Step 2: Create a Start Behavior Script

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SimpleFetchBehavior} from '../scripts/Actor/Behaviors/SimpleFetchBehavior';
import {PickupItemSlot} from 'meta/worlds';

@component({description: 'Makes this NPC fetch an item and deliver it to a drop-off'})
export class StartFetchComponent extends Component {
  @property() itemToPickUp: Entity | null = null;
  @property() dropOffPoint: Entity | null = null;
  @property() moveSpeed: number = 5.0;
  @property() pickupRange: number = 1.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartFetchComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    if (!this.itemToPickUp || !this.dropOffPoint) {
      console.warn('[StartFetchComponent] Missing itemToPickUp or dropOffPoint');
      return;
    }

    const fetch = new SimpleFetchBehavior();
    fetch.name = 'FetchItem';
    fetch.itemToPickUp = this.itemToPickUp;
    fetch.itemDropOffPoint = this.dropOffPoint;
    fetch.moveSpeed = this.moveSpeed;
    fetch.itemPickupRange = this.pickupRange;
    fetch.pickupSlot = PickupItemSlot.RightHand;
    fetch.basePriority = 30;

    actorLogic.addBehavior(fetch);
  }
}
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `itemToPickUp` | `null` | The item entity to fetch |
| `itemDropOffPoint` | `null` | The entity where the item should be dropped |
| `moveSpeed` | `5.0` | Movement speed (m/s) |
| `itemPickupRange` | `1.0` | Distance to trigger pickup/drop (meters) |
| `pickupSlot` | `RightHand` | Which hand to use (`PickupItemSlot.RightHand` or `LeftHand`) |
| `startDelay` | `0` | Seconds to wait before starting (prevents instant completion during scene load) |
| `basePriority` | `30` | Behavior priority |

## How SimpleFetchBehavior Works

1. **Moving to item** — NPC walks to `itemToPickUp` position
2. **Pickup** — When within `itemPickupRange`, picks up item via `ActorPickupItemController`
3. **Moving to drop-off** — NPC walks to `itemDropOffPoint` position
4. **Drop** — When within range of drop-off, drops the item
5. **Finished** — Behavior sets `isFinished = true`

## GripPoint Setup

For proper hand positioning, add a child entity named `GripPoint` to the item:
- The `GripPoint`'s local position/rotation defines the offset from the hand slot
- Without a `GripPoint`, the item is held at its origin (which may look wrong)

## Validation

- [ ] NPC has `ActorSdkLogicComponent` on root
- [ ] NPC has `ActorPickupItemComponent`
- [ ] NPC has movement controller
- [ ] Item entity and drop-off entity are set
- [ ] Start script uses `ExecuteOn.Owner`
