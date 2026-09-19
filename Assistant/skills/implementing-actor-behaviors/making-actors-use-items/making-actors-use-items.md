---
name: making-actors-use-items
description: Makes an NPC walk to a target and use a held item on it with UseItemBehavior, invoking a game-supplied callback at range — key on door, potion on ally, lever activation — and optionally dropping or destroying the item or target afterwards.
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

# Making an NPC Use an Item on a Target

`UseItemBehavior` makes an actor walk to a target entity and use a held item on it. When the actor reaches the target (within `useRange`), it invokes an `onUseItem` callback with the actor, target, and item entities. Game scripts provide this callback to implement the "use" logic (open door, consume potion, activate lever, etc.).

After use, optionally drops or destroys the held item and/or target.

## Trigger Conditions

Activate when the user asks to:
- "Make the NPC use the key on the door"
- "Have the NPC pick up a potion and use it on the wounded NPC"
- "NPC should grab the lever handle and pull it"
- "Make the enemy use their weapon on the target"
- Any variation involving an NPC using a held item on another entity

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a movement controller `ActorTransformMoveComponent`
- NPC entity **MUST** have `ActorPickupItemComponent` for pickup/drop
- The NPC must be holding an item (picked up via `SearchAndPickupBehavior` or manually)
- The target entity must exist in the scene
- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC walks to the target around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)

## Step 1: Create a Start Behavior Script

Create a component that sets up `UseItemBehavior` with the target entity and callback:

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
  type Entity, TransformComponent,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {UseItemBehavior} from './Actor/Behaviors/UseItemBehavior';
import {SearchAndPickupBehavior} from './Actor/Tagging/SearchAndPickupBehavior';
import {SequentialBehavior} from './Actor/Behaviors/SequentialBehavior';

@component()
export class UseItemOnTargetScript extends Component {
  @property() itemTag: string = 'key';
  @property() targetEntity: Entity | null = null;
  @property() useRange: number = 2.0;
  @property() moveSpeed: number = 5.0;
  @property() destroyItemAfterUse: boolean = true;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic || !this.targetEntity) { return; }

    // Step 1: Pick up the item by tag
    const pickup = new SearchAndPickupBehavior();
    pickup.targetTags = [this.itemTag];
    pickup.pickupRange = 2.0;

    // Step 2: Walk to target and use the item
    const useItem = new UseItemBehavior();
    useItem.targetEntity = this.targetEntity;
    useItem.useRange = this.useRange;
    useItem.moveSpeed = this.moveSpeed;
    useItem.destroyItemAfterUse = this.destroyItemAfterUse;
    useItem.onUseItem = (actor, target, item, slot) => {
      // Game-specific logic goes here
      console.log('Item used on target!');
    };

    // Chain them in sequence: pickup → use
    const sequence = new SequentialBehavior();
    sequence.addStep(pickup);
    sequence.addStep(useItem);
    sequence.basePriority = 30;

    actorLogic.addBehavior(sequence);
  }
}
```

## Step 2: Using the Editor Starter Component

Alternatively, use `StartUseItemBehaviorComponent` for editor-configurable setup:

1. Add `StartUseItemBehaviorComponent` to the NPC entity
2. Set `targetEntity` to the entity the item should be used on
3. Set `useRange` (default 2.0 meters)
4. Set `moveSpeed` (default 5.0)
5. Configure `dropAfterUse`, `destroyItemAfterUse`, `destroyTargetAfterUse` as needed

## Key Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `targetEntity` | Entity | null | The entity to use the item on |
| `useSlot` | PickupItemSlot | RightHand | Which hand slot holds the item |
| `useRange` | number | 2.0 | Distance from target at which the item is used |
| `moveSpeed` | number | 5.0 | Movement speed toward the target |
| `dropAfterUse` | boolean | true | Drop the item after use |
| `destroyItemAfterUse` | boolean | false | Destroy the item entity after use |
| `destroyTargetAfterUse` | boolean | false | Destroy the target entity after use |
| `onUseItem` | callback | null | Game-specific use logic |

## How It Works

1. `UseItemBehavior` creates an internal `GotoBehavior` to walk toward the target
2. Each frame, checks XZ distance to the target
3. When within `useRange`, sets `pendingUse = true` and stops moving
4. Claims `ActorPickupItemController` only when `pendingUse` is true (does not interfere with other pickup behaviors during walk phase)
5. Executes the `onUseItem` callback with actor, target, item, and slot
6. Optionally drops/destroys the item and/or target
7. Sets `isFinished = true`

## Drop Items on Death

`DeathBehavior` supports automatic item dropping when the actor dies:

```typescript
const death = new DeathBehavior();
death.dropItemsOnDeath = true; // drops all held items when HP reaches 0
death.basePriority = 1000;
actorLogic.addBehavior(death);
```

When `dropItemsOnDeath` is enabled, `DeathBehavior` claims `ActorPickupItemController` at priority 1000 on death and drops all items from all hand slots.

## Common Patterns

### Key Opens Door
```typescript
useItem.onUseItem = (actor, target, item, slot) => {
  const door = target.getComponent(DoorController);
  if (door) { door.open(); }
};
useItem.destroyItemAfterUse = true; // key consumed
```

### Potion Heals Target
```typescript
useItem.onUseItem = (actor, target, item, slot) => {
  const health = target.getComponent(CharacterGASComponent);
  if (health) {
    const data = health.getHealthData();
    data.currentHealth = data.maxHealth;
    health.setHealthData(data);
  }
};
useItem.destroyItemAfterUse = true; // potion consumed
```

### Lever Activation
```typescript
useItem.onUseItem = (actor, target, item, slot) => {
  const lever = target.getComponent(LeverScript);
  if (lever) { lever.toggle(); }
};
useItem.dropAfterUse = false; // keep holding the lever handle
```

## See Also

- `making-actors-search-and-pickup` — How to make NPCs find and pick up tagged items
- `making-actors-deliver-to-tag` — How to make NPCs deliver held items to tagged locations
- `making-actors-fetch` — Higher-level fetch-and-deliver using `SimpleFetchBehavior`
- `making-actors-die` — Death behavior with `dropItemsOnDeath` support
- `sequencing-actor-behaviors` — How to chain pickup → use in sequence
