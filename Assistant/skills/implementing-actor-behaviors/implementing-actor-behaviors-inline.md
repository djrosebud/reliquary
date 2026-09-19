---
name: implementing-actor-behaviors
description: Implements Actor Framework NPCs and any non-player character — humanoid or non-humanoid, moving or stationary — including enemies, skeletons, zombies, monsters, mobs, goblins, orcs, guards, bosses, creatures, turrets, and casters. Use whenever a character should animate like a living being, attack or cast at targets, interact with world objects, or act autonomously via in-game scripting, even if it never moves (e.g. a stationary wizard that shoots fireballs, a fixed turret, or a casting boss). This is the required path for SPAWNING any enemy or NPC — one-off, in waves or hordes, on respawn, or on a proximity/distance/trigger condition (spawn when the player approaches or moves away) — and for the actor that is spawned; never build such a character from a raw mesh + collider prop. Covers spawning, templates, movement, combat, attention, item use, health, death, and behavior sequencing.
include: as_needed
oncall: horizon_npc_platform
# Load-bearing, do not remove. This file exists only to hold the GK-ON arm:
# without it, SkillHub's -inline twin serves that arm and re-inlines the
# framework-install procedure this fork exists to remove. SkillHub ships the
# name as a gk_enabled/gk_disabled pair; forking both sides makes four files
# toggle one GK, so _resolve_complementary_gk_pairs takes the over-loaded-group
# skip (assembly.py:568) and all four fall through to the per-file gate
# (assembly.py:659). Exactly one project file is then live per arm — this one
# when the GK is ON — and project-first dedup picks it over the SkillHub twin.
gk_enabled: horizon_genai_actor_skill_inline_docs
agents:
  - scripting
  - planning
  - skill_recommending
local_tools:
  # Four supporting documents (planning-actor-functionality, working-with-actor-behaviors,
  # working-with-actor-templates, writing-actor-scripts) have no frontmatter at all and
  # so carry no independent local_tools — they inherit this parent's. The rest DO declare
  # their own; a tool one of those instructs must be granted there as well as here.
  # Provision here every tool any supporting document instructs the agent to call,
  # including the Step 5 VERIFY read tool get_components_on_entity.
  # Used by supporting docs: integrating-actor-health-system calls build_assets after
  # editing a scripts/Actor/ source in place. No supporting doc deploys a file — every
  # framework source is checked in here — so no copy tool is granted.
  - build_assets
---

# Actor Behaviors

The Actor Framework provides autonomous NPC behavior in MHE. An **actor** is any
non-player entity with `ActorSdkLogicComponent` on its root — NPCs, enemies,
creatures, or any entity that acts on its own. Actors use **behaviors** (patrol,
follow, flee, attack) that compete for **controllers** (movement, rotation,
attack) via priority, and share data through **blackboards**.

> ## ✅ First: activate the `workflow_create_actor` skill
>
> To create or spawn ANY non-player NPC / enemy / character, call `switch_skills`
> with `["implementing-actor-behaviors", "workflow_create_actor"]` — name BOTH.
> Activation retains an active skill that declares one you listed, and this skill
> does not declare `workflow_create_actor`, so omitting it here drops it.
> End that response; `_wfs_workflow_create_actor` binds next turn. That ONE call
> deploys the Actor Framework, duplicates `BaseActor`, wires the movement
> controllers, attaches the requested behaviors (`move_to_target`, `chase_player`,
> `attack_melee`, `attack_ranged`, `patrol`), builds with the correct build-before-add ordering, verifies components, returns `output.template_asset`.
>
> Do NOT perform the manual multi-step template build below, and do NOT write a
> custom movement / AI / spawner component, when `workflow_create_actor` is available.
> Fall back to the manual steps only if the skill is unavailable or fails.
>
> Then, for wave or interval spawning, switch again with the full set
> `["implementing-actor-behaviors", "workflow_create_spawner"]` and call
> `_wfs_workflow_create_spawner` next turn (it wires `ActorSpawner` +
> `ActorIntervalTrigger` at the spawn point, pointing at `template_asset`, with the
> cadence and max-alive cap); pass `trigger_type: proximity` for the player-relative
> variant (`ActorProximityTrigger` — spawns while the player is OUTSIDE a
> landmark's safe zone). Bake a NavMesh (`adding-navigation`) for any moving NPC.
> NEVER hand-roll a spawner: every context owns its own copy of a plain
> scene entity, so `ExecuteOn.Owner` runs on server AND each client — `ActorSpawner`
> routes through `SpawnService`, gated on `isServerContext()` with one global budget.

## Claim trigger — read before building any character as a prop

If the request involves a character that is not the player — an **NPC, enemy,
skeleton, zombie, monster, mob, goblin, orc, guard, boss, creature, turret, or
caster** — or asks to **spawn** any such character (one-off, in waves/hordes, on
respawn, or on a proximity/distance/trigger condition, e.g. "spawn a skeleton
when the player is far from the tent"), this skill MUST be in the plan and the
character MUST be built as an Actor. Do NOT route it to `creating-gameplay-objects`,
`generating-3d-meshes`, or a hand-assembled mesh + collider prop just because the
request says "spawn" or "object" or names a marketplace asset — a thing that
animates, attacks, or acts on its own is an Actor, not a gameplay-object prop.
This claim holds even when `skill_recommending` or a `planning` agent routes the
spawn to a generic object/scene skill; the character clause above is the authority.

## When to use this skill (read this first)

This skill is for **building any character that is not the player** — humanoid or
non-humanoid, **whether or not it moves**. Movement is only ONE reason to use it.
Do not skip this skill just because the character is stationary.

Ask these questions about the requested character. If the answer to **any** is
yes, this skill applies and the character must be built as an Actor:

| Indicator | If yes → |
|-----------|----------|
| Should it **animate like a living being** (idle, attack, cast, hit, react)? | **Definitely an Actor.** |
| Should it **attack, shoot, cast, fire, or harm** the player or other entities? | **Almost certainly an Actor.** |
| Should it **interact with or manipulate objects** in the world (pick up, use, open, activate, deliver)? | **Almost certainly an Actor.** |
| Should it **act autonomously via in-game scripting/AI** (target, aim, decide, trigger on conditions)? | **Definitely an Actor.** |
| Does it **move around** the world (walk, patrol, follow, flee, chase)? | **Definitely an Actor.** |
| Are you about to **create or spawn** it (one-off, in waves/hordes, or on a trigger)? | **Activate the `workflow_create_actor` skill** (see above), then call its `_wfs_` tool — not a manual multi-step build or a hand-rolled movement/AI/spawner script. |

**Stationary characters still belong here.** A stationary wizard that shoots
fireballs at the player, a fixed turret that tracks and fires, a rooted boss
that casts spells, or a statue that wakes and attacks are ALL Actors — they
animate, attack, target, and act autonomously even though their position never
changes. Build them with `ActorSdkLogicComponent` + the relevant attack/attention
behaviors; a stationary actor simply omits the movement controller and skips the
NavMesh step (Step 4). **Never** hand-roll a custom enemy/character component or
a per-frame attack/aim/animation loop as a substitute for this framework.

> Any time an NPC is given **any movement behavior** (follow, chase, patrol,
> wander, flee, lead, engage in combat), a **baked NavMesh must exist in the scene**.
> A spawned-but-stationary actor (e.g. a fixed turret) does not need one.
> Movement behaviors route through `GotoBehavior`, which auto-discovers a baked NavMesh; without one,
> NPCs silently fall back to straight-line movement and walk through walls. Ensure the NavMesh
> by activating the **`adding-navigation`** skill (size to NPC → attach profile + area-type assets → bake)
> as part of the workflow — see Step 4 below.

> ## 🚫 Do NOT hand-roll movement
>
> If you are about to write a per-frame `transform.worldPosition` / `setPosition`
> update, a custom `NPCWalkerComponent`, or a manual `lerp`/`translate` loop to
> move an NPC, enemy, creature, or any self-moving entity — **stop**.
> That is the wrong pattern. Spawn an actor with `ActorSdkLogicComponent` plus a
> movement controller and add the relevant behavior (e.g. `GotoBehavior` to walk
> to a point). Manual transform movement bypasses pathfinding, animation, and
> networking, and breaks at runtime. Any "move/walk/go to" request is an Actor
> Framework task — route it through this skill, never a bespoke mover component.

> ## 🚫 Do NOT hand-roll a projectile
>
> If you are about to write a custom projectile component — a script that drives
> a `PhysicsBodyComponent.linearVelocity` and detects hits with
> `OnCollisionEnterEvent` to make an NPC shoot, cast, throw, or fire — **stop**.
> That is the wrong pattern, the ranged-attack mirror of hand-rolling movement.
> A melee and a ranged attacker use the SAME component: `ActorAnimatedAttackComponent`,
> with `deliveryMode` `0` or `1`. In projectile mode the template it spawns
> **MUST** carry a component implementing
> `IActorProjectile`. The controller already pools, aims, leads, and fires those
> projectiles. Any "shoots/casts/fires/throws at a target" request is an Actor
> Framework task — see `{{#CONTEXT_PATH}}/making-actors-engage-in-combat/making-actors-engage-in-combat.md`,
> never a bespoke projectile component.

> ## 🚫 Do NOT assemble an actor from primitive meshes
>
> If you are about to build an NPC by hand from primitives — `create_entity` a
> box / cylinder / sphere, `add_component` a mesh + collider, and wire that up as
> your "enemy" or "character" — **stop**. That produces a placeholder with **no
> animator and no character simulation stack**, so it cannot animate or locomote
> correctly, and it fails the Actor Contract below. The one supported way to
> create an actor template is the **`workflow_create_actor`** skill — activate it
> (via `switch_skills`), end the turn, then next turn its one `_wfs_workflow_create_actor` call
> duplicates `BaseActor` (mesh + AnimGraph/animator + character simulation stack)
> and wires the Actor Framework components on its root (see
> `{{#CONTEXT_PATH}}/spawning-npc-actors/spawning-npc-actors.md`, and the
> **working-with-actor-templates** foundation doc inlined above).
> Never hand-assemble an actor from primitives.

> ## 🚫 Do NOT create a moving enemy with `template_enemy` / `template_gameplay_object`
>
> For an enemy or NPC that **moves or navigates** (walks toward a target, chases,
> patrols, routes around an obstacle), do **NOT** build it with `template_enemy`,
> `template_gameplay_object`, or `create_from_primitives`. Those tools produce a
> mesh + collider + physics entity (and, for `template_enemy`, a `BaseEnemy`
> health/hit-flash entity) with **no `ActorSdkLogicComponent`** — it is not an
> Actor Framework NPC, so it cannot run `GotoBehavior` / NavMesh pathfinding. It
> walks straight *through* walls instead of around them, fails the Actor Contract
> below, and actor-aware verification does not recognize it as an NPC ("no NPC
> actor template found"). A moving/navigating enemy IS an **Actor** — create it
> with the **`workflow_create_actor`** skill — activate it (via `switch_skills`), then call
> `_wfs_workflow_create_actor` next turn (see
> `{{#CONTEXT_PATH}}/spawning-npc-actors/spawning-npc-actors.md`), which wires
> `ActorSdkLogicComponent` + `ActorTransformMoveComponent` and attaches the
> requested movement behavior (`move_to_target`, `chase_player`, `patrol`).
> `template_enemy` is acceptable ONLY for a **stationary, non-navigating** enemy —
> it adds health / hit-flash but no Actor Framework locomotion.

---

## The Actor Contract — Definition of Done

**Read this before you start, and verify it before you finish.** Every actor you
build or spawn MUST end up satisfying **all** of the items below. This is the
single authoritative contract: it holds no matter which supporting instructions you use,
and it takes precedence if any supporting-document checklist has drifted from it. If any
item is unmet, the task is **not done** — go back and fix it before finishing
(see **Step 5: VERIFY**).

1. The actor template is a **duplicate of `BaseActor`** — never hand-assembled
   from primitive meshes. BaseActor ships the mesh, animator, and character
   simulation stack.
2. The **root entity** has `TransformPlatformComponent`.
3. The **root entity** has **`ActorSdkLogicComponent`** — the Actor's brain.
   Without it the entity is not an actor and no behavior, controller, or
   blackboard runs. This is the single most-dropped step; do not skip it.
4. The **root entity** has the **movement controller**
   **`ActorTransformMoveComponent`** — unless the actor is intentionally
   stationary (e.g. a fixed turret), in which case omit it. This is the *only*
   movement controller; `ActorPhysicsComponent` is **not** one — it implements
   `ActorCollisionController` and merely toggles collision/gravity, so it can
   never make an actor locomote and cannot substitute here.
5. If the template has an animator (BaseActor does), the **root entity** has
   **`CharacterAnimationController`** with `animatorEntity` pointing at the
   child that holds the animator. This is independent of item 4: it is the
   locomotion-animation driver and is required whenever the template has an
   animator, even for a stationary actor that omits the movement controller. The
   animator is the `AnimatorComponent` TS wrapper, which the **saved template
   serializes as `AnimatorPlatformComponent`** — so when you inspect the saved
   template (Step 5) look for `AnimatorPlatformComponent`, not `AnimatorComponent`.
   BaseActor's character simulation stack (the `CharacterStateMachine` +
   `CharacterUpdateManager` on the root and the `KinematicCharacter` sub-entity —
   enumerated in `working-with-actor-templates`) must be **preserved**, not
   stripped.
6. The template is saved in **`Templates/Actors/`** and recorded in
   **`Templates/Actors/actorTemplatesRegistry.md`**.
7. **When spawning an instance** into a scene (not merely authoring the
   template), the spawned entity must be marked **Networkable**.
   This is a spawn-instance step, not a template
   property; skip it only when authoring a template with no spawn in this task.

The **working-with-actor-templates** foundation doc (inlined above) is the
authoritative source for the exact components and the pre-save checklist.

---

## The Tag Targeting Contract — pair the producer and the consumer

Tag targeting has two ends; wire both or the actor silently acquires nothing.
**Consumer:** tag behaviors take an **array** — `targetTags = ["castle"]`, `["player"]`;
only `ActorCombatStarterComponent.targetTags` is a comma-separated **string**
(`"castle"`). A bare string on an array field iterates its characters and resolves
nothing. **Producer:** players are auto-tagged `"player"`; anything else needs
`ActorSdkTagComponent` (`meta/worlds`) with a case-sensitive `tags: ["castle"]`.

---

## Writing actor scripts: imports and entity references

When you write ANY actor script (behavior, starter component, or runtime
spawner), two mistakes cause **silent runtime failure** — the world runs but the
actor logic never executes and nothing surfaces an error. Full rules and failure
signatures: `{{#CONTEXT_PATH}}/writing-actor-scripts/writing-actor-scripts.md`.
In brief:

- **Imports.** SDK built-ins (`ActorSdkLogicComponent`, `Component`, `Service`,
  `Vec3`, `Entity`, event types, …) import from **`'meta/worlds'`**; only files
  checked in under `scripts/Actor/…` import by relative path. Never import
  `ActorSdkLogicComponent` from a local `scripts/Actor/...` path — ingestion
  fails and the whole script (and its component) silently never loads.
- **Entity references.** Wire an `@property() Entity` (e.g. a spawner's
  `tentEntity`) to the **placed instance's** id, never a template or guessed id;
  prefer resolving at runtime by tag/name; and VERIFY it resolves — a dangling
  reference silently disables everything downstream (a spawner that can never
  read the tent never spawns).

---

## Foundation docs — always loaded

The three docs that apply to **every** actor task are inlined here, so their full
content is in context for **every** agent (`planning`, `scripting`, `task`) before
any actor work begins — there is nothing to open. (The per-behavior docs in the
Step 1 table below are different: those load on demand, only when the request
needs them.)

- **planning-actor-functionality** — how to structure the plan and sequence the work.
- **working-with-actor-behaviors** — behavior lifecycle, service access, and the anti-patterns that apply to every behavior.
- **working-with-actor-templates** — the Actor Contract components and the pre-save checklist.

{{#PROJECT_MD, ./planning-actor-functionality/planning-actor-functionality.md}}

{{#PROJECT_MD, ./working-with-actor-behaviors/working-with-actor-behaviors.md}}

{{#PROJECT_MD, ./working-with-actor-templates/working-with-actor-templates.md}}

---

## Step 0: Framework is already installed

The Actor Framework ships with this project — `scripts/Actor/` is checked in
alongside these skills, so it is present whenever they load. Proceed to Step 1.

If `scripts/Actor/` is somehow missing, the checkout is broken. **Stop and report
it.** Do not install the framework from templates: that would write the canonical
sources over this world's own divergent copies, which is what this project exists
to iterate on.

---

## Step 1: CLASSIFY — What Does the User Want?

| User Intent | Use This Supporting Instruction |
|-------------|---------------------|
| Create a new NPC/enemy **type** (one call — `workflow_create_actor`), or add an existing actor template to the scene, mark it networkable, and place it on a surface | `{{#CONTEXT_PATH}}/spawning-npc-actors/spawning-npc-actors.md` |
| Make an NPC **walk / move / go to** a position or point (point-to-point movement) | `{{#CONTEXT_PATH}}/making-actors-go-to-point/making-actors-go-to-point.md` — use `GotoBehavior` (do NOT write a manual mover) |
| Make an NPC **wander** randomly | `{{#CONTEXT_PATH}}/making-actors-wander-idly/making-actors-wander-idly.md` |
| Make an NPC **patrol** waypoints | `{{#CONTEXT_PATH}}/making-actors-patrol/making-actors-patrol.md` |
| Make an NPC **follow** / chase an entity | `{{#CONTEXT_PATH}}/making-actors-follow/making-actors-follow.md` |
| Make an NPC **flee** / run away | `{{#CONTEXT_PATH}}/making-actors-flee/making-actors-flee.md` |
| Make an NPC **lead** / guide the player | `{{#CONTEXT_PATH}}/making-actors-lead/making-actors-lead.md` |
| Make an NPC **look at** / pay attention to the player | `{{#CONTEXT_PATH}}/configuring-actor-attention/configuring-actor-attention.md` |
| Make an NPC **search for and pick up** tagged items | `{{#CONTEXT_PATH}}/making-actors-search-and-pickup/making-actors-search-and-pickup.md` |
| Make an NPC **deliver** / carry an item to a location | `{{#CONTEXT_PATH}}/making-actors-deliver-to-tag/making-actors-deliver-to-tag.md` |
| Make an NPC **fetch** (pick up + deliver) | `{{#CONTEXT_PATH}}/making-actors-fetch/making-actors-fetch.md` |
| Make an actor **use a held item** on an object (key→door, potion→ally) | `{{#CONTEXT_PATH}}/making-actors-use-items/making-actors-use-items.md` |
| Make an NPC **attack** when a target is in range | `{{#CONTEXT_PATH}}/making-actors-attack-when-in-range/making-actors-attack-when-in-range.md` |
| Make an NPC **chase and attack** (full combat engagement) | `{{#CONTEXT_PATH}}/making-actors-engage-in-combat/making-actors-engage-in-combat.md` |
| Add **melee combat** to an NPC | `{{#CONTEXT_PATH}}/implementing-actor-combat/implementing-actor-combat.md` |
| Handle NPC **death** / despawn on death | `{{#CONTEXT_PATH}}/making-actors-die/making-actors-die.md` |
| Add **health**, **HP**, or **damage** to an NPC / enemy / actor (any health-related request — simple or advanced) | `{{#CONTEXT_PATH}}/integrating-actor-health-system/integrating-actor-health-system.md` |
| Configure **combat target tracking** / faction targeting | `{{#CONTEXT_PATH}}/configuring-actor-combat-blackboard/configuring-actor-combat-blackboard.md` |
| **Chain, sequence, alternate, or cycle** multiple behaviors, including timed phases | `{{#CONTEXT_PATH}}/sequencing-actor-behaviors/sequencing-actor-behaviors.md` |

---

## Step 2: COMPOSE — Multi-Behavior Requests

If the request involves a single behavior, skip to Step 3. For multi-behavior
NPCs, choose the right composition pattern:

### Priority-based (default + interrupt)

Use when: "follow the player, but pick up nearby items" / "patrol, but chase
intruders" — any **default behavior that gets interrupted by a condition**.

Add all behaviors at startup with different priorities. The default gets a low
priority; reactive behaviors get higher priorities and stay dormant (return `-1`
for controllers) until their activation condition is met. When the condition
triggers, the higher-priority behavior takes over automatically. When it
finishes, the default resumes.

| Role | Priority | Example |
|------|----------|---------|
| Default (always active) | 10 | follow, wander-idly, patrol |
| Reactive (conditional) | 20+ | search-and-pickup, engage-in-combat, flee |

See the **working-with-actor-behaviors** foundation doc (inlined above) for the
full priority-based activation pattern with code examples.

### SequentialBehavior (ordered steps)

Use when: "go to A, pick up B, deliver to C" — **strictly ordered steps with
no persistent default to return to**.

Each step runs until `isFinished = true`, then the next step starts. Set
`loop = true` for repeating sequences.

Use the inlined `sequencing-actor-behaviors` instructions for step configuration
and compatible behaviors.

### CompositeBehavior (concurrent sub-behaviors)

Use when: sub-behaviors must run **simultaneously** and share data (e.g.,
targeting + following at the same time). This is used internally by
`EngageCombatBehavior` and `FollowTaggedEntityBehavior`.

### Item Use Pattern (pickup → use on target)

Use when: "pick up key and use it on the door" / "bring potion to ally and
use it" — **actor must hold an item and apply it to a target entity**.

Chain `SearchAndPickupBehavior` → `UseItemBehavior` in a `SequentialBehavior`.
`UseItemBehavior` walks to the target, then invokes an `onUseItem` callback
when in range. The callback implements the game-specific logic.

```typescript
const pickup = new SearchAndPickupBehavior();
pickup.targetTags = ['key'];
pickup.pickupRange = 2.0;

const useItem = new UseItemBehavior();
useItem.targetEntity = doorEntity;
useItem.useRange = 2.0;
useItem.destroyItemAfterUse = true;
useItem.onUseItem = (actor, target, item, slot) => {
  // Game-specific: open the door
  const doorScript = target.getComponent(DoorController);
  if (doorScript) { doorScript.open(); }
};

const sequence = new SequentialBehavior();
sequence.basePriority = 30;
sequence.addStep(pickup);
sequence.addStep(useItem);
actorLogic.addBehavior(sequence);
```

### Decision rule

| User says | Pattern | Why |
|-----------|---------|-----|
| "while doing X, if Y happens, do Z" | Priority-based | Conditional interrupt |
| "do X, then Y, then Z" | SequentialBehavior | Ordered steps |
| "do X and Y at the same time" | CompositeBehavior | Concurrent |
| "pick up X and use it on Y" | Sequential: pickup → UseItemBehavior | Item use |

---

## Common Archetypes

These show which supporting instructions to combine for typical NPC types. **Every archetype below
moves, so each one also requires a baked NavMesh — run the `adding-navigation` skill
(Step 4) when building any of them.**

**Guard** — patrols an area, chases and attacks intruders, dies when killed
- `making-actors-patrol` (priority 10, default)
- `making-actors-engage-in-combat` (priority 20, reactive via `detectionRange`)
- `making-actors-die` (priority 100, monitors health controller)

**Shopkeeper / Ambient NPC** — wanders idle, looks at nearby players
- `making-actors-wander-idly` (priority 10, default)
- `configuring-actor-attention` (concurrent via attention starter component)

**Companion** — follows the player, picks up nearby items reactively
- `making-actors-follow` (priority 10, default)
- `making-actors-search-and-pickup` (priority 20, reactive via `detectionRange`)

**Fetch Worker** — picks up items and delivers them in a loop
- `sequencing-actor-behaviors` with `loop = true`
- Steps: `making-actors-search-and-pickup` → `making-actors-deliver-to-tag`

**Guide NPC** — leads the player to a destination
- `making-actors-lead` (single behavior, no composition needed)

**Combat Enemy** — chases and attacks the player, drops loot when killed
- `implementing-actor-combat` (wires engage-combat internally)
- `making-actors-die` (priority 100, `dropItemsOnDeath = true` for loot drops)
- `configuring-actor-combat-blackboard` (if faction targeting needed)

**Key Bearer** — picks up a key and uses it on a door/chest
- `SequentialBehavior`: `making-actors-search-and-pickup`(key) → `UseItemBehavior`(door)
- `onUseItem` callback implements the unlock/open logic
- `destroyItemAfterUse = true` to consume the key

## See Also (Related Non-Actor Skills)

- `creating-collectibles` — Player-side collectible items (coins, gems). Use alongside Actor pickup behaviors for NPC-collectible interactions.
- `creating-attachable-objects` — Player-side grabbable/attachable objects. The Actor Framework's `ActorPickupItemComponent` handles NPC-side pickup; this skill covers the player-side equivalent.

---

## Step 3: READ AND APPLY — Use Matched Supporting Instructions

The supporting instructions routed in Steps 0-2 are plain Markdown documents,
not independently activatable skills. In this GK variant their content is already
inlined at the end of this parent skill. Apply only the documents whose routes
match the request; do not put their names in `switch_skills` or read their files
again. The `{{#CONTEXT_PATH}}` paths in the Step 1 table are routing identifiers
under this variant, not read targets — match on them, then use the inlined body.
The
service-access, initialization-order, and lifecycle rules that
apply to all behaviors are in the **working-with-actor-behaviors** foundation doc,
already inlined above — apply them to every behavior you touch.

---

## Step 4: ENSURE NAVMESH — Required for Any Moving NPC

If the work adds **any** movement behavior (follow, chase, patrol,
wander, flee, lead, deliver, fetch, search-and-pickup, engage-in-combat, or anything
that uses `GotoBehavior`), a baked NavMesh **must** exist in the scene. This is not
optional — without it, NPCs walk through walls and ignore obstacles.

1. Activate the **`adding-navigation`** skill.
2. Follow its Setup: it sizes the profile to the NPC capsule, sizes the NavMesh to the world bounds, reuses or creates and attaches the profile and area-type assets, then bakes (reusing a matching NavMesh entity if one exists). Rebake after geometry changes.

`GotoBehavior` auto-discovers the baked NavMesh — no per-actor wiring is needed.
Skip this step only for actors that never move (e.g. a stationary turret) or when the
user explicitly opts out of pathfinding.

---

## Step 5: VERIFY — The Actor Contract Is Met (do not skip)

Before declaring the task complete, re-check **The Actor Contract** (above)
against what you actually built. **Inspect the saved root and animated-child
component state** — do not rely on your memory of the steps you intended to run; a
step you meant to do is not the same as a component that is actually on the
saved root entity.

- [ ] The template was created by **duplicating `BaseActor`** (not hand-assembled from primitives).
- [ ] Root entity has `TransformPlatformComponent`.
- [ ] Root entity has **`ActorSdkLogicComponent`**.
- [ ] Root entity has the movement controller **`ActorTransformMoveComponent`** (unless intentionally stationary). `ActorPhysicsComponent` does not count — it is a collision controller.
- [ ] If the template has an animator: root has **`CharacterAnimationController`**
      (`animatorEntity` set) and BaseActor's simulation stack is intact. Resolve the animated child from that field rather than guessing an ID. On the child, the animator serializes as **`AnimatorPlatformComponent`** (the saved-template name for the `AnimatorComponent` wrapper).
- [ ] Template is in `Templates/Actors/` and listed in `actorTemplatesRegistry.md`.
- [ ] If you spawned an instance into the scene: the spawned entity is **Networkable**.

**Enumerate every Contract row against the read output — do not rely on
recollection.** For each checklist row above, find the named component in the
saved state; if that row's component is absent from the
output, the row is unchecked regardless of what you intended to do (reality over
intent).

**A read that does not clearly confirm a component is a FAILED check, never a
pass. The three failure modes have different causes and different remedies —
handle each by its cause:**

- **Read error:** a failure to inspect the state is not a saved-state verdict.
  Confirm the exact file and entity identity, then retry. Derive the animated
  child from `CharacterAnimationController.animatorEntity`, never a guess.
- **Empty result:** an empty read is a symptom,
  not a single cause — it can mean a wrong/fabricated id, an id that was valid but
  is no longer live, OR a correct id whose Contract component was never saved. Do
  NOT assume the id is fake. First confirm the id without guessing: for the
  animated child, re-derive it from the root's
  `CharacterAnimationController.animatorEntity` field; for the root, use the
  serialized ID rather than a remembered or invented one. Re-read with the
  confirmed id. If the read is still empty on a confirmed id, treat it as a
  **Missing component** (below) — the save did not persist — not as a bad id.
- **Missing component** (the read succeeds but a Contract row's component is
  absent): the save skipped that step. Re-run the save step for that specific
  component, then re-verify.

If any box is unchecked, the actor is **incomplete** — go back to the relevant
supporting instruction and fix it before finishing. A missing `ActorSdkLogicComponent`, or a
primitive-mesh placeholder in place of a BaseActor duplicate, means the Actor
Framework is effectively **unused** — that is a failure of this task even if
something spawned into the scene.

---

# §§ ACTOR FRAMEWORK KNOWLEDGE (inline)

This is the **all-inline** variant of `implementing-actor-behaviors`, live only
when the GK `horizon_genai_actor_skill_inline_docs` is ON. Every supporting doc
is inlined so its full content is in context with no on-demand read. The three
foundation docs are already inlined above ("Foundation docs — always loaded");
the remaining per-behavior docs are inlined below. The Step 1 CLASSIFY table
still maps each intent to its doc — under this variant that content is already
present here, so follow it inline rather than reading it.

## § Foundation & Setup

{{#PROJECT_MD, ./spawning-npc-actors/spawning-npc-actors.md}}

## § Movement

{{#PROJECT_MD, ./making-actors-go-to-point/making-actors-go-to-point.md}}

{{#PROJECT_MD, ./making-actors-wander-idly/making-actors-wander-idly.md}}

{{#PROJECT_MD, ./making-actors-patrol/making-actors-patrol.md}}

{{#PROJECT_MD, ./making-actors-follow/making-actors-follow.md}}

{{#PROJECT_MD, ./making-actors-flee/making-actors-flee.md}}

{{#PROJECT_MD, ./making-actors-lead/making-actors-lead.md}}

## § Interaction & Attention

{{#PROJECT_MD, ./configuring-actor-attention/configuring-actor-attention.md}}

{{#PROJECT_MD, ./making-actors-search-and-pickup/making-actors-search-and-pickup.md}}

{{#PROJECT_MD, ./making-actors-deliver-to-tag/making-actors-deliver-to-tag.md}}

{{#PROJECT_MD, ./making-actors-fetch/making-actors-fetch.md}}

{{#PROJECT_MD, ./making-actors-use-items/making-actors-use-items.md}}

## § Combat, Health & Death

{{#PROJECT_MD, ./making-actors-attack-when-in-range/making-actors-attack-when-in-range.md}}

{{#PROJECT_MD, ./making-actors-engage-in-combat/making-actors-engage-in-combat.md}}

{{#PROJECT_MD, ./implementing-actor-combat/implementing-actor-combat.md}}

{{#PROJECT_MD, ./integrating-actor-health-system/integrating-actor-health-system.md}}

{{#PROJECT_MD, ./making-actors-die/making-actors-die.md}}

{{#PROJECT_MD, ./configuring-actor-combat-blackboard/configuring-actor-combat-blackboard.md}}

## § Composition

{{#PROJECT_MD, ./sequencing-actor-behaviors/sequencing-actor-behaviors.md}}
