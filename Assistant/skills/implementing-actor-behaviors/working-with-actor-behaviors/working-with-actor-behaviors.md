# Working with Actor Behaviors

Rules and patterns for building `ActorBehavior` subclasses in the Actor Framework. Follow these when creating new behaviors or modifying existing ones.

## CRITICAL: Never Use Service.inject() in Behaviors

**`Service.inject()` must NEVER be called inside a behavior class.** It will cause an infinite hang at initialization and never resolve.

Behaviors run inside the Actor Framework's own update loop, which executes after services are initialized. Calling `Service.inject()` from within a behavior creates a circular dependency that blocks forever.

### Anti-pattern (BROKEN — will hang forever):

```typescript
// ❌ DO NOT DO THIS
import {Service} from 'meta/worlds';
import {ActorSdkBlackboardManager} from 'meta/worlds';

export class MyBehavior extends ActorBehavior {
  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    const bbManager = Service.inject(ActorSdkBlackboardManager); // ❌ HANGS FOREVER
  }
}
```

### Correct pattern — access services via behaviorManager:

```typescript
// ✅ CORRECT — use behaviorManager to access services
export class MyBehavior extends ActorBehavior {
  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    const taggingBB = this.behaviorManager!.actorBlackboardManager.getBlackboard(
      ActorTaggingBlackboard,
      undefined,
      undefined,
      BlackboardScope.Global,
    );
  }
}
```

The `ActorBehaviorManager` interface exposes:
- `actorBlackboardManager` — the `ActorSdkBlackboardManager` instance
- `actorEntity` — the entity this behavior belongs to
- `getActorId()` — the actor's ID for blackboard lookups
- `blackboardGroupId` — optional group ID for group-scoped blackboards
- `getControllers<T>(typeId)` — all registered controllers of the given type as a `ReadonlyArray<T>` (empty if none); use `[0]` for the first match

**Reference implementation**: See `TargetTaggedEntityBehavior.ts` for the correct blackboard access pattern via `this.behaviorManager.actorBlackboardManager`.

## Accessing Blackboards in Behaviors

Always get blackboards through `this.behaviorManager.actorBlackboardManager`:

```typescript
// Get a global-scope blackboard
const bb = this.behaviorManager!.actorBlackboardManager.getBlackboard(
  MyBlackboard,
  undefined,
  undefined,
  BlackboardScope.Global,
);

// Get with automatic scope fallback (individual → group → global)
const bb = this.behaviorManager!.actorBlackboardManager.getBlackboard(
  MyBlackboard,
  this.behaviorManager!.getActorId(),
  this.behaviorManager!.blackboardGroupId,
);
```

## Behavior Lifecycle

1. **Construction** — `new MyBehavior()` creates the instance. Set configuration properties here.
2. **`initialize(behaviorManager)`** — Called once when the behavior is added. Always call `super.initialize(behaviorManager)`. Safe to access `this.behaviorManager`, `this.getEntity()`, and services via the manager **only AFTER** `super.initialize()`.
3. **`update(deltaTime)`** — Called every frame while the behavior is active.
4. **`onRemove()`** — Called when the behavior is removed. Clean up subscriptions, timers, etc.
5. **`isFinished = true`** — Set this to have the behavior auto-removed at end of update cycle.

### CRITICAL: Call super.initialize() Before this.getEntity()

`this.getEntity()` returns `this.behaviorManager!.actorEntity`. The `behaviorManager` field is set inside `super.initialize(behaviorManager)`. Calling `this.getEntity()` **before** `super.initialize()` will return null and crash.

```typescript
// BROKEN — getEntity() before super.initialize() returns null
override initialize(behaviorManager: ActorBehaviorManager): void {
  const transform = this.getEntity().getComponent(TransformComponent); // CRASH
  super.initialize(behaviorManager);
}

// CORRECT — super.initialize() first, then getEntity()
override initialize(behaviorManager: ActorBehaviorManager): void {
  // Set up sub-behaviors, config, etc. first
  this.subBehaviors = [...];
  super.initialize(behaviorManager);
  // NOW safe to use getEntity()
  this.actorTransform = this.getEntity().getComponent(TransformComponent);
}
```

This applies to any method that accesses `this.behaviorManager` — `getEntity()`, `this.behaviorManager.actorBlackboardManager`, etc. All must come after `super.initialize()`.

## Behavior Priority and Controllers

- `basePriority` determines which behavior wins access to shared controllers (movement, body direction, etc.)
- `getControllerUsePriority(controllerType)` — return `basePriority` to claim a controller, `-1` to skip
- `useController(controllerType, controller)` — called on the winning behavior to issue commands
- Higher priority = wins. If two behaviors want the same controller, only the highest priority one gets it.

### Priority-Based Activation (Reactive Behaviors)

The priority system is the **primary mechanism** for conditional behavior switching. When an NPC needs a default behavior (e.g., follow player) that can be interrupted by a reactive behavior (e.g., pick up a nearby item), use competing priorities — **never** manually add/remove behaviors at runtime from a component.

**Pattern**: Add all behaviors at startup. Give the default behavior a low priority and the reactive behavior a high priority with a `detectionRange`. The reactive behavior stays dormant (returns `-1` for all controllers) until its activation condition is met, then its higher priority takes over. When it finishes, the default behavior resumes automatically.

```typescript
// CORRECT — priority-based activation
@subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
onStart() {
  const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);

  // Default: follow the player (always active, low priority)
  const follow = new FollowTaggedEntityBehavior();
  follow.targetTags = ['player'];
  follow.followRange = 3.0;
  follow.followSpeed = 5.0;
  follow.basePriority = 10;

  // Reactive: pick up pyramid when within 4m (dormant until in range, high priority)
  const pickup = new SearchAndPickupBehavior();
  pickup.targetTags = ['pyramid'];
  pickup.pickupRange = 2.0;
  pickup.detectionRange = 4.0;  // Dormant until target is within 4m
  pickup.persistent = false;     // Finish after pickup
  pickup.basePriority = 20;      // Higher than follow → takes over when active

  actorLogic.addBehavior(follow);
  actorLogic.addBehavior(pickup);
  // No update loop needed — the behavior manager handles transitions
}
```

**How it works**:
1. Both behaviors are added at startup. The behavior manager calls `update()` on all of them every frame.
2. While the pyramid is far away, `SearchAndPickupBehavior.getControllerUsePriority()` returns `-1` (dormant). The follow behavior wins all controllers at priority 10.
3. When the pyramid enters detection range, the pickup behavior activates and returns priority 20. It wins the movement controller, taking over from follow.
4. After pickup, the behavior sets `isFinished = true` and is removed. The follow behavior, still active, resumes control.

**When to use**: NPC that follows a player but reacts to nearby items, enemies, or triggers. Guard that patrols but chases intruders. Any "default + interrupt" pattern.

### Timed / Periodic Switching (time-based cycles)

For a **time-based** cycle — "wander, then follow the player for 15s every 3s, then wander again", "patrol for 10s then rest for 5s", any "do X for a while, then Y for a while, repeating" — the trigger is a **timer**, not a spatial/proximity condition. It is still priority-based activation: the same rule applies — **keep both behaviors registered and gate by priority; NEVER add/remove behaviors on a timer.**

The idiom is a **self-gating behavior** that owns its own timer and returns `-1` from `getControllerUsePriority` while it is in its "off" window (exactly like `detectionRange` gates `SearchAndPickupBehavior`, but on elapsed time instead of distance). The default behavior stays registered at a lower priority and automatically resumes whenever the timed behavior is dormant.

For the common **timed follow** case, this project already ships the behavior — **do not hand-write it, and do not copy over it**. **`TimedFollowBehavior`** is checked in at `scripts/Actor/Tagging/TimedFollowBehavior.ts`: a `FollowTaggedEntityBehavior` that self-gates on `activeDuration` / `dormantDuration`. Register it once alongside the default — no `OnWorldUpdateEvent` component, no `addBehavior`/`removeBehavior`:

```typescript
import {IdleWanderBehavior} from '../Behaviors/IdleWanderBehavior';
import {TimedFollowBehavior} from '../Tagging/TimedFollowBehavior';

@subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
onStart() {
  const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);

  // Default: wander (always registered, low priority)
  const wander = new IdleWanderBehavior();
  wander.basePriority = 10;

  // Timed: follow the player in 15s windows, dormant 3s between (high priority)
  const follow = new TimedFollowBehavior();
  follow.targetTags = ['player'];
  follow.basePriority = 20;      // higher than wander → wins while active
  follow.activeDuration = 15.0;
  follow.dormantDuration = 3.0;

  actorLogic.addBehavior(wander);
  actorLogic.addBehavior(follow);
  // The behavior manager handles the transitions — nothing else to do.
}
```

While `follow` is dormant it returns `-1`, so `wander` (priority 10) drives movement; when `follow` activates it returns priority 20 and takes over. This is the correct shape for a timed cycle — **do not** bolt a `phaseTimer` onto a separate `OnWorldUpdateEvent` component that calls `addBehavior`/`removeBehavior` (the anti-pattern in "Never Manually Add/Remove Behaviors" below): that fights the priority system and is fragile.

**For a timed cycle of some OTHER behavior** (e.g. periodic patrol, timed flee), there is no shipped variant yet — apply the same self-gating shape `TimedFollowBehavior` uses: subclass the behavior, seed `phaseTimer = dormantDuration` in `initialize()`, flip `active` on the timer in `update()` (calling `super.update`), and return `-1` from `getControllerUsePriority` while dormant. Register it once alongside the default; never add/remove on a timer.

### Choosing the Right Composition Pattern

| Pattern | Use When | Example |
|---------|----------|---------|
| **Priority-based** (multiple behaviors, different priorities) | Default behavior + conditional interrupts | Follow player, pick up nearby items |
| **Priority-based, self-gating on a timer** (default + timed behavior) | Default behavior + a behavior that turns on/off on a **time-based** cycle | Wander, then follow the player 15s every 3s |
| **CompositeBehavior** (concurrent sub-behaviors) | Sub-behaviors run simultaneously, sharing data | Targeting + following at the same time |
| **SequentialBehavior** (ordered steps) | Steps are strictly ordered with no default to return to | Go to A, pick up B, deliver to C |

**Decision rule**: If the user says "while doing X, if Y happens, do Z" → priority-based. If the user says "do X for a while, then Y for a while, repeating" (a timer) → priority-based, self-gating on a timer (see "Timed / Periodic Switching"). If the user says "do X, then Y, then Z" (once, ordered) → SequentialBehavior. In every case: register the behaviors and let priority arbitrate — never add/remove on a timer or condition.

### Tag targeting: wire both ends

Tag-based behaviors (`FollowTaggedEntityBehavior`, `SearchAndPickupBehavior`,
`EngageCombatBehavior`, etc.) resolve their target from the `ActorTaggingBlackboard`.
Setting `targetTags` on the actor is only half the wiring: the **target entity**
must also be tagged with the same case-sensitive string — players auto-tag as
`"player"` (via `ActorSdkTagPlayerService`), everything else needs
`ActorSdkTagComponent` with `tags: [...]`. See "The Tag Targeting Contract" in the
parent `implementing-actor-behaviors` skill. Setting `targetTags` with nothing
tagged on the target side is a silent no-op — the actor acquires nothing.

## Controlling Actor Facing (Body Direction)

An actor's body rotation is owned by the `ActorBodyDirectionController`
(implemented by `ActorTransformMoveComponent`). Behaviors compete for it by
priority, exactly like the movement controller — so set facing through the
owning behavior's parameters, never by writing `transform.worldRotation`
yourself (see the hand-roll prohibition in `implementing-actor-behaviors`).

| Goal | Parameter (default) | Behavior |
|------|---------------------|----------|
| Face the followed/chased target | `bodyDirectionMode = 'faceTarget'` (default) | `FollowBehavior` / `FollowTaggedEntityBehavior` |
| Face the direction it is moving | `bodyDirectionMode = 'faceMovement'` | `FollowBehavior` / `FollowTaggedEntityBehavior` |
| Face the same way the target faces | `bodyDirectionMode = 'matchTarget'` | `FollowBehavior` |
| Do not rotate the actor at all | `bodyDirectionMode = 'none'` | `FollowBehavior` |
| Face the combat target while attacking | `rotateTowardsTarget = true` (default) | `AttackEntityInRangeBehavior` |
| Face where it walks | `rotateTowardsMovement = true` (default) | `PatrolBehavior`, `IdleWanderBehavior`, `FleeBehavior` |
| Face the travel direction while walking to a point | `shouldFaceDirection = true` (default) | `GotoBehavior` |

Turn rate is `bodyDirectionAngularSpeed` (radians/sec; `3.14` ≈ 180°/s).

**A bare `GotoBehavior` turns the actor to face its travel direction by
default** (`shouldFaceDirection = true`): it claims the body-direction
controller toward the path waypoint it is steering to, and releases on arrival
so the actor holds its facing at rest. So point-to-point movement already looks
where it walks — no extra behavior and no hand-written rotation loop needed.
**Do not subclass, wrap, or edit `GotoBehavior` to add facing** — a `class X
extends GotoBehavior`, or a new behavior that holds a `new GotoBehavior()` and
re-implements `getControllerUsePriority` / `useController` / `rotateBodyTo`, only
duplicates and *fights* the built-in facing (two controllers claim body
direction). Instantiate `GotoBehavior` directly. Set `shouldFaceDirection =
false` to keep a fixed facing. Behaviors that compose a
`GotoBehavior` and own body direction themselves (`FollowBehavior`,
`FleeBehavior`, `IdleWanderBehavior`, `LeadBehavior`, `SimpleFetchBehavior`,
`UseItemBehavior`) set the nested goto's `shouldFaceDirection` off
automatically, so the two never fight; use their own facing parameters (e.g.
`bodyDirectionMode`) instead. Non-framework movement still never rotates the
actor — route movement through the Actor Framework.

Because a bare `GotoBehavior` now claims the body-direction controller, if you
add your own facing behavior alongside a bare goto on the same actor, give it a
higher `basePriority` than the goto (equal priorities have no defined winner) —
or set the goto's `shouldFaceDirection = false` and let your behavior own
facing.

## CRITICAL: Never Manually Add/Remove Behaviors for Conditional Logic

**Do NOT write a component that uses `OnWorldUpdateEvent` to check conditions and then calls `addBehavior()`/`removeBehavior()` at runtime.** This bypasses the behavior priority system and creates fragile, hard-to-extend code.

### Anti-pattern (BROKEN — bypasses priority system):

```typescript
// DO NOT DO THIS
@subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
onUpdate() {
  if (this.isTargetNearby()) {
    this.actorLogic.removeBehavior(this.followBehavior);  // WRONG
    this.actorLogic.addBehavior(pickupSequence);           // WRONG
  }
}
```

### Correct pattern — use priority-based activation:

Add all behaviors at startup with different priorities. Use `detectionRange` on reactive behaviors so they stay dormant until conditions are met. See "Priority-Based Activation" section above.

## Composing Behaviors

Use `CompositeBehavior` to combine multiple sub-behaviors (e.g. targeting + following). Sub-behaviors share data via plain objects (like `TargetInfo`), not via services or globals.

```typescript
export class MyCompositeBehavior extends CompositeBehavior {
  override initialize(behaviorManager: ActorBehaviorManager): void {
    const sharedData = new MySharedData();

    const subBehavior1 = new SubBehavior1();
    subBehavior1.sharedData = sharedData;

    const subBehavior2 = new SubBehavior2();
    subBehavior2.sharedData = sharedData;

    this.subBehaviors = [subBehavior1, subBehavior2];
    super.initialize(behaviorManager);
  }
}
```

## Using FollowBehavior Internally

Many behaviors (patrol, escort, guard) need movement to a target. Reuse `FollowBehavior` internally rather than reimplementing movement:

```typescript
this.followBehavior = new FollowBehavior();
this.followBehavior.basePriority = this.basePriority;
this.followBehavior.followSpeed = this.speed;
this.followBehavior.followRange = 0;
this.followBehavior.targetEntity = targetEntity;
await this.followBehavior.initialize(this.behaviorManager!);

// In update():
await this.followBehavior.update(deltaTime);
```

Delegate `getControllerUsePriority` and `useController` to the internal follow behavior so it can drive movement and body direction controllers.

## Sequencing Behaviors

Use `SequentialBehavior` to run behaviors one after another. Each step runs exclusively until it sets `isFinished = true`, then the next step initializes and starts.

**Use SequentialBehavior ONLY for strictly ordered tasks** (go to A, pick up B, deliver to C) where there is no persistent default behavior to return to.

**Do NOT use SequentialBehavior when** the user describes a "default + conditional interrupt" pattern (e.g., "follow the player, but pick up nearby items"). Use priority-based activation instead — see the "Priority-Based Activation" section above.

**Use CompositeBehavior when** sub-behaviors run concurrently (targeting + following at the same time).

### Example: Go to item, pick it up, follow the player

```typescript
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SequentialBehavior} from '../scripts/Actor/Behaviors/SequentialBehavior';
import {SearchAndPickupBehavior} from '../scripts/Actor/Tagging/SearchAndPickupBehavior';
import {FollowTaggedEntityBehavior} from '../scripts/Actor/Tagging/FollowTaggedEntityBehavior';
import {PickupItemSlot} from 'meta/worlds';

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

// Chain them in a SequentialBehavior
const sequence = new SequentialBehavior();
sequence.basePriority = 30;
sequence.addStep(pickup);
sequence.addStep(follow);

// Add to actor
const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
actorLogic.addBehavior(sequence);
```

### Example: Patrol loop with fetch

```typescript
const sequence = new SequentialBehavior();
sequence.basePriority = 30;
sequence.loop = true; // Repeat forever

// Step 1: Go to the pickup station
const goToStation = new GotoBehavior();
goToStation.targetPosition = stationPosition;
goToStation.desiredSpeed = 3.0;

// Step 2: Pick up the item
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

### How steps work

1. Only the current step receives `update()` calls and claims controllers
2. When a step sets `isFinished = true`, it is cleaned up via `onRemove()` and the next step is initialized
3. Controller priority is delegated to the current step — the sequence uses its own `basePriority` externally but lets each step claim whatever controllers it needs
4. Steps added after initialization are queued and run after the current step finishes
5. With `loop = true`, all steps reset and replay from step 1 after the last step finishes
