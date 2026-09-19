---
name: making-actors-go-to-point
description: Makes an NPC walk to a target position with GotoBehavior, the framework primitive for point-to-point movement. Use for any 'walk to', 'move to', or 'go to' request instead of writing a component that sets worldPosition each frame.
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

# Making an NPC Go To a Point

Sets up an actor to walk to a target position using `GotoBehavior` — the
framework's primitive for point-to-point movement. This is the correct way to
make an NPC "walk / move / go to" a location. **Never** write a component that
moves an NPC by setting `transform.worldPosition` each frame.

`GotoBehavior` auto-detects a baked `NavMeshComponent` and pathfinds around
obstacles; if none is found (or it is unbaked) it falls back to straight-line
movement.

> **NavMesh required for obstacle avoidance.** Without a baked **NavMesh** the
> NPC walks in a straight line and through walls. Create + bake one via the
> `adding-navigation` skill. Skip only for deliberately ground-confined actors
> (set `forceStraightLine = true`).

## Trigger Conditions

Activate when the user's message matches:
- "Make this NPC walk to X" / "move to X" / "go to X"
- "Send the enemy to the other side of the map"
- "Walk the zombie to the gate"
- Any verb for moving an actor to a fixed position — including "glide / drift /
  slide / float / move smoothly to X" (all are `GotoBehavior`; set
  `forceStraightLine = true` for a floaty non-NavMesh glide).
- Facing-qualified moves: "walk to X and face the way it's moving" (default) and
  "move to X but never turn / keep facing forward" (set `shouldFaceDirection =
  false`) — both are still a plain `GotoBehavior`, not a bespoke component.

For movement that tracks a moving entity, use `making-actors-follow` instead.

## Step 1: Create a Start Behavior Script

Create a script component that wires up a `GotoBehavior` on the NPC. It goes on
the NPC entity (which must already have `ActorSdkLogicComponent`).

```typescript
import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
  property,
  Vec3,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {GotoBehavior} from '../scripts/Actor/Behaviors/GotoBehavior';

@component({description: 'Makes this actor walk to a fixed target position using GotoBehavior'})
export class StartGoToPointComponent extends Component {
  @property()
  targetX: number = 0;

  @property()
  targetY: number = 0;

  @property()
  targetZ: number = 0;

  @property()
  desiredSpeed: number = 1.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartGoToPointComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const goto = new GotoBehavior();
    goto.name = 'GoToPoint';
    goto.targetPosition = new Vec3(this.targetX, this.targetY, this.targetZ);
    goto.desiredSpeed = this.desiredSpeed;
    goto.basePriority = 10;

    actorLogic.addBehavior(goto);
  }
}
```

**Customize the script:**
- Rename the class for the use case (e.g. `StartWalkToGateComponent`).
- Set the destination. The starter exposes `targetX/Y/Z` as editable properties;
  set them on the template/instance, or assign `goto.targetPosition` from a
  computed `Vec3` (another entity's position, a waypoint, etc.).
- `targetPosition` is re-read every frame, so assigning a moving point makes the
  actor track it (straight-line tracks continuously; NavMesh re-paths each
  `repathInterval`).

## Step 2: Attach the Script to the NPC

1. Add the start behavior script to the NPC entity's template (or instance) and
   set `targetX/Y/Z` (and `desiredSpeed`).
2. The NPC entity **MUST** already have `ActorSdkLogicComponent` on its root and
   a movement controller `ActorTransformMoveComponent`.
   If not, add them — see `working-with-actor-templates`.

## Step 3: Tune Parameters

| Parameter | Default | Description |
|---|---|---|
| `targetPosition` | _(required)_ | `Vec3` destination. No default — must be set before the actor will move. |
| `desiredSpeed` | `1.0` | Movement speed in m/s. |
| `distanceToStop` | `0.1` | Distance (m) at which a path point counts as reached (advances to the next point / stops at the final one). |
| `repathInterval` | `0.2` | Seconds between NavMesh re-paths while moving. |
| `forceStraightLine` | `false` | Skip NavMesh entirely and always move in a straight line (cutscene puppets, tutorial actors, ground-confined entities). |
| `navMeshSnapDistance` | `2` | Snap radius (m) for projecting off-mesh start/end points onto the NavMesh. |
| `navMeshMaxPathSize` | `50` | Cap on the number of path points returned. |
| `shouldFaceDirection` | `true` | Rotate the actor to face its travel direction while walking (releases to hold facing on arrival). Set `false` to leave facing unchanged. |
| `bodyDirectionAngularSpeed` | `3.14` | Turn speed (rad/s) for travel-direction facing; 3.14 ≈ 180°/s. Only used when `shouldFaceDirection` is `true`. |
| `basePriority` | _(inherited)_ | Behavior priority; higher wins when behaviors compete for the movement controller. Use 10 for a default mover. |

## Arrival Is Not a Completion Signal

`GotoBehavior` drives the actor to `targetPosition` and stops moving once within
`distanceToStop` of the final point, but **it does not finish or fire a callback
on arrival** — it stays active and keeps the actor parked there. If you need to
*do something when the actor reaches the destination* (despawn it, start the next
step, play an effect), you must detect arrival yourself:

- For a one-shot "walk there, then act" (e.g. **despawn on arrival**): in a
  component subscribed to `OnWorldUpdateEvent` (`ExecuteOn.Owner`), compare the
  actor's `worldPosition` to the destination each frame and act when the
  distance drops below a threshold.
- For ordered multi-step routines ("go to A, then pick up B"): wrap steps in a
  `SequentialBehavior` (see `sequencing-actor-behaviors`).

## Facing While Walking

By default `GotoBehavior` rotates the actor to face its travel direction: it
claims the body-direction controller and turns the actor toward the path
waypoint it is steering toward, then releases on arrival so the actor holds its
facing at rest. **A bare `GotoBehavior` already looks where it walks** — do not
add a separate behavior, a hand-rolled rotation loop, **or a `GotoBehavior`
subclass/override**, and do not edit `GotoBehavior` itself, just to make a moving
actor turn. Facing is already on the base class.

- To keep a fixed facing (strafing, cutscene puppet, turret that slides), set
  `shouldFaceDirection = false` on the goto — do not lock rotation by hand:
  ```typescript
  const goto = new GotoBehavior();
  goto.shouldFaceDirection = false; // never turn — hold current facing
  ```
- To face a **target** rather than the travel direction (look at the entity you
  follow / chase), use `FollowBehavior` / `FollowTaggedEntityBehavior` with
  `bodyDirectionMode = 'faceTarget'` (see `making-actors-follow`). Those
  behaviors own body direction and turn their nested goto's
  `shouldFaceDirection` off automatically, so the two never fight.

## Validation

- [ ] NPC entity has `ActorSdkLogicComponent` on its root.
- [ ] NPC entity has a movement controller `ActorTransformMoveComponent`.
- [ ] `targetPosition` is set (it has no default).
- [ ] A baked NavMesh exists (via the `adding-navigation` skill) for obstacle avoidance — unless `forceStraightLine` is intended.
- [ ] If the NPC has animations: `CharacterAnimationController` is on root with `animatorEntity` set.
- [ ] Start behavior script uses `ExecuteOn.Owner` (server-side only).
- [ ] The behavior is added via `actorLogic.addBehavior()`.

## Common Mistakes

1. **Hand-rolling movement** — setting `transform.worldPosition`/`localPosition`
   each frame instead of using `GotoBehavior`. This bypasses pathfinding,
   animation, and networking, and breaks at runtime. Always use `GotoBehavior`.
2. **Missing `ActorSdkLogicComponent` on the NPC** — the behavior system
   requires it; all actor templates should include it (see `working-with-actor-templates`).
3. **Missing movement controller** — the NPC will not move (or slides without
   animating). Add `ActorTransformMoveComponent`,
   plus `CharacterAnimationController` if it has animations.
4. **Running on the client** — behavior logic MUST use `ExecuteOn.Owner`. Client
   instances receive replicated transforms and do not run behavior logic.
5. **Expecting arrival to trigger something** — `GotoBehavior` does not signal
   completion. Detect arrival yourself (see "Arrival Is Not a Completion Signal").
6. **No baked NavMesh** — the actor falls back to straight-line and walks through
   walls. Bake a NavMesh with the `adding-navigation` skill.
7. **Hand-rolling rotation to make the actor face its path** — unnecessary.
   `GotoBehavior` faces its travel direction by default (`shouldFaceDirection =
   true`) and a per-frame `transform.worldRotation` loop is overwritten by the
   body-direction controller anyway. Leave `shouldFaceDirection` on for normal
   "walk and look where you're going"; set it `false` only when the actor must
   keep a fixed facing (see "Facing While Walking").
8. **Wrapping, subclassing, overriding, or editing `GotoBehavior` to add
   facing** — never needed, and it *fights* the built-in facing (two controllers
   claim body direction). Travel-direction facing is already on the base class,
   so all of these are wrong and merely duplicate it: a `class X extends
   GotoBehavior`; a **new `ActorBehavior` that holds a `new GotoBehavior()` and
   re-implements `getControllerUsePriority` / `useController` / `rotateBodyTo`**;
   or a hand-edit of `GotoBehavior.ts`. A bare `GotoBehavior` is the whole answer.

   ```typescript
   // ❌ WRONG — wraps GotoBehavior and re-implements facing it already does
   class WalkToPosition extends ActorBehavior {
     private goto = new GotoBehavior();
     override useController(t, c) { /* rotateBodyTo(...) */ } // duplicates built-in
   }
   // ✅ RIGHT — a bare GotoBehavior already faces its travel direction
   const goto = new GotoBehavior();
   goto.targetPosition = pos;            // faces where it walks; no facing code
   // goto.shouldFaceDirection = false;  // ONLY if the actor must not turn
   actorLogic.addBehavior(goto);
   ```
9. **Hardcoding intermediate waypoints to route around an obstacle** — building a
   `SequentialBehavior` of `GotoBehavior` steps at hand-picked "gap" points
   (`LEFT_GAP`, `RIGHT_GAP`, then the goal), or setting `forceStraightLine = true`,
   to steer an NPC around a wall. This bypasses the NavMesh and hardcodes a fragile,
   world-specific route that straight-lines through the wall whenever the guessed
   lane is wrong and breaks on any geometry change. Set only the final
   `targetPosition` (the goal) and let a baked NavMesh compute the detour. If the
   NPC still clips the wall, the NavMesh is unbaked/stale — fix it via
   `adding-navigation` (rebake; confirm a route with a non-empty
   `NavMeshComponent.findPath()`, not `visualize_nav_mesh`), not by adding
   waypoints.

   ```typescript
   // ❌ WRONG — hand-encoded gap waypoints substitute for NavMesh routing
   const gotoGap = new GotoBehavior();
   gotoGap.targetPosition = new Vec3(-17, 0, 0);  // guessed LEFT_GAP waypoint
   const gotoCastle = new GotoBehavior();
   gotoCastle.targetPosition = castlePosition;    // the real goal
   gotoCastle.forceStraightLine = true;           // bypasses the NavMesh
   const seq = new SequentialBehavior();
   seq.addStep(gotoGap);
   seq.addStep(gotoCastle);
   actorLogic.addBehavior(seq);                    // sequence used AS a detour
   // ✅ RIGHT — one destination; a baked NavMesh routes around the wall
   const goto = new GotoBehavior();
   goto.targetPosition = castlePosition;  // NavMesh computes the detour
   actorLogic.addBehavior(goto);
   ```
