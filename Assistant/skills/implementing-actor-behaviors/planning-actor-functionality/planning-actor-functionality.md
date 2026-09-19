# Planning Actor Functionality

Explicit planning instructions for any **actor / NPC functionality**. The
`planning` agent (and anyone devising a plan that involves a non-player
character) MUST read this before producing a plan, and shape the plan around it.

This document is the authoritative planning guide for the Actor Framework. It
takes precedence over generic gameplay-object planning: a character is an Actor,
never a `creating-gameplay-objects` placeholder.

## When this applies

Use this whenever the request involves a non-player character (NPC) — an enemy,
creature, boss, turret, caster, companion, or any entity that moves, attacks,
animates, perceives, or acts autonomously. (The player is not an NPC.)

## Planning steps

Produce the plan as an ordered list. The steps below are mandatory and must
appear in this order.

### Step 1: Actor Framework (already installed)

The Actor Framework ships with this project at `scripts/Actor/`, checked in
alongside these skills, so it is present whenever they load. No plan needs an
installation step — template, spawning, and behavior work can all be planned
directly.

If `scripts/Actor/` is missing the checkout is broken — stop and report it rather
than planning an install, which would overwrite this world's divergent sources
with the canonical ones.

### Step 2: Choose the actor template

Decide which actor template the NPC will use. **Always read** the
`working-with-actor-templates` sub-skill before creating or editing any actor
template — it defines the required
components, the `Templates/Actors/` location rule, and the registry. Any plan
step that creates or edits an actor template must cite this sub-skill.

Assess the options in this order:

1. **Reuse an existing actor template.** Read the actor templates registry at
   `Templates/Actors/actorTemplatesRegistry.md` and check for an existing,
   proper actor template that fits the request (right archetype / appearance).
   If one fits, plan to reuse it — no new mesh or template work is needed.
2. **Generate a new actor template.** If no suitable actor template exists, plan
   to create one: generate the character mesh and animation setup, then build an
   actor template from it (per `working-with-actor-templates`) and add it to the
   registry. Mesh and animation generation are delegated to the dedicated
   character-mesh and animation skills — include those delegations in the plan.

The chosen (or newly created) template is the actor that the later spawning and
behavior steps operate on.

### Step 3: Select the behaviors and read their sub-skills

Assess what the user wants the actor to **do**, then pick the matching premade
behavior(s) and read their sub-skill docs to plan the work.

The catalog is the **Step 1: CLASSIFY** table in `implementing-actor-behaviors` —
each row is a premade behavior the framework supports, with a description and the
sub-skill doc to read. **General rule:** review the descriptions of all the
premade behaviors, choose the one(s) that realize the goal, and read those
sub-skill doc(s) before planning the behavior steps. An actor can combine several
(see "Sub-skill sequencing" below for composing multiple behaviors).

The plan does not need to be exhaustive here — identify which behavior(s) apply
and cite the sub-skill(s). Examples:

| User wants the actor to... | Read this sub-skill |
|---|---|
| walk / go to a position | `making-actors-go-to-point` |
| follow / chase an entity | `making-actors-follow` |
| patrol waypoints | `making-actors-patrol` |
| wander randomly | `making-actors-wander-idly` |
| attack a target in range | `making-actors-attack-when-in-range` |
| have health / take damage / die | `integrating-actor-health-system`, `making-actors-die` |

These are illustrative — match the request against the full CLASSIFY table, not
just this list.

## Sub-skill sequencing

Plan the Actor Framework sub-skills in this order — each stage depends on the
previous one being in place:

1. **Framework setup** — already done in this project; `scripts/Actor/` is checked
   in, so no setup stage is planned.
2. **Template** — `working-with-actor-templates` (Step 2). Reuse or generate the
   actor template the NPC instances from.
3. **Spawning** — `spawning-npc-actors` for static scene placement, or custom
   runtime spawn logic for dynamic / wave spawning.
4. **Behaviors** — the per-behavior sub-skills selected in Step 3
   (`making-actors-go-to-point`, `making-actors-follow`, `making-actors-patrol`,
   etc.).
5. **NavMesh** — `adding-navigation`. Required before any movement behavior will
   path; bake it once the moving actors exist.
6. **Health / death** — `integrating-actor-health-system`, `making-actors-die`,
   only if the actor takes damage or dies.

**Composing multiple behaviors:** an actor can run several behaviors at once.
Read each selected behavior's sub-skill, add each via `addBehavior`, and rely on
behavior priorities to arbitrate when more than one is active (see
`working-with-actor-behaviors`).

## Pitfalls to plan around

- **Never plan a hand-rolled mover.** Movement is always a behavior
  (`GotoBehavior` and its siblings) driving the actor through its movement
  controller. Do not plan to write `transform.worldPosition` each frame to move
  an actor — reading position to detect arrival is fine.
- **Never substitute `creating-gameplay-objects` for a character.** A character
  is an Actor; plan it through the Actor Framework, not as a generic gameplay
  object or primitive placeholder.
- **A moving NPC needs a NavMesh.** Any plan involving movement must include
  baking one, or the actor will not path.
- **`GotoBehavior` does not signal arrival.** If the plan depends on knowing when
  an actor reaches its destination (e.g. despawn-on-arrival), plan explicit
  distance-based arrival detection.

## Example plans

High-level plans only — no code. Each shows how the steps above apply to a
concrete request.

### Example: spawn waves of zombies that walk across the map and despawn on arrival

> Prompt: "Every 3 seconds spawn a zombie on one side of the map, and make it
> walk to the other side of the map. Despawn the zombie when it reaches its
> destination. Never have more than 20 zombies spawned at the same time."

1. **Actor Framework** — already installed in this project at `scripts/Actor/`;
   nothing to plan for this step.

2. **Choose the zombie actor template** (Step 2). Read `working-with-actor-templates`
   and the registry at `Templates/Actors/actorTemplatesRegistry.md`.
   - If a proper zombie actor template already exists, reuse it.
   - Otherwise, **generate an actual zombie** — produce a zombie character mesh and
     animation setup (delegated to the character-mesh and animation skills), then
     build an Actor-Framework-compatible, movement-capable template from it (start
     from BaseActor: add `ActorSdkLogicComponent` + a movement controller + the
     animated movement controller, then register it). Do not substitute the
     generic DEFAULT humanoid — the request is specifically for a zombie.

3. **Select the behavior** (Step 3). The zombie only needs point-to-point
   movement → read `making-actors-go-to-point` (`GotoBehavior`). It does not
   follow, patrol, or attack, so no other behavior is needed.

4. **Bake a NavMesh.** Movement requires it — activate `adding-navigation` and
   bake so zombies path across the map and around obstacles.

5. **Plan the wave spawner (custom game logic, no sub-skill).** A
   server-authoritative scene component that, on a 3-second interval:
   - checks the current live-zombie count and **skips** the spawn if it is
     already at the cap of 20;
   - otherwise spawns a networked instance of the zombie template at runtime
     (dynamic spawn so the instance can be destroyed later), positioned on the
     ground at the "spawn" side of the map;
   - gives the new zombie a `GotoBehavior` targeting the opposite side (per
     `making-actors-go-to-point`);
   - tracks the live count so the cap stays enforced.

6. **Plan despawn-on-arrival.** `GotoBehavior` does not signal completion (see
   `making-actors-go-to-point`), so plan explicit arrival detection: each zombie
   checks its distance to the destination each frame and, when within a small
   threshold, destroys itself and decrements the live count.

7. **Networking.** Spawning, movement, and despawn are server-authoritative; the
   spawner and behavior logic run on the server-owned side, and spawned zombies
   are networked so every client sees them.

Verification risk: **high** (runtime spawn/despawn lifecycle, a count cap, and
networking).
