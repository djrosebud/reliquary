/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {
  Component,
  component,
  OnTriggerEnterEvent,
  OnWorldUpdateEvent,
  subscribe,
  TransformComponent,
} from 'meta/worlds';
import type {
  Entity,
  OnTriggerEnterEventPayload,
  OnWorldUpdateEventPayload,
  Vec3,
} from 'meta/worlds';
import {GASComponent} from '../core/GASComponent';
import {straightForward} from './Motion';
import type {MotionStep} from './Motion';

/** Tag-based target filter (uses the target's GAS tags). */
export interface TagFilter {
  required?: string[]; // target must have ALL of these
  blocked?: string[]; // target must have NONE of these
}

/**
 * Configuration for a flying projectile. Hit detection has two modes:
 *  - Trigger mode (default): the projectile is a Trigger volume; on overlap the
 *    entered entity is filtered by `targetFilter` (GAS tags). Works in any 3D
 *    world whose targets are DynamicColliders with GAS tags.
 *  - Logic mode (override): supply `findHit` for worlds with no physics (grid /
 *    lane), and it is polled each frame instead of using trigger events.
 * Everything else (motion, onHit effects, despawn) is shared.
 */
export interface ProjectileConfig {
  speed: number;
  step?: MotionStep; // default: straightForward
  homingTarget?: Entity; // if set, steer toward this entity each frame and hit on arrival
  targetFilter?: TagFilter; // trigger mode: which entities count as a hit
  instigator?: Entity; // the shooter — never counts as a hit (avoids self-hits in PvP)
  onHit: (hit: Entity) => void; // GAS effects applied here
  findHit?: (from: Vec3, to: Vec3) => Entity | null; // override -> logic mode
  lifetimeSec?: number; // despawn after this long (prevents leaks)
  isOutOfBounds?: (pos: Vec3) => boolean; // despawn predicate
}

/**
 * Generic projectile: attach to a projectile template. Moves each frame, detects
 * a hit (a Trigger overlap by default, or a supplied findHit), applies onHit and
 * despawns. No game-specific logic lives here — it is all in config.
 *
 * For target-seeking motion (tower-defense), set `step: homing` + `homingTarget`;
 * the projectile seeks the target and hits via the trigger like any other motion.
 *
 * For trigger mode the template needs a PhysicsBody of type Trigger + a collider
 * (the projectile is moved kinematically, not by physics), and targets need a
 * DynamicCollider + a GASComponent with the filter tags. (Trigger-vs-Trigger and
 * Trigger-vs-Static do not fire events.)
 */
@component({
  description: 'Generic projectile — moves, detects a hit (physics or logic), applies effects.',
})
export class GASProjectile extends Component {
  private config: ProjectileConfig | null = null;
  private transform: TransformComponent | null = null;
  private ageSec: number = 0;

  // Called right after spawn. Until configured (config is null) the projectile
  // stays idle, avoiding a spawn/configure race where events fire before wiring.
  configure(config: ProjectileConfig): void {
    this.config = config;
  }

  @subscribe(OnWorldUpdateEvent)
  onUpdate(payload: OnWorldUpdateEventPayload): void {
    const config = this.config;
    if (!config || this.entity.isDestroyed() || !this.entity.isOwned()) {
      return;
    }
    this.ageSec += payload.deltaTime;
    if (config.lifetimeSec !== undefined && this.ageSec >= config.lifetimeSec) {
      this.entity.destroy();
      return;
    }
    if (!this.transform) {
      this.transform = this.entity.getComponent(TransformComponent);
    }
    if (!this.transform) {
      return;
    }
    const from = this.transform.worldPosition;
    const to = (config.step ?? straightForward)({
      transform: this.transform,
      deltaTime: payload.deltaTime,
      speed: config.speed,
      target: config.homingTarget,
    });
    this.transform.worldPosition = to;

    // Logic mode: synchronous hit test (no physics).
    if (config.findHit) {
      const hit = config.findHit(from, to);
      if (hit) {
        this.hit(hit, config);
        return;
      }
    }
    if (config.isOutOfBounds && config.isOutOfBounds(to)) {
      this.entity.destroy();
    }
  }

  // Trigger mode: projectile is a Trigger volume; fires on overlap with a target.
  @subscribe(OnTriggerEnterEvent)
  onTrigger(payload: OnTriggerEnterEventPayload): void {
    const config = this.config;
    if (!config || config.findHit || this.entity.isDestroyed() || !this.entity.isOwned()) {
      return;
    }
    const other =
      payload.triggerEntity === this.entity ? payload.actorEntity : payload.triggerEntity;
    this.tryHit(other ?? null, config);
  }

  private tryHit(other: Entity | null, config: ProjectileConfig): void {
    if (!other || other.isDestroyed()) {
      return;
    }
    // The collider that fired the trigger is often a DESCENDANT of the entity
    // that holds the GASComponent (e.g. a player's capsule collider under the
    // avatar root). Walk up to the GAS owner before filtering / applying.
    const gasEntity = findGasEntity(other);
    if (!gasEntity) {
      return; // only GAS entities are valid targets
    }
    if (config.instigator && gasEntity === config.instigator) {
      return; // never hit the shooter that fired this projectile
    }
    const gas = gasEntity.getComponent(GASComponent);
    if (!gas) {
      return;
    }
    const filter = config.targetFilter;
    if (filter?.required && filter.required.length > 0 && !gas.hasAllTags(filter.required)) {
      return;
    }
    if (filter?.blocked && filter.blocked.length > 0 && !gas.hasNoneOfTags(filter.blocked)) {
      return;
    }
    this.hit(gasEntity, config);
  }

  private hit(target: Entity, config: ProjectileConfig): void {
    config.onHit(target);
    this.entity.destroy();
  }
}

// Resolve the entity carrying the GASComponent, starting at `entity` and walking
// up its ancestors. Colliders are frequently on descendants of the entity that
// owns the GAS state (e.g. a player capsule under the avatar root), so a direct
// getComponent on the collider entity would miss it.
function findGasEntity(entity: Entity): Entity | null {
  let current: Entity | null = entity;
  while (current) {
    if (current.getComponent(GASComponent)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}
