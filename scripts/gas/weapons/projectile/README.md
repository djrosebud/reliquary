# Projectile Weapons

Ranged weapons whose shots travel. Pistol, shotgun, burst launcher, grenade
launcher all differ only by configuration.

The instant-hit twin is `../weaponhitscan/`. Both sit on the same
`../weaponcore/` skeleton; this directory is only the spawn.

## Files

| File | Role |
|------|------|
| `WeaponProjectileFireAbility.ts` | The contract (`ProjectileWeaponFireConfig`) plus `deliver()` — spawning and configuring one projectile. |
| `WeaponProjectileComponent.ts` | `projectileTemplate`, `projectileSpeed`, `lifetimeSec`, and the per-shot config. Everything else is inherited. |

The flying bullet itself lives in `../projectile/` (`GASProjectile`, `Motion`,
`LaunchProjectileAbility`) and is shared with the `ability_projectile` skill.
`deliver()` calls its `spawnConfiguredProjectile` helper, so the spawn logic —
template instantiation, the child-entity lookup, instigator defaulting — is not
duplicated here.

## What comes from weaponcore

`WeaponComponentBase` supplies 18 properties and everything not
delivery-specific: magazine, reload, trigger, aim, muzzle offset, GAS
namespacing, ownership handling, per-frame polling.

`WeaponFireAbilityBase` supplies cooldown gating, burst rounds, one projectile
per pellet inside a spread cone, muzzle resolution, and game-time burst spacing.

So a projectile weapon is: **the shared skeleton + `deliver()` + three
properties.**

## Minimum configuration

| Property | Why |
|----------|-----|
| `projectileTemplate` | must carry `GASProjectile` + a collider + a **Trigger** PhysicsBody |
| `projectileSpeed` | m/s |
| `lifetimeSec` | speed x lifetime is the effective range |
| `damage`, `fireRate`, `magazineSize`, `fireMode` | inherited |

`templates/ShootingPlayground/Bullet.hstf` is a working example template.

## How it differs from hitscan

| | hitscan | projectile |
|---|---|---|
| Hit resolves | inside the activation | frames later, asynchronously |
| Hit detail | `HitResult` — collider, distance, pierce index | the entity only |
| Range | trace `range` | `projectileSpeed` x `lifetimeSec` |
| Penetration | `maxHits` | not supported — a projectile despawns on its first hit |
| Self-hit guard | ray excludes, then a walk to the GAS root | `instigator` on the projectile |

The differing hit payload is why the two configs stay separate rather than
merging into one: a projectile trigger cannot report a collider or a distance,
and faking them would quietly break any damage model built on them.

**The muzzle matters here.** A projectile spawns at `muzzleOffset` (default
0.33 m forward) and travels; a target closer than that is already behind the
spawn point and will never be hit. Hitscan has no such constraint.

## The shooter can die mid-flight

A projectile outlives the activation that fired it, so the shooter may be
despawned by the time it lands. `WeaponProjectileComponent` drops the hit in
that case: damage is attributed to the shooter's GAS, and there is nothing to
attribute it to once that is gone.

A game that wants posthumous kills should implement its own
`ProjectileWeaponConfigProvider` and apply damage from a source that outlives
the shooter — a team or match-state entity.

## Extending

**Motion** — projectiles fly straight by default. `../projectile/Motion.ts` also
ships `homing`; pass `step` and `homingTarget` from a custom provider.

**Custom damage** — implement your own provider and compute damage in `onHit`.
There is no distance or collider detail to shape it with, unlike hitscan.

**A new weapon family** — see the note in `../weaponhitscan/README.md`; the same
rule applies. One abstract method is the budget.

## Not covered yet

Damage falloff, penetration, arcing motion, and fire / hit / reload GAS cues.
