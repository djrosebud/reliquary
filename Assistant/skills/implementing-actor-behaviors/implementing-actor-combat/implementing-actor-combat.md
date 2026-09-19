---
name: implementing-actor-combat
description: Adds melee combat to an Actor Framework NPC by composing the follow and attack behaviors under EngageCombatBehavior, including target resolution by tag and the melee strike wiring.
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
    when: targets come from an external detection or threat system, or factions must be distinguished
---

# Adding Melee Combat to Actor Framework NPCs

A melee combat NPC uses two core behaviors composed by `EngageCombatBehavior`:

- **FollowTaggedEntityBehavior** — finds the closest entity matching one or more tags (e.g. `"player"`) via `ActorTaggingBlackboard` and moves toward it
- **AttackEntityInRangeBehavior** — triggers an attack when the target is within range, claiming the attack and movement controllers to stop and strike

`ActorCombatStarterComponent` wires this up as a single component on the NPC root entity.

> **Ranged variant.** This skill covers melee (direct-hit) attackers. For a
> **ranged** attacker — one that shoots, casts, fires, or throws a projectile
> (e.g. an archer, a turret, a wizard that shoots fireballs) — the structure is
> the same, and the attack controller is the SAME component: set
> `ActorAnimatedAttackComponent.deliveryMode` to `1` (projectile) and give it a `projectileTemplate`
> whose component implements `IActorProjectile` (the ranged counterpart of the
> melee strike). Never hand-roll a bespoke projectile. See the
> `making-actors-engage-in-combat` skill (Melee vs Ranged).

## Trigger Conditions

Activate this skill when the creator asks to:

- "Create a melee enemy" / "Make a melee NPC" / "Add a sword-wielding enemy"
- "Make an NPC that attacks me" / "Create an NPC that fights the player"
- "Add combat to this NPC" / "Make this NPC fight" / "Give this NPC attack abilities"
- "Create enemies that will attack me" / "Add hostile NPCs"
- "Create NPCs that fight each other" / "Make two NPCs battle each other"
- "Create a boss enemy" / "Make a mob enemy" / "Add combat AI"
- "Make an NPC chase and attack" / "Add a goblin that attacks nearby players"

## Prerequisites

- Actor Framework deployed — checked in at `scripts/Actor/`
- `ActorSdkManagerComponent` on a persistent scene entity (bootstraps services including `ActorSdkTagPlayerService`)
- NPC has `ActorSdkLogicComponent` on root
- NPC has `ActorAnimatedAttackComponent` on root. `deliveryMode: 0` (the zero-init default) lands melee damage directly; `deliveryMode: 1` fires a pooled projectile and additionally needs a `projectileTemplate` whose component implements `IActorProjectile` — see Ranged variant above
- NPC has a physics collider (`ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`) for automatic surface-to-surface distance calculation
- NPC has a masked additional AnimGraph layer (`Attack_Layer`) whose state machine holds the attack states `Attack` and `Empty State`, listed in the `Visuals` entity's `AnimatorPlatformComponent.additionalLayers`. Those names live on `scripts/animation/layers/AttackLayer.ts`. The attack no longer lives on the base locomotion graph.

## Getting Started

Add `ActorCombatStarterComponent` to the NPC root entity. It wires `EngageCombatBehavior` which composes `FollowTaggedEntityBehavior` + `AttackEntityInRangeBehavior`:

- **FollowTaggedEntityBehavior** moves the NPC toward the target, closing to striking distance
- **AttackEntityInRangeBehavior** triggers attacks when the target is within the `minAttackDistance`–`maxAttackDistance` band, stops movement, and rotates to face the target

The NPC also needs these components on the root entity:

- **`ActorSdkTagComponent`** — registers the NPC in the tagging system with tags (e.g. `"enemy"`). Without it, other combat NPCs cannot target this entity.
- **`ActorAnimatedAttackComponent`** — the attack controller. Paces the attack and lands the damage; asks the entity's `CharacterAnimationController` for the `AnimAction.MELEE` / `AnimAction.RANGED` intent rather than driving the animator itself.

The framework sources are checked into this package — read them directly for
full implementation details:

- Behaviors: `scripts/Actor/Behaviors/CoreBehaviors/`
- Controllers: `scripts/Actor/Controllers/Implementations/`
- Starter: `scripts/Actor/Behaviors/ActorCombatStarterComponent.ts`

## Combat Properties

Key properties on `ActorCombatStarterComponent`:

| Property | Default | Notes |
|---|---|---|
| `targetTags` | `'player'` | Comma-separated tags to target |
| `engagementRange` | `0` | Surface-to-surface distance to acquire/retain a target. `0` (or unset) = **unlimited**: acquires the nearest tagged target at any distance, so an enemy spawned away from the player still hunts it. Set a positive value only for a dormant/ambush enemy that must wake within range. |
| `minAttackDistance` | `0` | Min surface-to-surface distance. Dead zone for ranged NPCs. |
| `maxAttackDistance` | `1.5` | Max surface-to-surface distance (meters) for attacks. Weapon reach. |
| `followSpeed` | `3.0` | Chase speed (m/s) |
| `preferredAttackDistance` | `0` | Where NPC stands (surface-to-surface meters), clamped into the attack band. `0` presses to the INNER edge — a melee actor closes to the target's collider surface. Set a positive value only for a kiter that must hold range. |
| `attackFrequency` | `1.0` | Minimum seconds between attacks |
| `combatBasePriority` | `10` | Behavior priority |

Attack pacing lives on `ActorAnimatedAttackComponent`: `minTimeBetweenAttacks`,
`damageDelaySeconds`, `swingDurationSec` / `swingCooldownSec` and the projectile
pair `throwDurationSec` / `throwCooldownSec`. Read their current defaults and the
template-instance zero-init gotchas off the `Source:` file below rather than a copy
here — a copied table drifts, and this one already had to correct a stale
`attackAnimationDuration` once.

Two constraints the source cannot state on its own, because each spans two
properties:

- `damageDelaySeconds` must be strictly LESS than `swingDurationSec`. It is the
  contact frame inside that swing, so a value at or past the end lands the hit on
  the last frame and the victim only reacts once the swing has finished. Tune per
  clip against both edges: too late and the reaction trails a completed swing, too
  early and the swing never reads before the victim recoils.
- Each cooldown must stay above `0.1`. The animation layer leaves on
  `state_finished AND <cooldown> > 0.1`, so a `0` freezes the character in the last
  frame of the pose.

This component plays no animation itself, and holds no layer name, state name or
animator reference. It asks the entity's `CharacterAnimationController` for a
gameplay INTENT and the animation side decides how to play it:

```typescript
animation.play(AnimAction.MELEE);    // deliveryMode 0
animation.play(AnimAction.RANGED);   // deliveryMode 1
animation.stop(AnimAction.MELEE);    // abort a swing before contact (stagger)
```

**Multiplayer needs no extra wiring.** The layer serving that intent replicates the
edge itself — predicted locally on the caller for an instant response, then owner →
all clients — so there is one launcher by construction and no way to double-fire.
Call `play()` on whichever client detected the attack; do not wrap it in your own
`@rpc`.

**Timing lives here, playback lives there.** This component owns
`minTimeBetweenAttacks`, `damageDelaySeconds`, `swingDurationSec` /
`swingCooldownSec` and `idleTransitionDelay`, and pushes the duration/cooldown pair
down to the layer with `animation.tune(...)` at create time. Keep
`damageDelaySeconds` under `swingDurationSec`: they describe the same swing.

**To add a new attack family** — magic, a second weapon class — do NOT add a
controller or a transition call here. Add an `AnimAction` constant and a layer file
under `scripts/animation/layers/`, register it in `layers/index.ts`, and ask for the
new intent. Nothing in this component, in `CharacterAnimationController`, or in any
other layer changes. See `scripts/animation/layers/AnimLayer.ts`.

Source: `scripts/Actor/Controllers/Implementations/ActorAnimatedAttackComponent.ts`

## Customization

For more control over behavior composition — e.g. custom target selection, conditional activation, or additional behaviors — create a starter component that instantiates the behaviors directly:

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

@component({description: 'Custom combat starter'})
export class CustomCombatStarter extends Component {
  @property()
  targetTags: string = 'player';

  @property()
  engagementRange: number = 0; // 0 = unlimited acquisition — see Combat Properties

  @property()
  followSpeed: number = 4.0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[CustomCombatStarter] No ActorSdkLogicComponent on entity');
      return;
    }

    const combat = new EngageCombatBehavior();
    combat.basePriority = 10;
    combat.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    combat.engagementRange = this.engagementRange;
    combat.followSpeed = this.followSpeed;

    actorLogic.addBehavior(combat);
  }
}
```

## Tagging

Targets are resolved via `ActorTaggingBlackboard` — no manual player tracking code needed. `ActorSdkTagPlayerService` auto-tags players with `"player"`, and `ActorSdkTagComponent` tags NPCs with custom tags like `"enemy"`.

`ActorCombatStarterComponent.targetTags` accepts a comma-separated string (e.g. `"player"`, `"player,enemy"`). The actor engages the closest entity matching **any** listed tag.

For NPC-vs-NPC combat, tag each faction differently (e.g. `"team_a"`, `"team_b"`) and set each NPC's `targetTags` to the opposing faction.

## Common Mistakes

1. **Missing `ActorSdkManagerComponent`** — without it, `ActorSdkTagPlayerService` never starts and players are never tagged. Combat NPCs won't find targets.
2. **Attack layer missing from the template** — the layer an intent maps to must be listed in the `Visuals` entity's `AnimatorPlatformComponent.additionalLayers` (melee uses `Attack_Layer`, masked to `human_upper_body.skelmask`). This no longer fails silently: the layer fades itself in at start and the SDK throws on a name that is not mounted, so a missing entry surfaces as a startup error. STATE names inside the layer still fail quietly, and they live on the layer class (`scripts/animation/layers/AttackLayer.ts`), not on this component.
3. **Wrong `targetTags`** — must match tags registered on target entities. Use `"player"` to target auto-tagged players, or match custom `ActorSdkTagComponent.tags`.
4. **No physics body** — movement controllers require a `PhysicsBodyPlatformComponent`. Without it, the NPC cannot move.
5. **NPC missing `ActorSdkTagComponent`** — without it, other combat NPCs cannot discover this entity through the tagging system.
6. **Attack delay misaligned** — set `damageDelaySeconds` to match the hit frame in the attack animation. Too early = hit registers before visual contact; too late = after animation ends.
7. **Missing collider** — without a `ColliderCapsuleComponent`, `ColliderSphereComponent`, or `ColliderBoxComponent`, collider radius defaults to 0. Attach a collider for correct surface-to-surface distance.
8. **Mutating colliders without invalidating the footprint cache** — `EngageCombatBehavior` caches footprints and auto-invalidates only on target swap or root XZ scale change. After rig swap, equipment change, or child-collider scale animations, call `combat.invalidateFootprintCache(scope)`:
   ```ts
   combat.invalidateFootprintCache('self');    // this actor scaled / swapped its rig
   combat.invalidateFootprintCache('target');  // current target swapped equipment
   combat.invalidateFootprintCache('all');     // world reset / NPC pool reuse
   ```
