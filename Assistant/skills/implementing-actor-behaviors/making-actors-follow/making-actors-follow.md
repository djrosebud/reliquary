---
name: making-actors-follow
description: Makes an NPC follow or chase a tagged entity, typically the player, via the tag-based follow system, where the target carries a tag and the follower runs a FollowTaggedEntityBehavior configured with it.
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

# Making an NPC Follow an Entity

Sets up an actor to follow any entity using the tag-based follow system. The system works in two parts:

1. **The target** must carry a tag (via `ActorSdkTagComponent` or automatically via `ActorSdkTagPlayerService`)
2. **The follower** must have a starter script that creates a `FollowTaggedEntityBehavior` configured with that tag

> **NavMesh required.** Following routes through `GotoBehavior`, which pathfinds against a baked NavMesh. Ensure a baked **NavMesh** exists in the scene (create + bake via the `adding-navigation` skill) so the NPC follows around obstacles. Without it, the NPC follows in a straight line and walks through walls.

## Trigger Conditions

Activate when the user's message matches:
- "Make this NPC follow the player"
- "Make this follow the blue ball"
- "Have the enemy chase me"
- "Make this NPC follow my companion"
- "Follow the nearest X"
- Any variation involving an NPC/actor following, chasing, or pursuing an entity

## Step 1: Identify the Target and Choose a Tag

Determine what entity the NPC should follow. The tag is how the follow system finds the target.

**If the target is the player:**
- Tag: `"player"`
- `ActorSdkTagPlayerService` is a `@service()` that auto-tags all players on join — no manual setup needed
- The service activates automatically when the Actor Framework code exists in the project

**If the target is any other entity** (a ball, collectible, another NPC, waypoint, companion):
- Choose a descriptive, lowercase tag (e.g., `"blue_ball"`, `"companion"`, `"treasure"`)
- Go to **Step 2** to tag the target

| User says "follow the..." | Tag value |
|---|---|
| player / me | `"player"` (auto-tagged, skip Step 2) |
| blue ball | `"blue_ball"` |
| enemy | `"enemy"` |
| companion | `"companion"` |
| treasure chest | `"treasure_chest"` |

## Step 2: Tag the Target Entity (skip for players)

Add `ActorSdkTagComponent` (provided by `meta/worlds`) to the target entity's template. This registers the entity in the tagging system so the follower can find it.

1. Open the target entity's template
2. Add the `ActorSdkTagComponent` component (provided by `meta/worlds`)
3. Set the `tags` property to the chosen tag value (e.g., `"blue_ball"`)

**Rules:**
- Tags are **case-sensitive** — `"Player"` and `"player"` are different tags
- Multiple tags can be comma-separated: `"enemy, melee, goblin"`
- The tag MUST exactly match a `targetTags` value on the follow behavior (case-sensitive). See "The Tag Targeting Contract" in the parent skill.

## Step 3: Create a Start Behavior Script for the Follower

Create a script component that wires up `FollowTaggedEntityBehavior` on the NPC. This script goes on the NPC entity (which must already have `ActorSdkLogicComponent`).

```typescript
import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
  property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {FollowTaggedEntityBehavior} from '../scripts/Actor/Tagging/FollowTaggedEntityBehavior';

@component({description: 'Makes this actor follow the closest entity with a matching tag'})
export class StartFollowComponent extends Component {
  @property()
  targetTags: string = 'player';

  @property()
  followRange: number = 3.0;

  @property()
  followSpeed: number = 5.0;

  @property()
  hysteresisRadius: number = 2.0;

  /** 'faceTarget' | 'faceMovement' | 'matchTarget' | 'none' — use string for @property() */
  @property()
  bodyDirectionMode: string = 'faceTarget';

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartFollowComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const follow = new FollowTaggedEntityBehavior();
    follow.name = 'FollowPlayer';
    follow.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    follow.followRange = this.followRange;
    follow.followSpeed = this.followSpeed;
    follow.hysteresisRadius = this.hysteresisRadius;
    follow.bodyDirectionMode = this.bodyDirectionMode as typeof follow.bodyDirectionMode;
    follow.bodyDirectionAngularSpeed = 3.14;
    follow.basePriority = 30;

    actorLogic.addBehavior(follow);
  }
}
```

**Customize the script:**
- Rename the class to match the use case (e.g., `StartChaseBlueBallComponent`, `StartFollowCompanionComponent`)
- Set `follow.name` to something descriptive (e.g., `'ChasePlayer'`, `'FollowBlueBall'`)
- Set `targetTags` default to match the tag from Step 1 (comma-separated for multiple tags)
- Adjust `followRange`, `followSpeed` as appropriate
- **Need a tunable not in the starter?** The starter exposes common defaults only. To use any other parameter from the **Tune Parameters** table below — stuck/threshold knobs (`stuckSpeedThreshold`, `stuckSettleTime`, `targetMovingThreshold`) or `bodyDirectionAngularSpeed` — add a matching `@property()` field to the component and assign `follow.<param> = this.<param>` before `actorLogic.addBehavior(follow)`. Example:

  ```typescript
  @property() stuckSettleTime: number = 0.5;
  // ...inside onStart(), before addBehavior:
  follow.stuckSettleTime = this.stuckSettleTime;
  ```

## Step 4: Attach the Script to the NPC

1. Add the start behavior script to the NPC entity's template (or instance)
2. Set the `targetTags` property to match the tag(s) from Step 1 (comma-separated for multiple)
3. The NPC entity **MUST** already have `ActorSdkLogicComponent` on its root — if not, add it (see `working-with-actor-templates` skill)

## Step 5: Tune Parameters

| Parameter | Default | Description |
|---|---|---|
| `targetTags` | `'player'` | Comma-separated tags to search for (e.g. `'player'`, `'player, enemy'`). The closest entity matching any tag is followed. |
| `followRange` | `3.0` | Distance to maintain from target (meters) |
| `followSpeed` | `5.0` | Maximum movement speed (m/s). The actor may move slower when close to the follow point (see `hysteresisRadius`). |
| `hysteresisRadius` | `0` | Soft-zone radius (m) around the follow point. Inside this zone, the actor decelerates proportionally to distance (arrival behavior) and parks when the target is essentially still. 0 disables hysteresis (original full-speed pursuit). See **Hysteresis Tuning** below. |
| `stuckSpeedThreshold` | `0.1` | Actor XZ speed (m/s) below which the actor is considered stuck. Used by the stuck-but-close fallback to settle when the exact follow point can't be reached (collision, peer crowding). |
| `stuckSettleTime` | `0.5` | Sustained time (s) the actor must remain stuck inside hysteresis before force-settling. 0 disables the fallback. |
| `targetMovingThreshold` | `0.1` | Target XZ speed (m/s) below which the target is "essentially still". Below this, the actor is allowed to fully stop at arrival. At or above, the actor stays in pursuing and decelerates via arrival behavior. |
| `bodyDirectionMode` | `'faceTarget'` | Which direction the actor faces: `'faceTarget'` (face toward the target), `'faceMovement'` (face its travel direction), `'matchTarget'` (face same direction as the target), `'none'` (do not rotate). See **Body Direction Mode** below. |
| `bodyDirectionAngularSpeed` | `3.14` | Rotation speed (radians/sec, 3.14 = 180 deg/s) |
| `basePriority` | `30` | Behavior priority (higher wins). Use 10-50 for normal follow. |

## Hysteresis Tuning

`hysteresisRadius` controls both the dead-zone for micro-corrections AND the arrival deceleration zone. Inside the zone the actor's speed scales linearly from `followSpeed` at the edge to 0 at the center, which self-equilibrates at an offset behind the follow point when the target is moving.

**Choose `hysteresisRadius` based on NPC role:**

| NPC type | `hysteresisRadius` | `followRange` | Rationale |
|---|---|---|---|
| Friendly companion / pet | 2–5 m | 3–10 m | Loose following looks natural; small movements shouldn't trigger repositioning |
| Ranged attacker | 2–4 m | 8–15 m | Stays at distance; doesn't need precision; avoids jitter when target strafes |
| Melee attacker | 0.1–0.25 m | 1–2 m | Needs to be very close to target; precision matters for attack range checks |
| Escort / guide NPC | 1–2 m | 2–4 m | Walks ahead of player; moderate precision |

**Rule of thumb**: `hysteresisRadius` ≤ `followRange`. A hysteresis wider than the follow range means the actor could be further from the target than intended.

## Body Direction Mode

Controls which direction the actor faces while following. Set via `bodyDirectionMode`:

| Mode | Behavior | Best for |
|---|---|---|
| `'faceTarget'` | Face toward the target entity | Enemies, attackers, chasers |
| `'faceMovement'` | Face the direction the actor is travelling (its heading toward the follow point); holds facing when arrived | Followers/creatures that should look where they walk |
| `'matchTarget'` | Face the same direction the target is facing | Companions, escorts, allies walking alongside |
| `'none'` | Do not control body direction — the actor keeps whatever facing it had | When another behavior/system owns rotation, or facing should not change |

**Advanced**: `FollowTaggedEntityBehavior` also supports `debugTextEntity` — an optional in-world text billboard for live state/speed/distance debug output. Only set this up when explicitly asked to debug follow behavior.

## Validation

- [ ] Target entity has a tag (player = auto-tagged, others need `ActorSdkTagComponent`)
- [ ] Tag string on target matches one of the `targetTags` on the follow behavior exactly (case-sensitive)
- [ ] NPC entity has `ActorSdkLogicComponent` on root
- [ ] NPC entity has a movement controller `ActorTransformMoveComponent`
- [ ] A baked NavMesh exists in the scene (via the `adding-navigation` skill) so the NPC follows around obstacles
- [ ] If NPC has animations: `CharacterAnimationController` is on root with `animatorEntity` set
- [ ] Start behavior script uses `ExecuteOn.Owner` (server-side only)
- [ ] Follow behavior is added via `actorLogic.addBehavior()`

## Combining Follow with Reactive Behaviors (Priority System)

When the NPC should follow by default but react to nearby objects (pick up items, flee from enemies), use follow as the **low-priority default** alongside higher-priority reactive behaviors. Do NOT use SequentialBehavior or manually add/remove behaviors.

```typescript
// Follow (low priority) + reactive pickup (high priority with detectionRange)
const follow = new FollowTaggedEntityBehavior();
follow.targetTags = ['player'];
follow.basePriority = 10;  // Low — default behavior

const pickup = new SearchAndPickupBehavior();
pickup.targetTags = ['coin'];
pickup.detectionRange = 5.0;  // Dormant until coin is nearby
pickup.basePriority = 20;     // Higher — interrupts follow when active

actorLogic.addBehavior(follow);
actorLogic.addBehavior(pickup);
```

See `working-with-actor-behaviors` skill for the full priority-based activation pattern.

## Common Mistakes

1. **Tag mismatch** — the behavior's `targetTags` is `["Player"]` but the auto-tagged value is `"player"` (lowercase), so it must be `["player"]`. Tags are case-sensitive.
2. **Missing ActorSdkTagComponent on non-player targets** — Players are auto-tagged by `ActorSdkTagPlayerService`, but everything else needs `ActorSdkTagComponent` added manually with the correct tag string.
3. **Missing ActorSdkLogicComponent on NPC** — The behavior system requires it. All actor templates should include it (see `working-with-actor-templates`).
4. **Running on client** — Behavior logic MUST use `ExecuteOn.Owner`. Client instances receive replicated transforms and do not run behavior logic.
5. **NPC slides without animating** — Missing `CharacterAnimationController`. Add it to the root entity and set `animatorEntity` to the child with `AnimatorComponent`.
6. **Following doesn't start** — The target entity may not be spawned yet when the NPC starts. `FollowTaggedEntityBehavior` handles this automatically — it continuously queries the tagging system until a matching entity appears.
7. **Using SequentialBehavior to combine follow + conditional actions** — If the user says "follow me, but pick up nearby items", do NOT wrap this in a SequentialBehavior. Use priority-based activation instead (see above).
