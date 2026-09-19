---
name: making-actors-search-and-pickup
description: Makes an NPC find the closest entity carrying a given tag, walk to it, and pick it up with SearchAndPickupBehavior, composing targeting, movement, and pickup into one behavior.
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
    when: the pickup is one step of an ordered chain, such as fetch-then-deliver, rather than the whole task
---

# Making an NPC Search for and Pick Up Tagged Items

Sets up an actor to find the closest entity with a given tag, walk to it, and pick it up using `SearchAndPickupBehavior`. This composes targeting, following, and pickup into a single behavior.

## Trigger Conditions

Activate when the user asks to:
- "Make the NPC pick up any nearby swords"
- "Have the NPC search for coins and collect them"
- "NPC should find the closest blue ball and grab it"
- "When the NPC sees a weapon, it should pick it up"
- Any variation involving searching for and picking up tagged objects

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a movement controller
- NPC entity **MUST** have `ActorPickupItemComponent` for pickup
- Target items **MUST** have `ActorSdkTagComponent` with the matching tag (producer half — see "The Tag Targeting Contract" in the parent skill).
- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC walks to items around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Step 1: Tag the Target Items

Add `ActorSdkTagComponent` (provided by `meta/worlds`) to each item entity and set the `tags` property:

```
ActorSdkTagComponent → tags: ["sword"]
```

All items with the same tag are discoverable. The behavior finds the **closest** one.

## Step 2: Create a Start Behavior Script

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SearchAndPickupBehavior} from '../scripts/Actor/Tagging/SearchAndPickupBehavior';
import {PickupItemSlot} from 'meta/worlds';

@component({description: 'Makes this NPC search for tagged items and pick them up'})
export class StartSearchAndPickupComponent extends Component {
  @property() targetTags: string = 'coin';
  @property() pickupRange: number = 2.0;
  @property() followSpeed: number = 4.0;
  @property() persistent: boolean = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartSearchAndPickupComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const search = new SearchAndPickupBehavior();
    search.name = 'SearchAndPickup';
    search.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    search.pickupRange = this.pickupRange;
    search.followSpeed = this.followSpeed;
    search.pickupSlot = PickupItemSlot.RightHand;
    search.persistent = this.persistent;
    search.basePriority = 30;

    actorLogic.addBehavior(search);
  }
}
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `targetTags` | `[]` | Tags to search for (e.g., `["sword"]`, `["coin"]`, `["blue_ball"]`) |
| `pickupRange` | `2.0` | Distance to trigger pickup (meters, XZ only) |
| `followSpeed` | `5.0` | Movement speed toward target (m/s) |
| `pickupSlot` | `RightHand` | Hand slot for pickup |
| `persistent` | `false` | If true, keeps searching for more items after pickup. If false, finishes after first pickup. |
| `bodyDirectionMode` | `'faceTarget'` | Which direction the actor faces: `'faceTarget'`, `'faceMovement'` (travel direction), `'matchTarget'`, or `'none'` (do not rotate) |
| `basePriority` | `30` | Behavior priority |
| `detectionRange` | `0` | When > 0, behavior stays dormant until target is within this range (meters, XZ). Use with priority system. |

## Priority-Based Activation with detectionRange (Preferred Pattern)

When the NPC has a default behavior (e.g., follow player) and should react to nearby items, use `detectionRange` with the priority system. **This is preferred over SequentialBehavior for conditional/reactive pickup.**

```typescript
@subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
onStart() {
  const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);

  // Default behavior: follow the player
  const follow = new FollowTaggedEntityBehavior();
  follow.targetTags = ['player'];
  follow.followRange = 3.0;
  follow.followSpeed = 5.0;
  follow.basePriority = 10;

  // Reactive behavior: pick up nearby sword when within 5m
  const pickup = new SearchAndPickupBehavior();
  pickup.targetTags = ['sword'];
  pickup.pickupRange = 2.0;
  pickup.followSpeed = 4.0;
  pickup.pickupSlot = PickupItemSlot.RightHand;
  pickup.persistent = false;
  pickup.detectionRange = 5.0;  // Dormant until sword is within 5m
  pickup.basePriority = 20;     // Wins over follow when active

  actorLogic.addBehavior(follow);
  actorLogic.addBehavior(pickup);
}
```

**How it works**: While the target is beyond `detectionRange`, the behavior returns `-1` for all controllers — the lower-priority follow behavior drives movement. When the target enters detection range, the pickup behavior activates at its higher priority, takes over movement, approaches the target, and picks it up. After pickup (`persistent = false`), it sets `isFinished = true` and is removed. The follow behavior resumes automatically.

Once activated, the behavior stays active even if the actor temporarily moves outside the detection range while approaching — no flickering.

## One-Shot vs Persistent Mode

- **One-shot** (`persistent = false`): Pick up one item, then `isFinished = true`. Use with priority-based activation or in `SequentialBehavior` chains.
- **Persistent** (`persistent = true`): After pickup, immediately search for the next item with the same tag. Use for "collect all coins" behavior.

## Chaining with SequentialBehavior

SearchAndPickupBehavior works as a step in a `SequentialBehavior` chain. **Use this only for strictly ordered tasks** (go here, pick up, deliver). For "follow but react to nearby items", use priority-based activation instead.

```typescript
const sequence = new SequentialBehavior();

// Step 1: Find and pick up the key
const pickup = new SearchAndPickupBehavior();
pickup.targetTags = ['key'];
pickup.pickupRange = 2.0;

// Step 2: Deliver to the door (see actor-deliver-to-tag skill)
const deliver = new DeliverToTagBehavior();
deliver.targetTags = ['door'];

sequence.addStep(pickup);
sequence.addStep(deliver);
actorLogic.addBehavior(sequence);
```

## Validation

- [ ] NPC has `ActorSdkLogicComponent`, movement controller, and `ActorPickupItemComponent`
- [ ] Target items have `ActorSdkTagComponent` with matching tag (case-sensitive)
- [ ] Tag string matches exactly between item and behavior
- [ ] Start script uses `ExecuteOn.Owner`
