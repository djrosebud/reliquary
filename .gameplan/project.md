# 3D Template V2

## Core Idea
summary: A ready-to-play third-person game starter — character, camera, animation, combat and NPCs, with most of it switched off until you want it.

A production-ready starting point for third-person games. Movement, jumping,
camera and animation are live the moment you press play. Combat, health, enemies,
pathfinding, click-to-move and nine further camera styles are already built and
installed, but deliberately not turned on, so the template stays clean. Turning a
feature on is normally one property assignment, not new code. See
`Docs/INSTALLED_PACKAGE.md` for the on/off inventory.

## Gameplay
summary: Move, jump and look around a 3D space with responsive, physics-driven controls.

- **Move** -- Camera-relative WASD/joystick locomotion with smooth acceleration
- **Jump** -- Physics impulse jump with coyote time and input buffering
- **Look** -- Right stick / mouse orbits a collision-aware third-person camera
- **Explore** -- A 200x200 m floor; the navmesh covers the central 50x50 m

Built but off by default: melee attack, click-to-move, combat NPCs, and the nine
non-third-person camera modes.

## Mechanics
summary: Component-based state machine drives movement and jump via modular ability scripts; GAS backs health and damage.

The character uses a two-entity hierarchy (root + simulated body) that cleanly
separates gameplay logic from physics. A rule-based state machine (Movement /
Jumping / Dead) orchestrates ability activation. The camera orbits the player with
angle-space smoothing and collision avoidance, and supports ten modes through one
`CameraManager`. A Gameplay Ability System under `scripts/gas/` backs health,
damage, effects and weapons. NPCs run on the Actor Framework under
`scripts/Actor/`. All character subsystems implement `ICharacterInitializable` for
hot-swappable physics bodies.

## Game Feel
summary: Responsive and snappy with smooth acceleration curves, coyote time, and camera polish.

The template prioritizes responsiveness: acceleration curves prevent floaty
movement, coyote time forgives late jumps, and the camera uses angle-space
smoothing to avoid quaternion oscillation. Designers can tune every parameter —
from jump impulse to camera FOV — without touching code.

## Inspiration
- Classic third-person action games with tight, responsive controls
- Platformers that reward precise movement timing
- Camera systems that stay out of the way while keeping the player visible

## Modules

- **Overview** -- Project identity, module navigation, and key tunable parameters
  includes: overview
- **Player** -- The controllable character and all movement abilities
  includes: player, movement, jump, facing, animation, state_machine, health
- **Camera** -- Third-person camera orbit, smoothing, collision avoidance, and mode switching
  includes: camera
- **Physics** -- Force controllers, ground detection, and physics simulation
  includes: physics, kinematic, dynamic, ground_detection

```yaml
overview:
  type: overview
  owns: [project_identity, module_navigation, aggregate_controls]

player:
  type: gameplay
  owns: [player_character, movement_ability, jump_ability, auto_face_rotation, animation, state_machine, character_health]
  rationale: "The controllable entity and all abilities that drive its behavior."

camera:
  type: system
  owns: [camera_orbit, camera_smoothing, camera_collision, camera_fov, camera_mode]
  rationale: "Third-person camera that follows the player with collision avoidance."

physics:
  type: system
  owns: [force_controller, ground_detection, physics_simulation, body_swapping]
  excludes: [player_character]
  rationale: "Low-level physics: force integration, ground raycasting, and body hot-swap."
```

## Tags

```yaml
responsiveness: "Properties that affect how quickly the character responds to input."
feel: "Properties that affect the overall game feel and player satisfaction."
```

## Relationships
- Player movement reads camera forward direction from the Camera module for camera-relative locomotion
- Physics module provides ground state to the Player module for jump and movement decisions
- State machine in Player module gates ability activation based on ground detection from Physics
- Player health lives on `CharacterGASComponent`; the Dead state blocks movement, jump and facing
