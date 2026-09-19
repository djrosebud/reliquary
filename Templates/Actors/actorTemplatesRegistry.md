# Actor Templates Registry

| Template Name | File Path | Description | Status |
|---------------|-----------|-------------|--------|
| CombatEnemy | `Templates/Actors/BaseActorTemplate/BaseActor.hstf` | Neutral actor base — mesh, animator, character simulation, and the capability controllers (movement, attack, health, stagger, item pickup). The attack controller does melee **or** ranged: `ActorAnimatedAttackComponent.deliveryMode` is `0` melee (the zero-init default) and `1` projectile, which additionally needs a `projectileTemplate` whose root implements `IActorProjectile` — without one it stays inert and does not even register. Carries no behaviour starter, so the bare template just stands there: add `ActorCombatStarterComponent` per placement as a template-instance delta. Duplicate this when creating new actor types. | **DEFAULT** |
| Station2Victim | `Experiments/ActorTestScene/Station2Victim.hstf` | Passive one-hit-kill NPC for the `Experiments/ActorTestScene/ActorTestScene.hstf` death/respawn station. `BaseActor.hstf` plus an `ActorSdkTagComponent` tagged `s2_victim`, with `maxHealth` 10 and `despawnTimer` 3. Spawned by `ActorSpawner`, never scene-placed | Station-specific |

## Why station actors need their own templates

A template instance configured in a scene carries its settings in a per-instance
delta. A SPAWNED instance has no delta — `ActorSpawner` instantiates the template
as authored — so anything a spawned actor needs must be baked into its own
template file. That includes `ActorSdkTagComponent`, which `BaseActor.hstf` does
not carry at all (scene instances add it by delta), and without which no attacker
can acquire the spawned actor.
