# 3D Template V2

A ready-to-play third-person game starter. Open it and you can already run
around a floor, jump, and watch the camera follow you with the character
animating properly.

Everything else a small 3D game usually needs — combat, health, enemies,
pathfinding, extra camera angles, click-to-move — is already built and sitting in
the project. Most of it is switched off so the template stays clean. Turning a
feature on is normally one setting, not new code.

Read `Docs/INSTALLED_PACKAGE.md` for the full list of what is on, what is off,
and exactly what each one costs to enable.

## What works the moment you press play

- **Move** — WASD or the left stick. On a phone, touch the bottom half of the
  screen and a stick appears under your thumb wherever you put it. Movement
  follows the camera, so "forward" is wherever you are looking.
- **Jump** — the on-screen Jump button, or the jump key. Has coyote time (a short
  grace period after walking off an edge) and input buffering (an early press
  still counts), so it feels forgiving.
- **Look** — right stick, mouse, or a drag on the top half of the screen. The two
  halves work at once, so you can move and look with two thumbs. The camera
  orbits, avoids clipping through walls, and drifts back behind you when you stop
  steering it.
- **Animation** — idle, walk and run in all directions, and the jump sequence.

## What is built but switched off

You do not need to write these. They are installed and tested; they just are not
turned on, because a starter template should not hand you a screen full of
buttons.

| Feature | To turn it on |
|---------|---------------|
| Melee attack | Assign `MeleeAttackInputConfig` to the `meleeInputConfig` slot on the `PlayerInputServices` entity. The swing, its cooldown and its damage cone are already wired. |
| Click-to-move | Change `locomotionMode` on `PlayerInputServices` from `Joystick` to `ClickToMove`. Tapping the ground then paths the character around obstacles — but only inside the navmesh, which covers just the central 50×50 m of the floor. Grow the navmesh first if you need more. |
| Other camera angles | The camera supports ten styles — first-person, top-down, side-scroller, isometric and more. Call `setMode()` on the `Camera` entity's `CameraManager`. |
| Enemies | Drop `Templates/Actors/BaseActorTemplate/BaseActor.hstf` into your scene, then add `ActorCombatStarterComponent` to give it behaviour. Patrol, chase, flee and attack are all built. |
| Health and damage | Already running. The player has health and can die; enemies have health and react to hits. Nothing damages the player until you place something that does. |
| Picking things up | **Off.** Neither the player nor the enemy carries an `Interactor`, so nothing is detected and the Interact and Drop buttons do not appear. The reaching-out and grabbing code lives in `scripts/Interaction/`. Add an `Interactor` child to the character template to switch it on. |
| Bot players | Stand-in players that spawn from your player template and keep a headcount filled, for testing a world with more than one body in it. Nothing starts them yet. |

## The scene

| Entity | What it does |
|--------|--------------|
| `StartingWorld` | The scene root. Says which template the player spawns as. |
| `Floor` | A 200×200 m plane you walk on. |
| `SpawnPoint` | Where the player appears. |
| `Directional Light` | The sun. |
| `Camera` | The one camera. Handles following, collision and all ten styles — and owns the right-stick/mouse look input. |
| `PlayerInputServices` | Movement and the buttons. This is where you assign `.inputconfig` assets. |
| `TouchControl` | The on-screen stick and buttons, and the drag-to-look area. Split top/bottom for portrait; there is a landscape setting if you need it. |
| `ActorFrameworkServices` | Runs the enemy/NPC system. |
| `NavMesh`, `NavMeshServices` | The walkable map enemies and click-to-move use to find paths. Covers the central 50×50 m only — a small fraction of the floor. |
| `SurfaceObjects` | An empty container for whatever you build. |

## The player character

`Templates/PlayerCharacter.hstf`. It is split into two pieces on purpose:

```
PlayerCharacter          <- decisions: movement, jumping, animation, health
└── KinematicCharacter   <- physics: gravity, collision, standing on ground
    └── Collider
└── Visuals              <- the mesh and its animations
```

Keeping decisions apart from physics means you can swap the physics body at
runtime — turn the character into a ball or a vehicle — without rebuilding the
rest. If you never need that, you can ignore it entirely.

Worth knowing by name:

| On the character | What it is for |
|------------------|----------------|
| `MovementAbility` | How fast you speed up, slow down, and steer in the air |
| `JumpAbility` | Jump height, coyote time, buffering, cooldown |
| `CharacterStateMachine` | Whether the character is moving, jumping, or dead |
| `CharacterAnimationController` | Picks and blends the right animation |
| `CharacterGASComponent` | Health, and dying when it reaches zero |
| `WeaponMeleeComponent` | The melee swing (off until you assign the button) |

## Where things live

| Folder | What is in it |
|--------|---------------|
| `scripts/Character/` | Moving, jumping, physics, ground detection |
| `scripts/animation/` | Driving the animation graph and its layers |
| `scripts/Camera/` | The camera and its ten styles |
| `scripts/Input/` | Buttons and sticks, including the on-screen ones |
| `scripts/Interaction/` | Reaching out, grabbing, carrying and dropping (code only — on no template) |
| `scripts/Locomotion/` | Click-to-move |
| `scripts/gas/` | Health, damage, effects, weapons |
| `scripts/Actor/` | Enemy behaviours — patrol, chase, flee, attack, die |
| `scripts/Navigation/` | Rebuilding the walkable map |
| `scripts/WorldsBotPlayer/` | Spawning stand-in players to fill a world |
| `Templates/` | The player, the enemy, test scenes, and basic shapes to build with |
| `Assets/` | The character model, animations and animation graphs |
| `UI/` | The on-screen control layouts and their button icons |

## How to do common things

**Add a button.** Open `scripts/Input/PlayerActionController.ts`. Add a row to the
`defineActions()` list saying which action it is and what it should do, add a
matching `*InputConfig` property, then assign an `.inputconfig` asset to that
property on the `PlayerInputServices` entity. A button with nothing assigned is
simply skipped, so half-finished work does nothing rather than breaking.

Put every button in that one file. The engine only allows one listener per input
action, so spreading them across components makes two things fight over the same
button.

**Change how movement feels.** Tune `MovementAbility` and `JumpAbility` on
`PlayerCharacter` in the editor. No code needed.

**Change the camera.** Tune `CameraManager` on the `Camera` entity — distance,
height, field of view, smoothing, whether it avoids walls.

**Add an enemy.** Duplicate `Templates/Actors/BaseActorTemplate/BaseActor.hstf`.
On its own the copy stands still; adding `ActorCombatStarterComponent` is what
gives it behaviour, and the behaviour scripts under `scripts/Actor/Behaviors/`
are what it can be given.

**Make the character take damage.** Anything that applies a damage effect to a
target with `CharacterGASComponent` works. The enemy melee attack already does.

**Make something interactable.** It takes both halves. On the object, add
`SimpleInteractablePromptComponent`, and `AttachableObject` on top of that if it
should be picked up and carried. On the character, add an `Interactor` child
carrying `InteractorComponent`, a Trigger physics body, a sphere collider on
Layer3, `InteractionController` and `InteractionControlsBridge`. Without that
child nothing detects the object and no button appears.

## Things that will catch you out

- **The floor ends at ±100 metres.** Build past that and the player falls through.
  Scale the `Floor` entity up first.
- **The navmesh is much smaller than the floor** — ±25 m, against the floor's
  ±100 m. Walking works everywhere; click-to-move and NPC pathing stop at the
  navmesh edge. Widen `generationConfig.halfExtents` on the `NavMesh` entity to
  match whatever you actually build on.
- **A button with no `.inputconfig` assigned never fires.** It is not broken;
  nothing is assigned. Check `PlayerInputServices`.
- **Click-to-move and joystick are either/or.** There is no setting that runs both.
- **A dead character still falls.** Gravity keeps working, so one killed in mid-air
  drops and settles rather than freezing in place.
- **The on-screen controls replace the engine's own.** Turning them off does not
  fall back to the built-in joystick — it leaves a touch player with no way to
  move.
- **The disc shape is spelled `Dics.hstf`.** Not a typo you need to fix — just
  what it is called.

## Test scene

`Templates/Scenes/CameraTest.hstf` — walls and boxes for checking the camera
behaves when things get between it and the player. It does not load by default;
open it when you want to try that.
