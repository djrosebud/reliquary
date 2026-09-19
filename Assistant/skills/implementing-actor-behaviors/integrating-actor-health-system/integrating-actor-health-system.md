---
name: integrating-actor-health-system
description: Adds ActorHealthComponent-based health, damage, networked hit/death events, and hit/death VFX to an Actor Framework entity. This is the opt-in upgrade path, NOT the default — the BaseActor template already ships ActorGASHealthComponent, which covers plain HP, damage and death. Use this only when damage types, modifiers, invulnerability, callbacks or networked hit/death animations are needed. Use this instead of adding-hit-vfx for ActorHealthComponent actors.
include: as_needed
oncall: horizon_npc_platform
# Reached through implementing-actor-behaviors rather than by top-level
# skill selection, so it is hidden from the switch_skills catalog listing.
sub_skill: true
agents:
  - scripting
  - planning
local_tools:
  # Every source this skill governs is checked in under scripts/Actor/ and is
  # edited in place, so no copy tool is granted -- only the rebuild that an
  # in-place edit requires.
  - build_assets
consider_skills:
  - name: making-actors-die
    when: the actor should stop acting, despawn, or otherwise react when its HP reaches zero
  - name: searching-vfx-effects
    when: hit and death VFX templates must be sourced or created for the actor
---

# Actor Framework Health System

Full-featured health/damage system integrated with the Actor Framework. Fully
compatible with `DeathBehavior`, `StaggerBehavior`, and `EngageCombatBehavior`.

## Check what the actor already has before adding anything

`Templates/Actors/BaseActorTemplate/BaseActor.hstf` — the template every new actor
is duplicated from — already carries **`ActorGASHealthComponent`**, and that is
what the shipped combat NPC runs on. It extends `CharacterGASComponent`, so
damage from any source that resolves a `GASComponent` already lands on it, and
`ActorHealthStarterComponent` (also on the template) already wires `DeathBehavior`
and `StaggerBehavior`.

| The actor needs | Do |
|-----------------|-----|
| HP, damage, death, stagger | **Nothing.** Already on `BaseActor`. Tune `maxHealthValue` on the instance. |
| Damage types, damage modifiers/armor, invulnerability windows, damage callbacks, or networked hit/death animation transitions | Follow this skill — swap to `ActorHealthComponent`. |

An actor must carry **exactly one** health component. `ActorHealthComponent` and
`ActorGASHealthComponent` both register as the entity's `ActorHealthController`;
adding the first without removing the second gives the actor two competing health
pools and whichever registers last wins. If you are upgrading a duplicate of
`BaseActor`, remove `ActorGASHealthComponent` from the instance as part of Step 3.

## Files

This skill ships no source templates. Every file it governs is already checked
in under the project's own `scripts/Actor/Utilities/` — read and edit them in
place:

| File | Role |
|------|------|
| `ActorHealthEvents.ts` | `DamageInfo` / `DamageResult` types and the local + network damage events |
| `ActorHealthComponent.ts` | Health, damage, modifiers, invulnerability, networked hit/death |
| `ActorHealthStarterComponent.ts` | Optional auto-wiring of `DeathBehavior` / `StaggerBehavior` |
| `ActorVfxOnHit.ts` | Hit/death VFX driven by the client-local damage event |

## Trigger Conditions

Activate when the user asks to:
- "Make the enemy deal 20 damage" / "Deal damage to the player"
- "Give the player 500 hp" / "Set max health to 500"
- "Do this when hp is lower than 100" / "Check if health is below half"
- "Add health to this actor" / "Make this NPC take damage"
- "Add armor to the enemy" / "Reduce incoming damage"
- "Make the player invulnerable for 3 seconds"
- "Kill the NPC" / "Revive the player"
- "Show a health bar for this actor"
- "Upgrade from CharacterGASComponent"

## Prerequisites

- Actor Framework deployed — checked in at `scripts/Actor/`
- `ActorSdkManagerComponent` on a persistent scene entity
- NPC has `ActorSdkLogicComponent` on root entity
- (For animations) NPC AnimGraph with transitions matching `deathTransitionName`, `hitTransitionName`, `idleTransitionName`

## Setup Workflow

### Step 1: Core Files (already present)

Every source this skill needs is checked in — nothing is deployed at activation
time, and there is no template to copy over:

| File | Status |
|------|--------|
| `scripts/Actor/Utilities/ActorHealthEvents.ts` | checked in |
| `scripts/Actor/Utilities/ActorHealthComponent.ts` | checked in |
| `scripts/Actor/Utilities/ActorHealthStarterComponent.ts` | checked in |
| `scripts/Actor/Utilities/ActorVfxOnHit.ts` | checked in |

Read them in place and edit them directly.

### Step 2: Optional Starter Component

`ActorHealthStarterComponent` wires `DeathBehavior` and `StaggerBehavior` onto
the actor automatically. It is a component you attach (Step 3, item 4), not a
file you deploy.

This world's copy carries three additions its `character_template` origin does
not: a `knockbackForce` property, a re-registration guard so a repeated
`OnEntityStartEvent` cannot register two competing `DeathBehavior`s, and an
`OnEntityDestroyEvent` handler that hands both behaviors back to
`removeBehavior` so a pooled entity re-registers correctly. `knockbackForce`
defaults to `5` in code but a template instance stores `0` — see the
`@property()` note below and set it explicitly.

### Step 3: Attach Components

1. Remove `ActorGASHealthComponent` from the actor root entity if it is there — a
   duplicate of `BaseActor` ships with it, and two health controllers on one
   entity conflict
2. Add `ActorHealthComponent` to the actor root entity
3. Set `maxHealthValue` property
4. Set `blackboardGroupId` if using faction-based combat
5. (Optional) Add `ActorHealthStarterComponent` for auto-wired death/stagger — a
   duplicate of `BaseActor` already has it, so leave it in place

### Important: `@property()` defaults vs. template values

When a component is persisted in a template, the template stores **every** `@property()` field with the value it had at that moment; those serialized values are authoritative at runtime and **override code-level defaults**. Concretely:

- `maxHealthValue: number = 100` in `ActorHealthComponent.ts` is only a fallback for fresh instantiations. If the template stores `0`, runtime will see `0`, not `100`.
- After adding `ActorHealthComponent` (or `ActorHealthStarterComponent`) to a template, always explicitly set `maxHealthValue`, `blackboardGroupId`, the transition name strings, etc. Don't rely on the code defaults.
- Same rule applies to any custom HUD or helper component you add that references a child by name (e.g., a `healthTextEntityName` property): either set it explicitly on every template that uses the component, or omit the `@property()` default entirely and validate at runtime so the failure is loud instead of silent.

Symptom of getting this wrong: lookups against an empty string or zero silently no-op — the feature appears to do nothing with no error.

### Step 4: Build

Run `build_assets` with `inputs: ['scripts/Actor/']` only if a step above edited
a file under `scripts/Actor/`. Attaching a component to a template changes no
source, so a run that only does Step 3 needs no rebuild.

### Step 5: Hit/Death VFX (combat actors)

For an actor that should show hit/death VFX, wire up `ActorVfxOnHit` (renders `ActorHealthComponent`'s client-local damage event and spawns the corresponding effect):

1. `ActorVfxOnHit` is checked in at `scripts/Actor/Utilities/ActorVfxOnHit.ts`. Read it in place; if you change it, run `build_assets` on `scripts/Actor/`. Otherwise go straight to attaching the component.
2. Add `ActorVfxOnHit` to the same actor root as `ActorHealthComponent`. Leave `healthComponentEntity` unset for this normal same-root setup; set it only when the health component is intentionally hosted on another entity.
3. Source distinct hit and death VFX templates (see the `searching-vfx-effects` skill) and explicitly set `hitVfxTemplate` / `deathVfxTemplate` on the actor template.
4. Verify the actor template contains both components and both template properties, then apply one non-fatal and one fatal hit at runtime. Confirm the actor remains present after VFX initialization, the non-fatal hit plays only `hitVfxTemplate`, and the scene-owned death effect finishes after the actor dies or despawns.

`ActorHealthComponent` broadcasts the owner's authoritative `DamageResult` and delivers `OnActorHealthDamagedLocalEvent` once to every player context, so `ActorVfxOnHit` does not add another network relay. VFX templates initialize asynchronously without holding the actor's start event, and their local entities stay scene-owned long enough for a death effect to finish before cleanup. For Actor Framework actors, use `ActorVfxOnHit` from this skill instead of `adding-hit-vfx`; that skill targets the standalone `HealthComponent` and would duplicate the effect.

---

## API Reference

### Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxHealthValue` | number | 100 | Maximum health |
| `invulnerabilityDuration` | number | 0 | I-frame seconds after damage |
| `showDamageText` | boolean | false | Include display info in DamageResult |
| `blackboardGroupId` | string | '' | Faction ID for CombatBlackboard |
| `deathTransitionName` | string | 'Death' | AnimGraph transition on death |
| `hitTransitionName` | string | 'Hit' | AnimGraph transition on hit |
| `idleTransitionName` | string | 'Idle' | AnimGraph transition after hit |
| `hitDuration` | number | 0.35 | Hit reaction duration (seconds) |

### Read-Only

| Property | Type | Description |
|----------|------|-------------|
| `currentHealth` | number | Current health |
| `maxHealth` | number | Maximum health |
| `isDead` | boolean | Dead state |
| `isAlive` | boolean | Alive state |
| `isInvulnerable` | boolean | Invulnerability state |
| `isHit` | boolean | Hit reaction active |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `takeDamage(damageInfo)` | DamageResult | Apply damage (ownership-aware) |
| `heal(amount)` | number | Heal, returns actual healed |
| `setMaxHealth(value, healToFull?)` | void | Set max health |
| `setCurrentHealth(value, suppressEvents?)` | void | Force set health |
| `die(damageInfo?)` | void | Kill entity |
| `revive(healthAmount?)` | void | Revive entity |
| `setInvulnerable(duration)` | void | Set temp invulnerability |
| `addDamageModifier(modifier)` | number | Add modifier, returns ID |
| `removeDamageModifier(id)` | boolean | Remove modifier |

---

## Common Patterns

```typescript
import { ActorHealthComponent } from './Actor/Utilities/ActorHealthComponent';
import type { DamageInfo, IDamageModifier } from './Actor/Utilities/ActorHealthEvents';
import {
  OnActorHealthDamagedLocalEvent,
  OnActorHealthDamagedNetworkEvent,
} from './Actor/Utilities/ActorHealthEvents';

const health = targetEntity.getComponent(ActorHealthComponent);
if (!health) return;

// Dealing damage (ownership-aware)
const result = health.takeDamage({ baseDamage: 20, damageType: 'physical', attacker: playerEntity });
if (result.wasFatal) { /* Target died */ }

// Healing / admin
health.heal(500);
health.setMaxHealth(500, true); // true = also heal to full
health.setInvulnerable(3);      // seconds

// Instance callbacks (fire on owner). Each returns an unsubscribe fn.
health.onDamageTaken((info, actual) => {});
health.onHealthChanged((current, max) => { if (current < max * 0.25) {/* critical */} });
health.onDeath((info) => {});
health.onHealed((amount) => {});
health.onRevived(() => {});

// Global static callback (any ActorHealthComponent) — for HUD managers / analytics
ActorHealthComponent.onHealthComponentDamaged((comp, info, result) => {});

// Damage modifier (armor)
class ArmorModifier implements IDamageModifier {
  constructor(private armor: number) {}
  modifyIncomingDamage(damage: number) { return Math.max(1, damage - this.armor); }
}
const modId = health.addDamageModifier(new ArmorModifier(10));
// Later: health.removeDamageModifier(modId);
```

### Global events

```typescript
@subscribe(OnActorHealthDamagedLocalEvent, { execution: ExecuteOn.Everywhere })
onLocalDamage(p: ActorHealthDamagedEventPayload) { /* Client-only: UI, VFX */ }

@subscribe(OnActorHealthDamagedNetworkEvent, { execution: ExecuteOn.Everywhere })
onNetworkDamage(p: ActorHealthDamagedEventPayload) { /* All sides: game logic */ }
```

---

## Networking

- **Player health**: Client-owned entity modifies directly.
- **Enemy/object health**: Server-owned. `takeDamage()` on a non-owner sends a network event to the owner; local `currentHealth` is NOT mutated — authoritative state arrives via networked properties.
- **Client prediction**: Non-owner gets instant UI feedback via `onDamagePredicted` callbacks (pure computation, no state mutation).
- `OnActorHealthDamagedLocalEvent`: Client-only (UI/VFX). Player-owned damage reaches the owner synchronously in the damage tick; the later global-event loopback is ignored there, while other player contexts forward the broadcast locally once.
- `OnActorHealthDamagedNetworkEvent`: Broadcast to all sides (game logic).

---

## Actor Framework Integration

- **DeathBehavior / StaggerBehavior**: `ActorHealthComponent` implements `ActorHealthController`; those behaviors poll `getHealthData().isDead` and `.isHit` each frame. `isHit` is set on non-fatal damage and auto-resets after `hitDuration` seconds. No changes to either behavior needed.
- **CombatBlackboard**: set `blackboardGroupId` to a faction ID (e.g. `"enemies"`); on death the component marks this entity dead so combat behaviors stop targeting it.
- **AnimGraph**: death and hit reactions are synced via networked properties (`networkedIsDead`, `networkedIsHit`) and fire transitions on all clients. Configure transition names via the component's properties.

---

## Optional: Reusing the HUD from `implementing-health-system`

`ActorHealthComponent` ships no UI, but the HUD kit from the standalone `implementing-health-system` skill (`HealthBar` or `HealthHearts` + `HealthHUD.ts`) drives off the same `currentHealth` / `maxHealth` / `onHealthChanged(cb)` contract — only a one-line import swap is needed.

**Copy** (pick one style):
- **Bar**: `HealthBar.xaml`, `HealthBarViewModel.ts`, `HealthHUD.ts`.
- **Hearts**: `HealthHearts.xaml`, `HealthHeartsViewModel.ts`, `HealthHUD.ts`, `heart_full.png`, `heart_empty.png`.

**Patch** `HealthHUD.ts` to read from the actor component instead of `HealthComponent`:

```diff
-import { HealthComponent } from './HealthComponent';
+import { ActorHealthComponent } from '../Actor/Utilities/ActorHealthComponent';
-private healthComponent: Maybe<HealthComponent> = null;
+private healthComponent: Maybe<ActorHealthComponent> = null;
-this.healthComponent = targetEnt.getComponent(HealthComponent);
+this.healthComponent = targetEnt.getComponent(ActorHealthComponent);
```

**Wire up**: add `CustomUiComponent` + `HealthHUD` to a HUD entity, point the `CustomUiComponent` at the copied `.xaml`, and set `HealthHUD.targetEntity` to the actor (or leave null to read from the HUD entity itself).

---

## Migration from the pre-GAS health components

1. Remove `ActorGASHealthComponent` from the entity
2. Add `ActorHealthComponent`
3. Update imports: `ActorGASHealthComponent` → `ActorHealthComponent`
4. Change `takeDamage(amount)` calls to `takeDamage({baseDamage: amount})`
5. Change `healDamage(amount)` calls to `heal(amount)`
6. (Optional) Add `ActorHealthStarterComponent` for death/stagger wiring

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| DeathBehavior not detecting death | Verify `ActorHealthComponent` is on same entity as `ActorSdkLogicComponent` and implements `ActorHealthController` |
| StaggerBehavior not activating | Check `hitDuration` > 0 and `isHit` is being set (non-fatal damage required) |
| Damage not applying | Check entity ownership; `takeDamage()` handles cross-ownership via events |
| Animations not playing | Verify AnimGraph transition names match properties exactly (case-sensitive) |
| CombatBlackboard not updating | Set `blackboardGroupId` to a non-empty faction ID |
| Health bar not updating | Use `onHealthChanged()` callback to push values to UI |
| Events not firing | `LocalEvent` = clients only; `NetworkEvent` needs `ExecuteOn.Everywhere` |
