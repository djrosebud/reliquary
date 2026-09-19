# Writing actor scripts: imports and entity references

Both mistakes below cause **silent runtime failure** — the world builds and runs,
but the actor logic never executes and nothing in the scene surfaces an error.
They apply to **every** actor script you write: behaviors, starter components, and
runtime spawners alike.

## Import SDK symbols from `meta/worlds`; import checked-in framework files by relative path

There are two distinct sources, and confusing them breaks script ingestion:

- **SDK built-ins** — `ActorSdkLogicComponent`, `Component`, `component`,
  `property`, `subscribe`, `Service`, `NetworkingService`, `PlayerService`,
  `EventService`, `TransformComponent`, `Vec3`, `Entity`, `Maybe`, event types,
  `ActorSdkBlackboardManager`, `PickupItemSlot`, … — import from **`'meta/worlds'`**.
- **Framework files checked in** to the project under `scripts/Actor/…`
  (behaviors like `GotoBehavior` / `FollowBehavior` / `EngageCombatBehavior`,
  controllers like `ActorTransformMoveComponent`, blackboards) — import by a
  **relative path** to the file, e.g.
  `import {GotoBehavior} from '../Actor/Behaviors/GotoBehavior';`.

**`ActorSdkLogicComponent` is a `meta/worlds` built-in — never import it from a
local `scripts/Actor/...` path.** No such file exists, so ingestion fails with
`Could not create manifest target from script import string '../Actor/Core/ActorSdkLogicComponent'`
and the entire script — and the component it defines — silently never loads.
Correct: `import {ActorSdkLogicComponent} from 'meta/worlds';`.

## Wire entity-reference properties to the placed instance, and VERIFY they resolve

When a script references another scene entity — a spawner's `tentEntity`, a
"flee from this entity" target, a patrol anchor — it uses an
`@property() foo: Entity | null` that the entity-reference link populates, keyed
by the target entity's **id**.

- **Never hardcode or guess an entity id.** The link must point at the **placed
  instance's** id (e.g. `CampTent_0`), not the template's id and not an id you
  invented. A scene-placed prefab instance carries a suffix (`CampTent` template
  → `CampTent_0` instance); referencing the template id or a stale id leaves the
  link dangling.
- **Prefer resolving the reference at runtime by tag or name** (query the placed
  instance) over baking an id into the property, so the wiring survives
  re-placement.
- **VERIFY the reference resolves.** Null-check it on start and log or fail if it
  is unresolved — do not silently proceed. A dangling reference logs
  `In <Component> failed to find entity reference target <id> in entities` at
  runtime and disables everything downstream of it (e.g. a distance-gated spawner
  that can never read the landmark's position, so it never spawns).
