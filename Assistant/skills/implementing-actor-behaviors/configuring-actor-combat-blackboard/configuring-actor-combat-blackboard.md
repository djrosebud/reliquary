---
name: configuring-actor-combat-blackboard
description: Sets up CombatBlackboard, the shared store combat behaviors read targets from and detection or threat systems write into, tracking each target with a dead flag so it can be marked without immediate removal. Use for faction targeting or external target selection.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
---

# Combat Target Tracking with CombatBlackboard

`CombatBlackboard` is a shared data store for combat target information. External systems (detection, threat assessment, health tracking) write targets into it, and combat behaviors read from it to select and engage targets.

Each target is tracked as a `CombatTarget` with an entity reference and an `isDead` flag, allowing systems to mark dead targets without removing them immediately.

## Trigger Conditions

Activate when the user asks to:
- "Track combat targets for a group of NPCs"
- "Share enemy lists between NPCs" / "Coordinate targeting across a faction"
- "Register targets for combat behaviors" / "Add enemies to a target list"
- "Set up faction-based targeting" / "Make teams aware of each other's enemies"
- Any variation involving shared combat target data between actors or systems

## Prerequisites

- Actor Framework deployed — checked in at `scripts/Actor/`
- `ActorSdkBlackboardManager` service active (bootstrapped by `ActorSdkManagerComponent`)

## Scopes

`CombatBlackboard` can operate at three scopes via `BlackboardScope`:

- **Global** — one shared target list for all actors. Use for simple games where every NPC shares the same enemies.
- **Group** — per-faction target list keyed by a group ID (e.g. `"team_red"`, `"guards"`). Use for faction-based combat where each team tracks different enemies.
- **Individual** — per-actor target overrides. Use when a specific actor has unique targeting rules.

The blackboard manager resolves scope automatically — an actor checking for targets will see individual > group > global in priority order.

## Usage

### Writing Targets (Detection System)

An external system (trigger zone, proximity check, health event) registers targets:

```typescript
import {ActorSdkBlackboardManager} from 'meta/worlds';
import {CombatBlackboard} from '../scripts/Actor/Core/Blackboard/Implementations/CombatBlackboard';
import {BlackboardScope} from 'meta/worlds';
import {Service} from 'meta/worlds';

const bbManager = Service.inject(ActorSdkBlackboardManager);

// Register a target for a faction
const combatBB = bbManager.getBlackboard(
  CombatBlackboard,
  undefined,        // no specific actor
  'guards',         // group ID
  BlackboardScope.Group
);
combatBB?.addTarget(enemyEntity);

// Mark a target as dead (keeps it in the list for tracking)
combatBB?.updateTarget(enemyEntity, {isDead: true});

// Remove a target entirely
combatBB?.removeTarget(enemyEntity);
```

### Reading Targets (Combat Behavior)

A behavior or system queries for targets:

```typescript
const combatBB = bbManager.getBlackboard(
  CombatBlackboard,
  actorId,
  factionId
);

// Get all alive targets
const aliveTargets = combatBB?.getAliveTargets();

// Get the primary (first) alive target
const primaryTarget = combatBB?.getPrimaryAliveTarget();

// Check if there are any valid targets
if (combatBB?.hasValidTargets()) {
  // engage
}
```

## API

| Method | Returns | Description |
|---|---|---|
| `addTarget(entity)` | `void` | Adds a target (prevents duplicates) |
| `removeTarget(entity)` | `void` | Removes a target from the list |
| `updateTarget(entity, data, addIfNotExists?)` | `void` | Updates target data (e.g. `{isDead: true}`) |
| `getValidTargets()` | `CombatTarget[]` | All targets with status |
| `getAliveTargets()` | `Entity[]` | Only alive target entities |
| `getPrimaryTarget()` | `CombatTarget?` | First target in list |
| `getPrimaryAliveTarget()` | `Entity?` | First alive target |
| `hasValidTargets()` | `boolean` | True if any targets exist |
| `getTargetCount()` | `number` | Number of targets |
| `isValidTarget(entity)` | `boolean` | Check if entity is tracked |
| `clearTargets()` | `void` | Remove all targets |

## Integration with CharacterGASComponent

`ActorGASHealthComponent` has a `blackboardGroupId` property (the shared `CharacterGASComponent` base does not - blackboard reporting is actor-only). When set, the health component can report death events to the `CombatBlackboard` at the group scope, allowing faction members to know when a target has died.

## Common Mistakes

1. **Wrong scope** — using `Global` when you need per-faction targeting means all NPCs share the same enemy list regardless of team.
2. **Forgetting to remove dead targets** — `updateTarget(entity, {isDead: true})` marks a target dead but keeps it in the list. Use `removeTarget()` to fully clean up, or filter with `getAliveTargets()`.
3. **Missing `ActorSdkBlackboardManager`** — the blackboard system requires `ActorSdkManagerComponent` on a scene entity to bootstrap services.
