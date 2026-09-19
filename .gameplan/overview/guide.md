# Overview Guide

## Purpose
The overview provides a high-level dashboard for the 3D Template V2 project. It surfaces the project's identity, links to all modules, and exposes the most critical tunable parameters for quick iteration.

## Design Intent
Give designers a single landing page that communicates what the template is, how it's organized, and which parameters matter most for feel tuning.

## UI Rules
Layout: overview
Appearance: no

## Source Files
- `scripts/Character/Abilities/MovementAbility.ts` -- move speed, acceleration
- `scripts/Character/Abilities/JumpAbility.ts` -- jump impulse
- `scripts/Camera/CameraManager.ts` -- camera distance, FOV, camera mode

## Quick Tune Properties

### Move Speed
- Type: Numeric
- Keywords: movement, speed, locomotion
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/Character/Abilities/MovementAbility.ts
  class: MovementAbility
  property: moveSpeed
  scope: singleton
  template: Templates/PlayerCharacter.hstf
  entity: PlayerCharacter
  tags: [responsiveness, feel]
```

### Jump Impulse
- Type: Numeric
- Keywords: jump, impulse, height
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/Character/Abilities/JumpAbility.ts
  class: JumpAbility
  property: jumpImpulse
  scope: singleton
  template: Templates/PlayerCharacter.hstf
  entity: PlayerCharacter
  tags: [feel]
```

### Camera Distance
- Type: Numeric
- Keywords: camera, distance, zoom
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/Camera/CameraManager.ts
  class: CameraManager
  property: targetDistance
  scope: singleton
  template: space.hstf
  entity: Camera
  tags: [feel]
```

### Field of View
- Type: Numeric
- Keywords: camera, FOV, field of view
- UI Type: slider
- UI Group: Tune

```yaml
- script: scripts/Camera/CameraManager.ts
  class: CameraManager
  property: fieldOfView
  scope: singleton
  template: space.hstf
  entity: Camera
  tags: [feel]
```
