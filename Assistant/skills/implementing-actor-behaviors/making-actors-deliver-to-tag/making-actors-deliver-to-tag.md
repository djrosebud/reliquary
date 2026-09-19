---
name: making-actors-deliver-to-tag
description: Makes an NPC carry a held item to the closest entity with a given tag and drop it, using DeliverToTagBehavior. Pairs with search-and-pickup in a sequence for catch-and-deliver flows.
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
  - name: sequencing-actor-behaviors
    when: the delivery is one step of an ordered chain rather than the whole task
---

# Making an NPC Deliver an Item to a Tagged Location

Sets up an actor to walk to the closest entity with a given tag and drop the currently held item using `DeliverToTagBehavior`. Designed to pair with `SearchAndPickupBehavior` in a `SequentialBehavior` chain for catch-and-deliver flows.

## Trigger Conditions

Activate when the user asks to:
- "Make the NPC bring the ball to the drop-off zone"
- "Have the NPC deliver the item to the counter"
- "NPC should carry this to the base"
- "Drop the held item at the tagged location"
- Any variation involving delivering, dropping off, or bringing items to a location

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a movement controller
- NPC entity **MUST** have `ActorPickupItemComponent` (to drop items)
- NPC **MUST** already be holding an item (use `SearchAndPickupBehavior` or `SimpleFetchBehavior` first)
- Drop-off entity **MUST** have `ActorSdkTagComponent` with the matching tag (producer half — see "The Tag Targeting Contract" in the parent skill).
- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC walks to the drop-off around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Step 1: Tag the Drop-Off Location

Add `ActorSdkTagComponent` (provided by `meta/worlds`) to the drop-off entity and set the tag:

```
ActorSdkTagComponent → tags: ["drop_off"]
```

## Step 2: Create a Catch-and-Deliver Chain

DeliverToTagBehavior is almost always used as step 2 in a `SequentialBehavior` chain:

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SequentialBehavior} from '../scripts/Actor/Behaviors/SequentialBehavior';
import {SearchAndPickupBehavior} from '../scripts/Actor/Tagging/SearchAndPickupBehavior';
import {DeliverToTagBehavior} from '../scripts/Actor/Tagging/DeliverToTagBehavior';
import {PickupItemSlot} from 'meta/worlds';

@component({description: 'NPC catches a ball and delivers it to the drop-off'})
export class StartCatchAndDeliverComponent extends Component {
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) return;

    // Step 1: Find and pick up the ball
    const pickup = new SearchAndPickupBehavior();
    pickup.targetTags = ['blue_ball'];
    pickup.pickupRange = 2.0;
    pickup.followSpeed = 4.0;
    pickup.pickupSlot = PickupItemSlot.RightHand;

    // Step 2: Deliver to drop-off zone
    const deliver = new DeliverToTagBehavior();
    deliver.targetTags = ['drop_off'];
    deliver.dropRange = 2.0;
    deliver.dropSlot = PickupItemSlot.RightHand;
    deliver.followSpeed = 4.0;

    // Chain: pickup → deliver
    const sequence = new SequentialBehavior();
    sequence.basePriority = 30;
    sequence.loop = true; // Repeat: catch another ball after delivering
    sequence.addStep(pickup);
    sequence.addStep(deliver);

    actorLogic.addBehavior(sequence);
  }
}
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `targetTags` | `[]` | Tags of the drop-off entity (e.g., `["drop_off"]`, `["counter"]`, `["base"]`) |
| `dropRange` | `2.0` | Distance to trigger drop (meters, XZ only) |
| `dropSlot` | `RightHand` | Which hand slot to drop from |
| `followSpeed` | `5.0` | Movement speed toward drop-off (m/s) |
| `bodyDirectionMode` | `'faceTarget'` | Which direction the actor faces: `'faceTarget'`, `'faceMovement'` (travel direction), `'matchTarget'`, or `'none'` (do not rotate) |
| `basePriority` | `30` | Behavior priority |

## Full Catch-and-Deliver Flow

```
Step 1: SearchAndPickup(targetTags=['blue_ball'])
  → Find closest blue_ball, walk to it, pick up

Step 2: DeliverToTag(targetTags=['drop_off'])
  → Find closest drop_off, walk to it, drop item

(with loop=true, repeats from Step 1)
```

## Validation

- [ ] NPC has `ActorSdkLogicComponent`, movement controller, and `ActorPickupItemComponent`
- [ ] Drop-off entity has `ActorSdkTagComponent` with matching tag
- [ ] NPC is holding an item before DeliverToTagBehavior runs (chain after a pickup behavior)
- [ ] `dropSlot` matches the slot used during pickup
- [ ] Start script uses `ExecuteOn.Owner`
