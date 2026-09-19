# Hitscan Weapons

Instant-trace ranged weapons. The shot lands the frame the trigger is pulled —
pistol, rifle, SMG, shotgun, sniper, burst, piercing all differ only by
configuration.

The travelling-shot twin is `../weaponprojectile/`. Both sit on the same
`../weaponcore/` skeleton; this directory is only the ray.

## Files

| File | Role |
|------|------|
| `WeaponHitscanFireAbility.ts` | The contract (`HitscanFireConfig`, `HitResult`, `TagFilter`) plus `deliver()` — the raycast and how its hits resolve. |
| `WeaponHitscanComponent.ts` | `range`, `maxHits`, and the per-shot config. Everything else is inherited. |

## What comes from weaponcore

`WeaponComponentBase` supplies 18 properties and all the behaviour that is not
delivery-specific: magazine, reload, trigger, aim source, muzzle offset,
per-weapon GAS namespacing, ownership handling, and the per-frame polling that
drives sustained fire.

`WeaponFireAbilityBase` supplies cooldown gating, burst rounds, one ray per
pellet inside a spread cone, muzzle resolution, and game-time burst spacing.

So a hitscan weapon is: **the shared skeleton + `deliver()` + two properties.**

## One shot, end to end

```
pullTrigger() / debugAutoFire / onWorldUpdate
  └→ gas.tryActivateAbility(fireAbilityId)
       └→ GASAbilityManager: cooldown? State.Reloading? enough ammo?
            └→ WeaponFireAbilityBase.canActivate()   isActive guard + config non-null
                 └→ onActivate → fire(config)
                      ├ resolve origin/direction (config first, else owner transform)
                      ├ for each of burstCount rounds:
                      │    ├ for each of pelletCount pellets:
                      │    │    └→ deliver()  ← rayCast, sort by distance, walk to the
                      │    │                     GAS root, tag filter, de-dup, onHit
                      │    └ wait burstIntervalSec (game time, via tick)
                      └ finally endAbility
```

## Minimum configuration

| Property | Why |
|----------|-----|
| `damage`, `fireRate`, `magazineSize`, `fireMode` | inherited; a weapon is not a weapon without them |
| `range` | max trace distance |

Then only what the weapon type needs: `pelletCount` + `spreadDeg` for a shotgun,
`burstCount` + `burstIntervalSec` for a burst rifle, `maxHits` for armour
piercing, `aimSource: 'forward'` + `muzzleOffset` for a turret, a distinct
`weaponKey` per weapon when a character carries two.

## Extending

**Custom damage** (crits, headshots, falloff, per-pierce falloff) — implement
your own `HitscanConfigProvider` and compute damage inside `onHit`. `HitResult`
carries `colliderEntity` for hit location, `distance` for falloff, and
`hitIndex` for pierce order. Reuse the ability unchanged.

**Custom aim** — assign `aimProvider` at runtime; `aimSource` only picks the
default.

**A new weapon family** (beam, charge-up, thrown) — subclass
`WeaponFireAbilityBase` and implement `deliver()`, the way this directory does.
If it needs a SECOND abstract method, the shared skeleton is the wrong fit for
it: inherit `GASAbility` directly and reuse the weaponcore parts à la carte. A
beam is the obvious case — it has no rounds and no pellets.

## Gotchas

**`weaponKey` is mandatory for a second weapon.** Attributes and abilities are
keyed by name on the shared `GASComponent`, and both `tryAddAttribute` and
`grantAbility` silently ignore a duplicate. Two weapons without distinct keys
means the newcomer shares the first magazine and never gets its own ability.

**`damageEffectId` identifies a weapon TYPE, not an instance.** Every instance
runs setup, so definitions are shared per id. Two *different* weapons under one
id is a real conflict: the id is dropped and neither deals damage.

**Burst cooldown.** The cooldown is committed once per activation — set
`1 / fireRate >= (burstCount - 1) * burstIntervalSec` or bursts overlap.

**At most 4 excluded entities.** `rayCast` silently drops the rest. The trace
also walks up from the hit collider to the GAS-owning root and skips the
wielder, which is what actually prevents self-hits.

**Fire is client-authoritative.** The whole trace runs on the owner and damage
is routed to the target's authority with no validation. Fine for PvE and casual
play; a competitive mode needs a different authority model.

## Not covered yet

Damage falloff, hit zones, recoil / bloom spread, ADS, per-round reload,
spin-up, and fire / hit / reload GAS cues.
