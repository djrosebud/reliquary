# Using the GAS system

Reference documentation for the Gameplay Ability System — attributes, tags,
effects, abilities and cues, plus the ready-made weapon, projectile and targeting
components. Covers health and damage, resource pools, buffs and debuffs,
cooldowns, status states, and any "fire a weapon" or "cast an ability" mechanic.
Not locomotion, camera or NPC behaviour trees: those belong to the character
controller and the Actor framework.

This lives beside the code it documents rather than under `Assistant/skills/`, so
it is not in the assistant's skill catalog. `Docs/INSTALLED_PACKAGE.md` points
here from every GAS row.

Two layers live in this project:

| Path | What it is |
|------|------------|
| `scripts/gas/` | The framework. Attributes, tags, effects, abilities, cues, and the `GASComponent` facade. |
| `scripts/gas/weapons/`, `scripts/gas/projectiles/` | Ready-made content built on it. Weapons, projectiles, targeting. |

Game code talks to **`GASComponent` only**. It owns five sub-managers and creates
them at start; do not construct `GASAttributeSet`, `GASEffectManager`,
`GASAbilityManager`, `GASTagContainer` or `GameplayCueManager` yourself.

Read exact signatures, enum members and defaults from the source — this skill
covers the decisions and the failure modes, not the API surface.

## 1. Both sides need a GASComponent

Add `GASComponent` to the caster **and** to anything it should affect. Effects
applied to an entity without one do nothing, silently — no error, no damage.

Two editor properties: `initialTags` (comma-separated, e.g. `player, faction.blue`)
and `useHierarchicalMatcher` (leave on).

## 2. Attributes — the numbers

Seed them either by subclassing `GASComponent` and overriding
`getInitialAttributes()`, or at runtime with `gas.tryAddAttribute(new GASAttributeData({...}))`.

**`tryAddAttribute` returns `false` and does nothing if the name is already
taken.** It does not overwrite and it does not throw. Two systems seeding
`health` means the second one silently inherits the first one's bounds.

Read with `getAttributeValue` / `getAttributeBase`; write with `setAttributeBase`
or `applyInstantModifier`. Prefer driving values through effects (§4) — direct
writes bypass the effect pipeline, so no `postGameplayEffectExecute` hook, no
cue, and no stack bookkeeping.

Clamp or reroute values by overriding `preAttributeChange` /
`preAttributeBaseChange` in a `GASComponent` subclass.

## 3. Tags — the states

Matching is **hierarchical**: a query matches a tag that is equal to it or a
descendant of it, split on `.`.

- query `status` matches an owner holding `status.burning` — yes
- query `status.burning` on an owner holding only `status` — **no**, parents do not grant children
- query `stat` on an owner holding `status` — no, not a path segment

Tags are stack-counted. `addLooseTag(tag, n)` / `removeLooseTag(tag, n)`; a tag
is present while its count is above zero.

## 4. Effects — how numbers and states change

A `GASEffectData` carries a `DurationPolicy`, a list of `GASEffectModifier`, and
optional tags applied to the target. Each modifier targets one attribute with an
operator and a magnitude mode. The enums are in `scripts/gas/core/Enums.ts`;
read them there rather than guessing member names.

Apply with `applyEffectToSelf(data, source?, level?)` or
`applyEffectToTarget(target, data, level?)`.

**Instant effects never stack** — they never enter the active queue, so every
stacking policy is ignored for them. Stacking only applies to `Durational` and
`Infinite`.

### The two rules that cause silent failures

**Cross-network application is by id.** Application always runs on the
*target's* authority. When the target is a remote proxy, only the `effectId`
crosses the wire and the authority resolves it from a static registry. So an
effect that can ever hit a remote target must have a non-empty `effectId` **and**
be passed to `GASComponent.registerEffect(data)` on every machine — register at
module scope or in start-up code, which runs identically everywhere. Without
that you get a console warning and nothing else. In that remote case the call
also returns `null`: no `Effect` handle crosses the wire, so do not rely on the
return value to remove the effect later.

**One id means one definition, forever.** If two *different* `GASEffectData`
objects are registered under one id, the id is dropped from the registry **and
permanently blacklisted** — after that neither definition ever applies again,
on any machine. This bites when a definition is rebuilt per component instance:
five players carrying the same gun build five objects under one id. Build the
definition once at module scope, or cache it keyed by id and by the values that
went into it (`scripts/gas/weapons/core/WeaponSetup.ts` shows the cached
form).

A corollary: reusing one id for a genuinely different effect is not a naming
nit, it disables both.

## 5. Abilities — the actions

Grant with `gas.grantAbility(new GASAbilityData({abilityId, cooldown, costEffect,
requiredTags, blockedByTags, tagsAppliedToOwner, ...}), MyAbilityClass)`, then
run with `gas.tryActivateAbility(id, userData?)`.

Subclass `GASAbility` and override:

- `canActivate()` — extra gate. **Must be side-effect free**: the public
  `canActivateAbility` query calls it speculatively. It receives no `userData`,
  so payload-dependent checks belong in `onActivate`.
- `onActivate(userData)` — the body.
- `onEnd()` — cleanup.
- `tick(delta)` — only runs while `isActive`, for channelled abilities.

### Activation order

`tryActivateAbility` checks, in order: granted → cooldown expired → `requiredTags`
all present and no `blockedByTags` present → cost affordable → `canActivate()`.
Only then does it commit: apply the cost, start the cooldown, add
`tagsAppliedToOwner`, set `isActive`, emit Activated and the activate cues, and
finally call `onActivate`. A failed gate costs nothing.

### Gotchas

- **`grantAbility` is silently idempotent.** A second grant under an existing id
  returns without replacing anything, and an empty `abilityId` only warns. Two
  systems granting the same id means the second one's class is never used.
- **Cost checks read `minValue` off the modifier's attribute object.** Only `Add`
  modifiers are checked, and against the *base* value. Pass the **same**
  `GASAttributeData` instance you seeded the attribute with — a freshly
  constructed one defaults `minValue` to `-Infinity`, so the pool goes negative
  and the ability never runs out.
- **Nothing auto-ends an ability.** Anything that is not instant stays `isActive`
  until you call `endAbility(id)`, and while active it keeps ticking.
- Blocking an ability with a state tag (a reload blocking a shot, a stun blocking
  everything) is the intended pattern: put the tag in `tagsAppliedToOwner` on one
  ability and in `blockedByTags` on the other.

## 6. Cues — cosmetic only

A cue is a tag plus a `GameplayCueContext` (source, target, location, normal,
magnitude). Implement `IGameplayCueHandler` with a `tagPrefix` and register it
on `gas.cueManager.registerHandler(handler)`; routing to the prefix is
hierarchical, so `cue.vfx` receives every `cue.vfx.*`.

Cues fire on **every** client via an Everywhere RPC. Never mutate gameplay state
in a handler — VFX, SFX and camera shake only, or clients diverge.

## 7. Authority — what runs where

Simulation is authority-only. On a non-owner these are **no-ops that return
quietly**: `setAttributeBase`, `applyInstantModifier`, `addLooseTag`,
`removeLooseTag`, `removeEffect`, `removeEffectStack`. Effects and ability state
live only on the authority; proxies receive attribute values and the tag set by
replication and are correct to read, not to write.

Attribute *definitions* are never replicated. They come from code, so
`getInitialAttributes` must produce the same set on every machine.

## 8. Prefer the ready-made components

Do not hand-write firing, reloading, spread, burst, hit resolution or projectile
flight. `scripts/gas/` already has them:

| Directory | Use it for |
|-----------|-----------|
| `gas/weapons/core/` | The shared skeleton — magazine, reload, trigger, aim, muzzle, per-weapon GAS namespacing. Subclassed, not used directly. |
| `gas/weapons/hitscan/` | Instant-trace weapons: pistol, rifle, SMG, shotgun, sniper, burst, piercing. |
| `gas/weapons/projectile/` | Travelling-shot weapons: grenade launcher, bolt, arrow. |
| `gas/weapons/melee/` | Close-range weapons resolved as a sphere overlap plus a facing arc at the moment of the press. |
| `gas/weapons/loadout/` | Several weapons on one character with a switch button. |
| `gas/weapons/targeting/` | Target selection and filtering. `Targeting.ts` walks up from a hit collider to the entity carrying the `GASComponent`. |
| `gas/projectiles/` | The flying object itself — `GASProjectile`, `Motion`, `LaunchProjectileAbility`. Also the base for non-weapon projectile abilities such as a fireball. |

`weapons/hitscan/README.md` and `weapons/projectile/README.md` cover the
per-shot flow, the minimum configuration, and how to extend each family. Read the
one you need before writing a new weapon class.

A new weapon type is usually **configuration**, not code. Write a class only for
a genuinely new delivery model, by subclassing `WeaponFireAbilityBase` and
implementing `deliver()`.

### Wiring a weapon

The entity needs a `GASComponent` and one weapon component. Buttons are separate:
**without a `WeaponInputComponent` on the same entity there is no fire and no
reload button** — the weapon is script-driven via `pullTrigger()` /
`releaseTrigger()` / `reload()`, which is what turrets and NPCs want. Assign the
`.inputconfig` assets on the `WeaponInputComponent`, not on the weapon.

Two weapons on one character **must** have different `weaponKey` values.
Attributes and abilities are keyed by name on the shared `GASComponent` and both
`tryAddAttribute` and `grantAbility` ignore duplicates, so the second weapon
would otherwise share the first magazine and never get its own fire ability.

`damageEffectId` identifies a weapon **type**, not an instance — see the id rule
in §4.

## 9. Verify in-world

The test runners live in `scripts/Tests/`, and only in projects that carry that
directory — a shipping template does not, so check before reaching for them. Where
they exist: attach `WeaponTestRunner` to an entity that also has a `GASComponent`,
point `targetEntity` at a `WeaponTargetDummy` carrying its own `GASComponent` and a
collider, then play and read the console — every line is prefixed
`[WeaponTestRunner]`. `GASTestRunner` covers the framework itself.

Without `scripts/Tests/`, verify by playing: place the weapon component on an
entity with a `GASComponent`, give the target a `GASComponent` and a collider, and
watch the target's `health` attribute.

Run `build_assets` after adding or editing scripts; components do not appear in
the editor until the scripts compile.
