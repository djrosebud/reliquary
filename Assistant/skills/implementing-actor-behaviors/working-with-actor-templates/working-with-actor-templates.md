# Actor Working With Templates

Rules for creating and managing templates compatible with the Actor Framework. All actor templates require specific components to function with the behavior system.

## Template Location

All actor templates **MUST** be stored in `Templates/Actors/`. No exceptions.

When editing an existing template that is NOT in `Templates/Actors/`, copy it there first, then edit.

## Actor Templates Registry

**Location:** `Templates/Actors/actorTemplatesRegistry.md`

This file tracks all actor templates with their descriptions and status. It determines which template to use when spawning actors.

**Format:**

```markdown
# Actor Templates Registry

| Template Name | File Path | Description | Status |
|---------------|-----------|-------------|--------|
| Actor_Humanoid | `Templates/Actors/Actor_Humanoid.hstf` | Humanoid NPC with mesh, materials, and animation graph | **DEFAULT** |
```

- **DEFAULT** template is used when no specific template is requested
- When creating new actor templates, add them to this registry
- When updating existing templates, update their description here

### Registry Rules

1. **Read before spawning** — Always read `Templates/Actors/actorTemplatesRegistry.md` before spawning
2. **Update on create** — Add a row when creating a new template (name, path, description, status)
3. **Update on modify** — Update the description when modifying an existing template
4. **One DEFAULT** — Only one template should be marked **DEFAULT** at a time

## Required Components

### Every Actor Template MUST Have:

1. **TransformPlatformComponent** on the root entity
   - This is **mandatory** for any entity spawned into the world — without it, the entity has no position, rotation, or scale and will not appear in the scene
   - This is a platform component (not a script), so it must exist in the template's root entity definition

2. **ActorSdkLogicComponent** on the root entity
   - This is the Actor's brain — without it, no behaviors, controllers, or blackboards function
   - Component: `ActorSdkLogicComponent` (provided by `meta/worlds`)

3. **The movement controller `ActorTransformMoveComponent`** on the root entity
   - `ActorTransformMoveComponent` — the Actor's movement controller (implements
     `ActorMovementController`); transform-based locomotion driven through the
     `KinematicCharacter` sub-entity. This is the component that makes an actor move.
   - `ActorPhysicsComponent` is **not** a movement controller — it implements
     `ActorCollisionController` and only toggles the actor's collision and gravity.
     Add it *alongside* `ActorTransformMoveComponent` if you need runtime
     collision/gravity toggling; it can never replace the movement controller.
   - Import from: `scripts/Actor/Controllers/Implementations/`

### Animated Actors MUST Also Have:

4. **CharacterAnimationController** on the root entity — required if ANY of these are true:
   - The template has an `AnimatorComponent` (on root or any child entity)
   - The template has animation clips or an animation graph
   - The NPC is expected to move and animate (follow, patrol, chase, wander)

   This component drives the animator from observed motion. On an entity with no
   `MovementAbility` (i.e. an NPC) it derives the locomotion blend from the transform
   delta, smoothed and clamped, and posts:
   `Speed`, `MovementDirectionYaw`, `IsGrounded`, `IsRecentlyGrounded`, `IsJumping`,
   `ShouldStrafe`, plus the airborne layer's `Jumping` / `TimeTillLand`.

   It also owns the action layers — `playAttack()`, `playRangedAttack()`,
   `playTakeDamage()` and `setDead()` — which is how `ActorAnimatedAttackComponent`
   and `ActorGASHealthComponent` play their animations.

   Import: `scripts/controllers/CharacterAnimationController`

   **If the AnimatorComponent is on a child entity** (e.g., a `Visuals` child), set the `animatorEntity` property to point to that child.

### Animated Actors Should Also Be Simulated Characters:

5. **The character simulation stack** — strongly recommended whenever the template has an `AnimatorComponent` and the NPC is expected to move.

   `HzAnimSystem` evaluates an `AnimatorComponent` every frame for ANY entity that carries one and is active + enabled-in-hierarchy — it does **NOT** gate evaluation on the entity being a "simulated character" (verified in `HzAnimSystem.cpp`: the per-frame job loop filters only on the animation driver being present and enabled, with no character / `CharacterSimulationController` check). So the simulation stack is **not** a precondition for the animgraph to tick. What it actually buys an NPC is locomotion and a proper kinematic body, it guarantees the entity spawns active/enabled, and it mirrors `PlayerCharacter.hstf` (the known-good reference).

   If an animator looks "frozen" (one fixed pose; `requestTransition` / `setGraphVariable` appear to no-op), the cause is almost always one of these — NOT a missing character stack:
   - **The clip is not retargeted to the entity's skeleton.** An incompatible clip is silently skipped at load (look for `Animation loading skipped … not compatible with skeleton …` in the logs) and the graph evaluates to the rest pose every frame. Retarget the clip to the actual rig (see `retargeting-animations`).
   - **The entity (or the child holding the animator) is not enabled-in-hierarchy**, so the animator never enters the per-frame loop. Confirm the entity spawns active and enabled.
   - **The transition you fire doesn't exist, or its conditions don't hold** — `requestTransition` no-ops. Inspect the graph first (see `triggering-npc-animations`).

   To build the simulation stack (recommended for any NPC that moves), mirror `PlayerCharacter.hstf`:

   On the **root** entity:
   - `CharacterStateMachine`
   - `CharacterUpdateManager` — set its `characterSimulatedEntity` property to the `KinematicCharacter` sub-entity below

   As a **child sub-entity** of the root (conventionally named `KinematicCharacter`):
   - `CharacterSimulationController` (enabled)
   - `KinematicForceController`
   - `KinematicCharacterPlatformComponent`
   - `PhysicsBodyPlatformComponent` with `driveMode: Kinematic`, no gravity, locked rotation
   - `WorldsGroundInfoComponent`
   - a child entity holding the capsule collider (`ColliderCapsulePlatformComponent`)

   **Do NOT also place a `PhysicsBodyPlatformComponent` or collider on the root entity.** A duplicate body on the root ejects the character at spawn — it appears invisible or displaced. The kinematic body and capsule live only on the `KinematicCharacter` sub-entity.

   The shipped `BaseActor` template already includes this stack, so when you create a template by duplicating it (see `spawning-npc-actors`), **preserve these components** — do not strip them. Only build the stack by hand when starting from a template that lacks it.

## Root Entity Naming

When creating a template by copying from another template (e.g., copying PlayerCharacter to create an NPC), the root entity **MUST** be renamed to match the new template's purpose. Do NOT keep the source template's name.

- **Rename the root entity** to match the template filename (e.g., `Actor_Humanoid` for `Actor_Humanoid.hstf`)
- Child entities (`Visuals`, `Collider`) can keep their names — they are generic

**Example:** Copying `PlayerCharacter.hstf` to `Actor_Humanoid.hstf`:
- Root entity name: `PlayerCharacter` → rename to `Actor_Humanoid`

## Validation Before Save

Before saving any actor template, verify:
- [ ] `TransformPlatformComponent` is on the root entity (required for the entity to exist in the world)
- [ ] Root entity is named to match the template (not carrying over a source template name like `PlayerCharacter`)
- [ ] `ActorSdkLogicComponent` is on the root entity
- [ ] A movement controller is on the root entity
- [ ] If `AnimatorComponent` exists anywhere in the hierarchy, `CharacterAnimationController` is on the root entity with `animatorEntity` pointing to the correct child
- [ ] If the NPC should move and has an `AnimatorComponent`, the template is a simulated character: root has `CharacterStateMachine` + `CharacterUpdateManager` (`characterSimulatedEntity` set), a `KinematicCharacter` sub-entity carries `CharacterSimulationController` + `KinematicForceController` + `KinematicCharacterPlatformComponent` + a Kinematic `PhysicsBody` + `WorldsGroundInfoComponent` + a capsule collider, and the root has NO PhysicsBody or collider of its own
- [ ] Template is saved in `Templates/Actors/`
- [ ] `Templates/Actors/actorTemplatesRegistry.md` is updated
