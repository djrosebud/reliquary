---
name: spawning-npc-actors
description: Puts an actor into the scene by reusing a matching template from the registry, or create a new NPC type with the workflow_create_actor skill, then place it, mark it networkable, and seat it on a surface. This is the spawn/placement step, not the behavior-authoring step.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
# This file previously carried no frontmatter and inherited the parent's
# local_tools (see implementing-actor-behaviors.md:12-17). Now that it declares
# its own block, that block governs provisioning and must list every tool this
# body instructs -- inheritance no longer covers the gap.
local_tools:
  - read_local_file
  - write_local_file
consider_skills:
  - adding-navigation
---

# Spawning an NPC

Spawns an actor into the scene. Two paths: a matching template already exists (reuse it from the registry), or you need a new type (activate the `workflow_create_actor` skill, then spawn it).

> **Creating a new NPC/enemy type is ONE call — activate the `workflow_create_actor` skill, then call its `_wfs_` tool next turn.** It deploys the Actor Framework, duplicates `BaseActor`, wires the movement controllers, attaches the requested behaviors (`move_to_target`, `chase_player`, `attack_melee`, `attack_ranged`, `patrol`), builds with the correct build-before-add ordering, and verifies the components — returning `output.template_asset`. Do NOT hand-roll the template build or write a custom movement/AI/spawner script. This skill then owns spawning/placing that returned template and ensuring a NavMesh (below).

> **This skill places ONE instance. For a repeating wave, use `workflow_create_spawner`.** If the request is "every N seconds", "keep spawning", "a wave/horde", or "spawn when the player approaches/leaves", placing instances from here is the wrong shape. Call `switch_skills` with `["implementing-actor-behaviors", "spawning-npc-actors", "workflow_create_spawner"]` — name all three. Activation retains an active skill that declares one you listed, so `implementing-actor-behaviors` would survive on its own, but nothing declares this skill's own sibling relationship to the workflow: listing all three is what keeps this skill loaded alongside it. End that response; on the next turn call `_wfs_workflow_create_spawner` with `output.template_asset`; it wires `ActorSpawner` plus `ActorIntervalTrigger` (cadence) or `ActorProximityTrigger` (distance-gated) on one spawner entity with a max-alive cap. Do NOT write a custom spawner/timer component: on a plain scene entity every context owns its own copy, so a bespoke spawner subscribed with `ExecuteOn.Owner` runs on the server AND each client and a cap of 10 yields 20 live NPCs. `ActorSpawner` goes through `SpawnService`, which gates on `NetworkingService.get().isServerContext()` and holds one global per-group live budget.

> **IMPORTANT**: The `working-with-actor-templates` skill **MUST** also be active when this skill runs. It defines the component requirements and registry rules for all actor templates.

## Trigger Conditions

Activate when the user's message matches:
- "Spawn a NPC" / "Spawn an NPC"
- "Spawn an enemy"
- "Spawn an actor"
- "Add an NPC to the scene"
- "Create a character" (when referring to an NPC, not the player)
- Any variation involving spawning NPCs, enemies, or actors

**Do NOT activate** when the user is working on:
- The player character or player template
- Player movement, player input, player controls
- Anything prefixed with "player" (e.g., "player character", "player controller")

This skill is exclusively for non-player characters. Player templates use different components (`BasePlayerComponent`, `KinematicCharacterComponent`, etc.) and must NOT have `ActorSdkLogicComponent`.

## Prerequisite: Archetype animations for custom-mesh NPCs

If the request creates an NPC with a **custom-generated mesh** (not the BaseActor default mesh as-is) -- e.g. "create a barbarian warrior NPC", "spawn an orc enemy" -- the mesh swap and retarget are owned by `generating-character-mesh` -> the deterministic `workflow_image_character_swap` workflow, not this skill. Defer to it rather than retargeting here: create the type first with `workflow_create_actor` (below) -- that already clones `BaseActor` and wires the Actor Framework stack -- then hand the returned `output.template_asset` to the workflow as the target and leave `mode` at its default of 1. Do NOT pass `mode: 0` with a `destination_template_path` on this path; there is nothing left to clone, and re-cloning produces a second template without the framework wiring. Pair it with `retrieving-character-archetype-animations` for archetype locomotion when that feature is enabled; it falls back to engine-default animations when it is not.

## Step 1: Pick a template (existing) or create one

Look for the registry file at `Templates/Actors/actorTemplatesRegistry.md`.

- **A suitable template already exists** → go to **Spawning From Registry**.
- **No suitable template (or no registry)** → go to **Create a new NPC/enemy type** (activate `workflow_create_actor`), then spawn the returned `template_asset`.

---

## Placing the spawned actor on the ground (shared sub-workflow)

Both spawn paths below place the actor on the surface. **Do not hard-code `Y = 0`** — that only works when the project's floor is at world origin. Elevated, sunken, or non-uniform terrain breaks naive Y=0 placement (NPC ends up buried or floating).

**Do not roll your own raycast + transform write.** Surface-aware placement is owned by the `placing-objects-on-surfaces` skill, which does a collider-filtered raycast and applies the template's AABB-bottom offset automatically — handling the feet-vs-center pivot difference for you. Use it in two phases:

1. **Add the actor template to the scene** as the named wrapper entity the Actor Framework expects, and make the wrapper Networkable. Do not estimate its Y position here.
2. **Snap the wrapper to the surface** using the `placing-objects-on-surfaces` workflow. Snapping is identity-preserving, so it keeps the same entity ID, parent, components, and Networkable state. For a specific location such as "in front of the player" or "left of B", provide the target XZ and let that workflow derive Y from the surface raycast.

**When to skip surface snapping:**

- The user explicitly asks for an aerial / floating / underwater / "in the air" spawn.
- The actor is being attached as a child of an existing entity (a socket, vehicle, mount) — in that case its position is parent-local and surface snapping does not apply.
- The agent is operating in a template editor with no scene loaded — there is no surface to snap to; place the actor and let the world author position it.

---

## Spawning From Registry

1. **Read the registry** at `Templates/Actors/actorTemplatesRegistry.md`
2. **Choose the template:**
   - If the user requested a specific type, find the best match in the registry
   - If the user requested a generic NPC/actor/enemy, use the template marked **DEFAULT**
3. **Spawn the template** into the scene:
   - **Place it on the surface via the "Placing the spawned actor on the ground" sub-workflow above** —
     add the template wrapper, then snap it with the `placing-objects-on-surfaces`
     skill. Do not hard-code `Y = 0`.
   - The wrapper must be Networkable.
4. **Verify actor compatibility** (per `working-with-actor-templates` rules):
   - `TransformPlatformComponent` on root (entity cannot exist in the world without it)
   - `ActorSdkLogicComponent` on root
   - Movement controller on root
   - Spawned entity is set to Networkable
   - If animated: `CharacterAnimationController` on root with `animatorEntity` set to the child entity holding the `AnimatorComponent` and non-zero numeric property values (`speedMultiplier`, `maxSpeedClamp`, `smoothingFrameCount`, `minSpeedThreshold`) — `workflow_create_actor` sets these; see `working-with-actor-templates`
   - If the NPC should move: the template is a simulated character (root `CharacterStateMachine` + `CharacterUpdateManager`, plus the `KinematicCharacter` sub-entity) — this drives locomotion and a kinematic body; it is NOT what makes the animator tick (see the callout below)
   - If the NPC should move with gravity: `ActorTransformMoveComponent` on root with `kinematicCharacterEntity` set to the `KinematicCharacter` sub-entity

---

## Create a new NPC/enemy type

When no existing template matches, create the new type with the **`workflow_create_actor`** skill — activate it, then one `_wfs_` call, no manual multi-step build:

- `name` — PascalCase type name (e.g. `Zombie`, `TowerWizard`).
- `mesh` — optional asset ref; omit to keep the BaseActor default humanoid mesh.
- `behaviors` — any of `move_to_target`, `chase_player`, `attack_melee`, `attack_ranged`, `patrol`.

`workflow_create_actor` deploys the Actor Framework, duplicates `Templates/Actors/BaseActorTemplate/BaseActor.hstf`, renames the root, wires `ActorSdkLogicComponent` + the movement controllers (with the correct non-zero property values), attaches the requested behaviors, builds with the required build-before-add ordering, and verifies the components. It returns `output.template_asset`.

> **Tag targeting is not automatic.** If a behavior chases/attacks a specific
> target (a castle, a flag — anything that is not the player), `workflow_create_actor` sets
> the actor's `targetTags`, but it does NOT tag the target. You MUST add
> `ActorSdkTagComponent` (from `meta/worlds`) with the matching `tags: [...]`
> string to that target entity, or the actor acquires nothing and never moves
> toward it. Players are the only exception — they are auto-tagged `"player"`.
> See "The Tag Targeting Contract" in the parent implementing-actor-behaviors skill.

> **Registry append (2nd+ actor type).** `workflow_create_actor` only creates the registry when absent; it never edits an existing one. Check `output.registry_needs_append` — when `true`, the registry already existed and you MUST append the new row yourself. There is no append primitive: `write_local_file` OVERWRITES, so do a read-modify-write — (1) `read_local_file` on `Templates/Actors/actorTemplatesRegistry.md`, (2) append a row for `output.template_asset` to the returned contents (match the table format; don't mark `DEFAULT` unless it replaces the current default), (3) `write_local_file` the merged text back. Writing a bare row without reading first destroys every existing entry, making prior types invisible to **Spawning From Registry**.

**Do NOT hand-roll the template build or a custom movement / AI / spawner component.** `workflow_create_actor` owns the create path; the component contract every actor template must satisfy lives in the `working-with-actor-templates` skill.

Then spawn/place `output.template_asset` (via the placement sub-workflow above) and ensure a NavMesh (below).

> **Why the simulation stack matters.** `HzAnimSystem` evaluates an `AnimatorComponent` every frame for ANY entity that has one and is active + enabled-in-hierarchy — it does **not** require the entity to be a "simulated character" (verified in `HzAnimSystem.cpp`: the per-frame job loop filters only on the animation driver being present and enabled). So the stack is not what makes the animator tick; what it provides is **locomotion and a kinematic body**, and it ensures the NPC spawns active/enabled (mirroring `PlayerCharacter.hstf`). A "frozen" animator is almost always a clip that isn't retargeted to the rig (look for `Animation loading skipped … not compatible with skeleton …`) or an entity that isn't enabled-in-hierarchy — not a missing character stack. **Preserve the stack when duplicating; never add a second PhysicsBody/collider on the root** (a duplicate root body ejects the character so it spawns invisible or displaced). See `working-with-actor-templates` and `triggering-npc-animations` (Prerequisite #3).

---

## Positioning Rules

- Default: position in front of the user/camera
- Place the actor **on the existing terrain surface, not at world Y = 0**. Delegate surface
  placement to the `placing-objects-on-surfaces` skill (it raycasts the surface and applies
  the AABB-bottom offset); never assume the floor is at world origin
- If the user specifies a position, use that instead

## Ensure a NavMesh (required — do this whenever an NPC is spawned)

Every spawned NPC will eventually move, and movement behaviors pathfind against a baked
NavMesh. **Whenever you spawn an NPC, ensure a baked NavMesh exists in the scene:**

1. Activate the **`adding-navigation`** skill.
2. Follow its Setup: it sizes the NavMesh profile to the NPC capsule, sizes the NavMesh to the world bounds, reuses or creates the profile and area-type assets and attaches them, then bakes (reusing a matching NavMesh entity if one already exists).

Without a baked NavMesh, the NPC silently falls back to straight-line movement and walks
through walls. `GotoBehavior` (used by every movement behavior) auto-discovers the baked
NavMesh, so no per-actor wiring is needed. Skip this only for an actor that will never move,
or when the user explicitly opts out of pathfinding.

## After Spawning

- Verify the spawned entity has `TransformPlatformComponent` on root (required for the entity to have a position in the world)
- Verify the spawned entity has `ActorSdkLogicComponent` on root
- Verify the spawned entity is set to Networkable
- Verify a baked NavMesh exists in the scene (via the `adding-navigation` skill) so the NPC can move and avoid obstacles
- If the template has animations, verify `CharacterAnimationController` is present on root with `animatorEntity` pointing at the child holding the `AnimatorComponent` and that its numeric template properties are non-zero (`speedMultiplier`, `maxSpeedClamp`, `smoothingFrameCount`, `minSpeedThreshold`)
- If the NPC should move, verify it is a simulated character (root `CharacterStateMachine` + `CharacterUpdateManager` with `characterSimulatedEntity` set, and a `KinematicCharacter` sub-entity with the simulation controllers + Kinematic `PhysicsBody` + capsule) — this drives locomotion and the kinematic body. Confirm the NPC plays its idle on its own before wiring any one-shot triggers; if it stands frozen, the usual cause is a clip not retargeted to its skeleton or an entity not enabled-in-hierarchy (see `working-with-actor-templates`), not a missing character stack.
- If a new template was created, verify `Templates/Actors/actorTemplatesRegistry.md` is up to date
