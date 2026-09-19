---
name: configuring-actor-attention
description: Makes an NPC look at the nearest player in range and idle-gaze elsewhere when nobody is near, using AttentionBehavior at a low controller priority so combat and death can override the gaze.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
---

# Making an NPC Look at the Player (Attention Behavior)

Sets up an actor to look at the nearest player when they are within range, and idle-gaze in random directions when no player is nearby. Uses `AttentionBehavior` which claims the `ActorLookController` at low priority so higher-priority behaviors (combat, death) can override the look direction.

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC look at the player"
- "Have the NPC face me when I'm nearby"
- "Add idle look-at behavior"
- "Make the NPC watch the player"
- Any variation involving an NPC looking at, watching, or paying attention to entities

## Prerequisites

- NPC entity **MUST** have `ActorSdkLogicComponent` on root
- NPC entity **MUST** have a look controller (e.g., `ActorAnimatedLookController`)
- Actor Framework deployed — checked in at `scripts/Actor/`

## Step 1: Create a Start Behavior Script

Create a script component that wires up `AttentionBehavior` on the NPC.

```typescript
import {
  component, Component, subscribe, OnEntityStartEvent, ExecuteOn, property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {AttentionBehavior, AttentionTargetMode} from '../scripts/Actor/Behaviors/AttentionBehavior';

@component({description: 'Makes this NPC look at the nearest player when nearby'})
export class StartAttentionComponent extends Component {
  @property() attentionRange: number = 10.0;
  @property() lookSpeed: number = 0.15;
  @property() idleGazeEnabled: boolean = true;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartAttentionComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const attention = new AttentionBehavior();
    attention.name = 'Attention';
    attention.targetMode = AttentionTargetMode.NearestPlayer;
    attention.attentionRange = this.attentionRange;
    attention.lookSpeed = this.lookSpeed;
    attention.idleGazeEnabled = this.idleGazeEnabled;
    attention.basePriority = 5; // Low priority — other behaviors override

    actorLogic.addBehavior(attention);
  }
}
```

## Step 2: Attach the Script to the NPC

1. Add the start behavior script to the NPC entity
2. The NPC entity **MUST** have `ActorSdkLogicComponent` and a look controller on its root

## Target Modes

| Mode | Description |
|------|-------------|
| `AttentionTargetMode.NearestPlayer` | Automatically targets the closest player within range |
| `AttentionTargetMode.SpecificEntity` | Targets a specific entity set via `targetEntity` property |

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `targetMode` | `NearestPlayer` | How to select the look target |
| `attentionRange` | `10.0` | Max distance (meters) to detect targets |
| `lookSpeed` | `0.15` | Interpolation speed when tracking a target (0-1) |
| `idleGazeEnabled` | `true` | Enable random idle gaze when no target in range |
| `idleLookSpeed` | `0.05` | Interpolation speed for idle gaze |
| `idleGazeMinInterval` | `2.0` | Min seconds between idle gaze changes |
| `idleGazeMaxInterval` | `5.0` | Max seconds between idle gaze changes |
| `idleGazeMaxAngle` | `45.0` | Max horizontal angle (degrees) for idle gaze |
| `targetHeightOffset` | `1.5` | Height offset for look-at target (head height) |
| `basePriority` | `5` | Low priority so combat/death behaviors override |

## Combining with Other Behaviors

AttentionBehavior is designed to run alongside other behaviors as an always-active ambient behavior. Set `basePriority` low (5-10) so it yields the look controller to higher-priority behaviors:

```typescript
// Attention at priority 5 (always active, yields to combat)
attention.basePriority = 5;

// Follow at priority 30 (overrides attention look direction)
follow.basePriority = 30;

// Combat at priority 100 (overrides everything)
combat.basePriority = 100;
```

## Validation

- [ ] NPC has `ActorSdkLogicComponent` on root
- [ ] NPC has a look controller (`ActorAnimatedLookController`)
- [ ] Start script uses `ExecuteOn.Owner`
- [ ] `basePriority` is low (5-10) to avoid overriding other behaviors
