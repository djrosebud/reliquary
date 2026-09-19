---
name: making-actors-attack-when-in-range
description: Gives an NPC a range-triggered melee or ranged attack via AttackEntityInRangeBehavior, which fires when a target enters a configurable distance band. Use for a stationary attacker such as a turret or a caster that shoots without chasing.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
consider_skills:
  - integrating-actor-health-system
  - name: triggering-npc-animations
    when: the attack or hit reaction should play a specific animation clip rather than the template default
---

# Adding Range-Based Attacks to an NPC

`AttackEntityInRangeBehavior` monitors distance to a target entity and triggers attacks when the target is within a configurable distance band. It works for both melee and ranged combat.

When the target is in range, this behavior:
- Claims the **attack controller** to trigger the attack
- Claims the **movement controller** to stop the actor (preventing follow/patrol from moving it mid-attack)
- Claims the **body direction controller** to rotate the actor toward the target on the XZ plane

When the target leaves range, all claims release and lower-priority behaviors (follow, patrol, wander) resume.

## Trigger Conditions

Activate when the user asks to:
- "Make this NPC attack when close" / "Add melee attacks"
- "Make this NPC attack from a distance" / "Add ranged attacks"
- "Attack the player when in range"
- "Stop and attack when close enough"
- "Configure attack distance" / "Change attack range"
- Any variation involving an NPC attacking a target based on distance

## Prerequisites

- Actor Framework deployed — checked in at `scripts/Actor/`
- NPC has `ActorSdkLogicComponent` on root
- NPC has `ActorAnimatedAttackComponent` on root: `deliveryMode: 0` for melee, `deliveryMode: 1` for **ranged** attacks (shoots/casts/fires/throws). In projectile mode its `projectileTemplate` MUST carry a component implementing `IActorProjectile` — never hand-roll a projectile. See `making-actors-engage-in-combat` (Melee vs Ranged).
- Target entity must be set on the behavior (typically wired by a parent composite behavior like `EngageCombatBehavior`, or set manually)
- NPC and target must have physics colliders (`ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`) for automatic surface-to-surface distance calculation

## Usage

`AttackEntityInRangeBehavior` is used internally by `EngageCombatBehavior`. **Do not set `minAttackDistance` or `maxAttackDistance` directly** — they are center-to-center values derived by the composite from surface-to-surface distance + both actors' collider radii. Set `maxAttackDistance` on `EngageCombatBehavior` instead.

For the standard combat setup, use `ActorCombatStarterComponent` or create `EngageCombatBehavior` directly:

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

@component({description: 'Adds attack-in-range behavior to this actor'})
export class StartAttackInRangeComponent extends Component {
  @property()
  maxAttackDistance: number = 1.5;

  // Finite on purpose: this skill is "attack a target that comes into range",
  // so the actor should notice targets nearby, not hunt from across the map.
  // Leave unset (0) only for an enemy that must aggro from wherever it spawns.
  @property()
  engagementRange: number = 7.0;

  @property()
  attackDamage: number = 1;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[StartAttackInRangeComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    const combat = new EngageCombatBehavior();
    combat.basePriority = 20;
    combat.maxAttackDistance = this.maxAttackDistance;
    combat.engagementRange = this.engagementRange;
    combat.attackDamage = this.attackDamage;
    combat.attackFrequency = 1.0;

    actorLogic.addBehavior(combat);
  }
}
```

## Choosing maxAttackDistance (Surface-to-Surface Gap)

`maxAttackDistance` is the weapon's reach in meters, measured **body-surface to body-surface**. Do **not** add the target's body size — the framework reads both actors' collider radii and adds them automatically.

| Weapon / Style | maxAttackDistance | minAttackDistance |
|---|---|---|
| Bite / unarmed melee | `0.0` | `0` |
| Sword / short weapon | `0.3` | `0` |
| Spear / polearm | `1.0` | `0` |
| Thrown / short-range projectile | `4.0` | `0` |
| Bow / ranged | `10.0` | `3.0` (flee if too close) |

For ranged NPCs, set `minAttackDistance` > 0 to create a dead zone — if the target gets too close, the behavior stops attacking (allowing a flee or melee-fallback behavior to take over).

## Anti-Pattern: Direct Distance Authoring

**Do not set `minAttackDistance` / `maxAttackDistance` on `AttackEntityInRangeBehavior` directly.** These fields are:
- Center-to-center distances that ignore both actors' body sizes
- Derived by `EngageCombatBehavior` each frame from `maxAttackDistance` + collider radii
- Impossible to set correctly without knowing the target's collider radius (which can change at runtime)

Always go through `EngageCombatBehavior.maxAttackDistance` / `minAttackDistance` instead.

## Key Properties (values `StartAttackInRangeComponent` uses)

These are the values this skill's sample sets on `EngageCombatBehavior`, not the
behavior's own framework defaults. Where they differ, the framework default is
called out.

| Property | This skill | Notes |
|---|---|---|
| `maxAttackDistance` | `1.5` | Max surface-to-surface distance (meters) for attacks. Weapon reach. |
| `minAttackDistance` | `0` | Min surface-to-surface distance (meters). Dead zone for ranged NPCs. Left at the framework default. |
| `preferredAttackDistance` | `0` | Where NPC stands (surface-to-surface meters), clamped into the attack band. Left at the framework default: `0` presses to the INNER edge, so the actor closes to the target's collider surface. Set a positive value only for a kiter. |
| `engagementRange` | `7.0` | Surface-to-surface acquisition/retention radius (meters). Finite **on purpose** — this skill is the proximity case, so the actor notices nearby targets instead of hunting from across the map. `EngageCombatBehavior`'s own default is `0` (unlimited); pass `0` only for an enemy that must aggro from wherever it spawns. |
| `attackDamage` | `1` | Damage per attack |
| `attackFrequency` | `1.0` | Cooldown between attacks (seconds) |
| `basePriority` | `20` | Behavior priority (higher wins controllers) |

## Reachability Check

After wiring `EngageCombatBehavior`, smoketest with the largest expected target. If the NPC stalls outside the attack band, check the console for:

```
[EngageCombat] Actor cannot reach attack band after 5s of pursuit.
```

This diagnostic logs the current surface gap, attack band, and both actors' collider radii to help identify the mismatch.

## Controllers Claimed

When in range, `AttackEntityInRangeBehavior` claims three controllers at its `basePriority`:

- **`ActorAttackController`** — only when off cooldown and ready to attack. Calls `attack()` with target, damage, and range.
- **`ActorMovementController`** — stops movement so patrol/follow behaviors yield while attacking.
- **`ActorBodyDirectionController`** — rotates to face the target (XZ plane only, if `rotateTowardsTarget` is true).

## Common Mistakes

1. **Setting `minAttackDistance` / `maxAttackDistance` on `AttackEntityInRangeBehavior` directly** — these fields on the sub-behavior are center-to-center values derived by the composite. Set them on `EngageCombatBehavior` instead, which adds collider radii automatically.
2. **`targetEntity` never set** — this behavior does not find targets on its own. Use `EngageCombatBehavior` or a `TargetTaggedEntityBehavior` to wire the target.
3. **Missing attack controller** — the NPC needs an `IActorAttackController` implementation or attacks silently fail: `ActorAnimatedAttackComponent`, with `deliveryMode` `0` for melee or `1` for ranged. In projectile mode its `projectileTemplate` must also carry a component implementing `IActorProjectile`, or it logs `Spawned projectile has no ActorProjectile component` and never fires.
4. **Missing collider** — without a `ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent` on the NPC or target, the footprint defaults to 0 and surface-to-surface distance falls back to center-to-center.
5. **Priority too low** — if a follow behavior has higher priority on the movement controller, the NPC won't stop to attack. Set attack priority higher than follow.
6. **Mutating colliders without invalidating the footprint cache** — `EngageCombatBehavior` caches footprints. After rig swap, equipment change, or child-collider scale animations, call `combat.invalidateFootprintCache(scope)`. Target swap and root XZ scale change auto-invalidate.
   ```ts
   combat.invalidateFootprintCache('self');    // this actor scaled / swapped its rig
   combat.invalidateFootprintCache('target');  // current target swapped equipment
   combat.invalidateFootprintCache('all');     // world reset / NPC pool reuse
   ```
