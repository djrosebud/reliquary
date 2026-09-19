---
name: making-actors-engage-in-combat
description: Gives an NPC full combat engagement with EngageCombatBehavior, a composite that acquires a target from the tagging blackboard, chases it, and attacks. Use when the enemy should both pursue and fight, rather than only attacking what comes into range.
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
  - integrating-actor-health-system
  - name: configuring-actor-combat-blackboard
    when: combat targets come from an external detection or threat system, or factions must be distinguished
  - name: triggering-npc-animations
    when: attack, stagger, or death should play specific animation clips rather than the template defaults
---

# Adding Combat Engagement to an NPC

`EngageCombatBehavior` is a composite behavior that combines target acquisition, following, and attacking into a single behavior. It internally wires two sub-behaviors:

1. **FollowTaggedEntityBehavior** (priority 1) — resolves the closest entity matching `targetTags` from `ActorTaggingBlackboard` and moves toward it
2. **AttackEntityInRangeBehavior** (priority 2) — attacks when the resolved target is within the attack band

All distance parameters use **surface-to-surface distance** semantics — the framework reads both actors' collider radii (`ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`) and adds them automatically. Authors set weapon reach, not center-to-center distance.

The composite derives all internal follow/attack/hysteresis values from `maxAttackDistance` so the NPC is **guaranteed to park inside its own attack band**. This eliminates the class of bug where an NPC's follow distance, attack range, and collider sizes disagree.

Because `AttackEntityInRangeBehavior` has higher internal priority, it wins the movement controller when in range — stopping the NPC to attack. When the target leaves range, the follow behavior resumes pursuit.

The target is synced from the follow behavior to the attack behavior each frame automatically. No manual target wiring is needed.

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC chase and attack the player"
- "Add combat engagement" / "Make an NPC fight"
- "Have the enemy follow me and attack when close"
- "Create an NPC that pursues and attacks tagged entities"
- Any variation involving an NPC following a target and attacking it

## Prerequisites

- Actor Framework deployed — checked in at `scripts/Actor/`
- A baked **NavMesh** exists in the scene so the NPC chases around obstacles — create + bake one via the `adding-navigation` skill (required for obstacle-aware movement; without it the NPC walks in straight lines through walls)
- NPC has `ActorSdkLogicComponent` on root
- NPC has `ActorAnimatedAttackComponent` on root — `deliveryMode: 0` for melee, `deliveryMode: 1` for ranged/projectile attacks. One component serves both; there is no separate ranged controller
- For projectile attacks, `ActorAnimatedAttackComponent` has `deliveryMode: 1`, a `projectileTemplate` assigned and a `projectileSpawnOffset` set in actor-local space (see Melee vs Ranged). **The `projectileTemplate` MUST carry a component implementing `IActorProjectile`** (`fire`/`onHit`; optional `getSpeed`) — this is the ranged counterpart of the melee strike. The controller duck-types for it and, if no component on the template implements it, logs `Spawned projectile has no ActorProjectile component` and never fires.
- NPC has the movement controller named in the Actor Contract (`implementing-actor-behaviors.md`) — `ActorTransformMoveComponent`; `ActorPhysicsComponent` is a collision controller, not a mover — unless it is an intentionally stationary attacker (see below)
- NPC and target have physics colliders for automatic surface-to-surface distance calculation
- Target entities are tagged via `ActorSdkTagComponent` or auto-tagged via `ActorSdkTagPlayerService`
- To make a target die and despawn after N hits, give it an `ActorGASHealthComponent` with `maxHealth = N` — it is a subclass of `CharacterGASComponent` (so the projectile's `takeDamage` still applies) and additionally registers the `ActorHealthController` that `DeathBehavior` polls. A bare `CharacterGASComponent` does NOT register that controller, so death/despawn never fire. Then add a `DeathBehavior` with `despawnTimer > 0` (it defaults to `-1` = no auto-despawn). The attack controller only reads `isDead`; it does not despawn the target on its own. See the `making-actors-die` skill.

## Usage

`EngageCombatBehavior` is most commonly used through `ActorCombatStarterComponent`. For standalone use or custom composition, create it in a starter script:

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
import {EngageCombatBehavior} from '../scripts/Actor/Behaviors/CoreBehaviors/EngageCombatBehavior';

@component({description: 'Adds chase-and-attack combat to this actor'})
export class StartEngageCombatComponent extends Component {
  @property()
  targetTags: string = 'player';

  @property()
  engagementRange: number = 0; // 0 = unlimited acquisition — see Key Properties

  @property()
  followSpeed: number = 5.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartEngageCombatComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const combat = new EngageCombatBehavior();
    combat.basePriority = 10;
    combat.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    combat.engagementRange = this.engagementRange;
    combat.followSpeed = this.followSpeed;
    combat.attackDamage = 1;
    combat.attackFrequency = 1.0;

    actorLogic.addBehavior(combat);
  }
}
```

## Melee vs Ranged

The same behavior handles both — adjust `maxAttackDistance`:

**Melee** — NPC runs up and strikes:
- `maxAttackDistance: 0.3` (sword reach, surface-to-surface)
- `minAttackDistance: 0` (no dead zone)
- Uses `ActorAnimatedAttackComponent` for direct damage

**Ranged** — NPC keeps distance and attacks from afar:
- `maxAttackDistance: 12.0` (bow range, surface-to-surface)
- `minAttackDistance: 3.0` (flee/switch if target gets too close)
- `preferredAttackDistance: 8.0` (stand at 8m, attack up to 12m). Ranged is the case that **must** set this — the default `0` presses to the inner band edge and the NPC closes to melee instead of kiting.
- **Attack controller (mirror the melee setup).** Where melee leaves `ActorAnimatedAttackComponent.deliveryMode` at `0` and lands a direct hit, ranged sets it to `1` on that same component so it spawns from a projectile template instead. The projectile template **MUST** carry a component implementing `IActorProjectile` (`fire`/`onHit`; optional `getSpeed`) — that component is the ranged equivalent of the melee strike, and without it the controller logs `Spawned projectile has no ActorProjectile component` and nothing fires. Do **not** hand-roll a bespoke projectile (a `PhysicsBodyComponent.linearVelocity` + `OnCollisionEnterEvent` component) — projectile mode already pools, aims, leads, and fires `IActorProjectile` instances.
- **Spawn location — set `projectileSpawnOffset` to the muzzle.** It is **actor-local** (x=right, y=up, z=forward; MHE local forward is **-Z**, so the forward component is **negative**). The default `(0, 1.5, -0.5)` fires from mid-body forward; push `z` more negative than the caster's collider radius so the projectile clears the caster (no underground/self-collide), and prefer the exact firing point (wand tip, muzzle, dragon mouth) when the rig has one. The controller rotates this offset by the caster's facing (and by the lead aim) and `teleportTo`s the projectile there — you only configure the offset.
- **Aim direction + target point — `fire()` aims at the target's BODY CENTER, not its anchor.** In your `IActorProjectile.fire(payload)`, derive the travel direction from `payload.target`'s position, never from the projectile's own rotation (`worldForward`/`worldRotation` flies along the caster's stale facing). But `payload.target.getComponent(TransformComponent).worldPosition` is the target's **anchor**, which for a character sits at the **feet** — aiming there flies low and misses. Lift the aim by roughly the target's half-height (a configurable `targetAimHeight`, or a dedicated `AimPoint` child entity when the template has one) so the shot tracks the torso, then set `linearVelocity = dir.mul(speed)` (full 3D).
- **Scale — size the projectile entity AND its VFX separately.** Scale the projectile **template/mesh** small for a bolt (~0.2–0.5) via its entity transform. Scale the **VFX** with **VFX parameters** (e.g. `global_scale`), NOT the entity transform — transform scale does **not** affect VFX particles, and marketplace fireball/explosion effects are authored large, so a default-scale spawn effect looks huge; tune `global_scale` down to projectile size (see the `tuning-vfx-parameters` skill).
- **VFX placement.** Put the VFX **inside the projectile template** as a child entity so it inherits the projectile's transform and travels with the shot — the controller teleports/fires the pooled projectile **root**, and only entities parented under it follow; a separate or unparented VFX stays at the muzzle. Give that child a `VfxPlatformComponent` (the asset + `global_scale` live there; a script-only `VfxComponent` has nothing to scale). Drive it from the projectile's `fire()`/`onHit()` via `VfxComponent.play()`/`stop()`; do **not** rely on `autoPlay` — the pool pre-spawns `poolSize` projectiles (default 15) off-screen, so `autoPlay` plays them all at once off-screen (a Quest frame cost) and they may expire before the first shot.
- **Lead moving targets — opt in, on both sides.** Set `ActorAnimatedAttackComponent.leadTargetPrediction = true` (default `false` / straight fire) so the controller orients the spawn at the predicted intercept. For the projectile to actually fly there, `fire()` must lead too: when `payload.targetVelocity` is set, aim at `aimPoint + targetVelocity * (distance / speed)` instead of the target's current position — the controller's spawn orientation alone does not redirect a `fire()` that re-derives a straight direction. Implement `getSpeed()` to return the projectile's m/s so the controller sizes the lead from the real flight speed; without it a fixed short lead is used. Leave `leadTargetPrediction` off for hitscan or deliberately non-tracking shots.

Do **not** add the target's body size to these values. The framework reads both actors' collider radii and computes center-to-center distances internally.

## Multiplayer (networked projectiles)

Worlds are client–server, so a ranged attacker must stay consistent for every player. The bundled `FireballProjectile` is the worked reference; mirror its contract:

- **Hit detection + damage are owner-only.** Run the collision/trigger handler that applies damage with `ExecuteOn.Owner` so the server is the single authority. Applying damage on every client multi-counts it — a 3-hit kill dies in one hit, or dies inconsistently across clients.
- **Replicate visual state with a `NetworkEvent`, not per-client property writes.** Toggle the projectile mesh from an owner-broadcast event handled `ExecuteOn.Everywhere` (each client mutates its own `MeshComponent.isVisibleSelf`). A non-owner write to a networked entity throws "entity not owned"; toggling `isVisibleSelf` per-client without the broadcast is that bug.
- **Broadcast impact cosmetics to all players.** Spawn the impact VFX networked (or broadcast an event so each client spawns it locally) — a `NetworkMode.LocalOnly` impact spawned on the owner is invisible to remote players.
- **Recycle, never destroy.** On hit or lifetime, deactivate and let the controller reuse the pooled entity; `entity.destroy()` removes it from the controller's index-reused pool and breaks the shooter.

## Stationary attacker (turret / defender)

For a defender that must hold position (e.g. a wizard at a wall) instead of chasing, set `engagementRange === maxAttackDistance` (e.g. both `10`, with `minAttackDistance: 0`). The target is then never "detected but out of attack range", so `AttackEntityInRangeBehavior` (internal priority 2) claims the movement controller and stops the actor the instant it acquires a target — the priority-1 follow never advances it. For an absolute guarantee it cannot move, give the actor no movement controller at all (omit `ActorTransformMoveComponent`): `EngageCombatBehavior`'s follow then has nothing to drive, while the attack controller still fires. Do not try to compose `TargetTaggedEntityBehavior` + `AttackEntityInRangeBehavior` yourself — `AttackEntityInRangeBehavior.targetEntity` is only wired by `EngageCombatBehavior.update()`, so a hand-composed pair never acquires a target and never attacks.

## Attacking a static structure or objective (tower defense)

The target does **not** have to be a player or another actor — it can be a **static structure** (a castle, a base, a crystal, a door). This is the tower-defense pattern: enemies path to a structure and attack it until it is destroyed. Wire it exactly like any other combat target — do **NOT** hand-roll a per-frame "measure distance to the structure, then call `takeDamage`" loop on the spawner/attacker. That hand-rolled proximity loop is the anti-pattern this skill exists to replace: it re-implements (worse) what `EngageCombatBehavior` already does with correct surface-to-surface range, and it typically hardcodes the structure's position instead of tracking the live entity.

Give the **structure** three things:

1. A physics collider (`ColliderBoxComponent` for a building) — required for surface-to-surface distance.
2. A `CharacterGASComponent` with `maxHealth` set explicitly. Both the melee (`ActorAnimatedAttackComponent`) strike and the projectile path resolve a `CharacterGASComponent` on the target root **or a child** and call `takeDamage`. Use its subclass `ActorGASHealthComponent` instead if the structure should play a hit/destroy animation or despawn via `DeathBehavior`.
3. A tag via `ActorSdkTagComponent` (e.g. `"castle"`) so `EngageCombatBehavior` can acquire it.

A structure that only *receives* damage (a passive objective — a wall, a crystal) needs nothing beyond the three items above: `EngageCombatBehavior` acquires it by tag (via its `ActorSdkTagComponent` + `TransformComponent`) and the attacker's controller resolves its `CharacterGASComponent` to apply damage — neither path reads an `ActorSdkLogicComponent` on the target. Add `ActorSdkLogicComponent` (plus its own attack behaviors) to the structure only if it must itself *act* — a defensive tower that shoots back, e.g. `wizard_fireball_defender`; then it is an actor in its own right.

Give the **attacker** a normal melee combat setup (`ActorCombatStarterComponent` or `EngageCombatBehavior` + `ActorAnimatedAttackComponent`) with `targetTags` set to the structure's tag.

**Express the prompt's distance literally, as surface-to-surface reach.** When the creator says "attack when within 1 m of the castle", set `maxAttackDistance: 1.0` — nothing more. `maxAttackDistance` is the gap between the two colliders' *surfaces*; the framework adds both footprints (including the castle box's large half-extents) automatically. Do **NOT** convert "1 m" into a larger center-to-center number (e.g. `3.5`/`4.0` "to account for the castle collider") — that is exactly the footprint math the framework already does, it reads as the wrong distance to anything inspecting the value, and a large structure's center is unreachable anyway (the attacker collides with the wall long before reaching the pivot). Author the literal reach; the framework handles the geometry.

```typescript
// Configuration values only — wire into `actorLogic` inside a starter script as
// shown in the Usage section above:
//   import {EngageCombatBehavior} from '../scripts/Actor/Behaviors/CoreBehaviors/EngageCombatBehavior';
//   const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
// Zombies attack a castle when within 1 m of its wall.
const combat = new EngageCombatBehavior();
combat.basePriority = 10;
combat.targetTags = ['castle'];   // matches the castle's ActorSdkTagComponent tag
combat.maxAttackDistance = 1.0;   // 1 m from the castle SURFACE (surface-to-surface)
combat.engagementRange = 0;       // unlimited: acquire the castle from anywhere
combat.attackDamage = 5;
combat.followSpeed = 3.0;
actorLogic.addBehavior(combat);
```

## Key Properties

| Property | Default | Description |
|---|---|---|
| `targetTags` | `["player"]` | Tags to target via `ActorTaggingBlackboard` |
| `maxAttackDistance` | `1.5` | Max surface-to-surface distance (meters) for attacks. Weapon reach. |
| `minAttackDistance` | `0` | Min surface-to-surface distance (meters). Dead zone for ranged NPCs. |
| `preferredAttackDistance` | `0` | Where NPC stands (surface-to-surface meters), clamped into the attack band. `0` presses to the INNER edge — melee closes to the target's collider surface. Set a positive value only for a kiter (see Ranged above). |
| `engagementRange` | `0` | Surface-to-surface distance (meters) for target acquisition/retention. `0` (or unset) = **unlimited**: acquires the nearest tagged target at any distance, so an enemy spawned away from its target still hunts it. Set a positive value only for a dormant/ambush enemy that must wake within range. |
| `followSpeed` | `5.0` | Movement speed (m/s) when pursuing |
| `attackDamage` | `1` | Damage per attack |
| `attackFrequency` | `1.0` | Cooldown between attacks (seconds) |
| `basePriority` | — | Priority of the composite behavior |

## How It Works

`EngageCombatBehavior` extends `CompositeBehavior`, which handles controller routing across sub-behaviors automatically. On `initialize()`:

1. Validates `minAttackDistance <= maxAttackDistance` (swaps and warns if violated)
2. Creates a `FollowTaggedEntityBehavior` (internal priority 1) configured with the target tags and follow speed
3. Creates an `AttackEntityInRangeBehavior` (internal priority 2) configured with attack damage and cooldown

Each frame in `update()`:
1. Syncs the resolved target entity from the follow behavior to the attack behavior
2. Uses cached collider footprints (auto-invalidated on target swap and root XZ scale change)
3. Derives center-to-center distances: `follow.followRange = sumR + preferredAttackDistance`, `attack.maxAttackDistance = sumR + maxAttackDistance`, etc.
4. Pushes derived values to sub-behaviors via `applyRuntimeRanges()`
5. Monitors for pursuit stalls (warns after 5s if NPC cannot reach attack band)

The `getTarget()` method returns the currently resolved target entity, useful for external systems that need to know what the NPC is fighting.

Footprint cache invalidation: target swap and root XZ scale change auto-invalidate. For rig swap, equipment change, or child-collider scale animations that don't move the root scale, call `combat.invalidateFootprintCache('self' | 'target' | 'all')` from the authoring code that mutates the collider.

## Common Mistakes

1. **Setting `minAttackDistance` / `maxAttackDistance` on `AttackEntityInRangeBehavior` directly** — these fields on the sub-behavior are center-to-center values derived by the composite. Set them on `EngageCombatBehavior` instead, which adds collider radii automatically.
2. **Missing attack controller** — NPC needs an `ActorAttackController` implementation (e.g. `ActorAnimatedAttackComponent`) or attacks silently do nothing.
3. **Wrong `targetTags`** — must exactly match the tag on target entities (case-sensitive), and `EngageCombatBehavior.targetTags` is an array: use `["player"]` for auto-tagged players. See "The Tag Targeting Contract" in the parent skill.
4. **Missing collider** — without a `ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`, collider radius defaults to 0 (center-to-center fallback). Attach a collider for correct surface-to-surface distance.
5. **No movement controller** — a chasing NPC needs `ActorTransformMoveComponent` (the mover named in the Actor Contract) to follow the target. `ActorPhysicsComponent` is not a mover — it only toggles collision/gravity.
6. **Priority conflicts** — if other behaviors have higher priority on the same controllers, combat won't execute. Set `basePriority` higher than idle/patrol behaviors.
7. **Mutating colliders without invalidating the footprint cache** — `EngageCombatBehavior` caches `getFootprintXZ()` and auto-invalidates only on target swap or root XZ scale change. After rig swap, equipment change, or child-collider scale animations, call `combat.invalidateFootprintCache(scope)` to force recompute:
   ```ts
   combat.invalidateFootprintCache('self');    // this actor scaled / swapped its rig
   combat.invalidateFootprintCache('target');  // current target swapped equipment
   combat.invalidateFootprintCache('all');     // world reset / NPC pool reuse
   ```
8. **Wrong `projectileSpawnOffset` on `ActorAnimatedAttackComponent`** — the offset is **actor-local** and rotated by the caster's facing at fire time. Using world-space values, or a positive/zero `z` (MHE local forward is **-Z**), spawns the projectile inside or behind the caster — it self-collides or appears underground. Use a negative `z` more negative than the caster's collider radius.
9. **Oversized projectile VFX** — the fireball/explosion effect spawns huge because VFX particle size is controlled by **VFX parameters** (e.g. `global_scale`), not the entity transform; scaling the projectile entity does nothing to the particles. Tune the VFX `global_scale` down (see the `tuning-vfx-parameters` skill).
10. **VFX not parented to the projectile** — the spawn effect stays at the firing point instead of travelling with the shot because it was spawned as a separate entity (or left unparented). The controller moves the pooled projectile **root** entity (`teleportTo` + `fire`); bundle the VFX as a child entity (with a `VfxPlatformComponent` carrying the asset + params) inside the projectile template so it inherits the root transform and follows the projectile.
11. **VFX plays on spawn instead of on fire** — with `autoPlay` on, every pooled projectile's effect starts playing immediately off-screen at spawn (default `poolSize` 15), wasting GPU and often expiring before the projectile is first fired. Drive `VfxComponent.play()`/`stop()` from the projectile's `fire()`/`onHit()` instead.
12. **Projectiles miss moving targets** — first enable `leadTargetPrediction` on the `ActorAnimatedAttackComponent` (it defaults to `false`, so without this the projectile fires straight at the target's current position). Lead prediction then sizes the lead from the projectile's speed. If your `ActorProjectile` does not implement `getSpeed()`, the controller falls back to a fixed lead horizon that under/over-leads at range; return the projectile's actual m/s from `getSpeed()`. Lead is straight-line (non-ballistic), so a gravity-affected arc still under-aims vertically.
13. **Projectile template has no `IActorProjectile` component** — `ActorAnimatedAttackComponent.projectileTemplate` points at a template whose root component does not implement `IActorProjectile` (`fire`/`onHit`; optional `getSpeed`), or the ranged NPC was given a hand-rolled projectile, or it was left at the melee `deliveryMode: 0`. The controller duck-types for `IActorProjectile`, logs `Spawned projectile has no ActorProjectile component`, and never fires. Give the projectile template a component implementing `IActorProjectile` (the ranged counterpart of the melee strike).
