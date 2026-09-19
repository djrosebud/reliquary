/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Camera Scripts v1

/**
 * Camera collision avoidance, shared by every orbiting camera mode.
 *
 * Mirrors MHE's C++ CameraCollision: the camera pulls in to the closest
 * obstruction between the pivot and the desired orbit position, holds there,
 * then eases back out once the obstruction clears.
 */

import {
  CastMode,
  CollisionLayer,
  PhysicsBodyComponent,
  PhysicsBodyType,
  PhysicsService,
  SceneHitData,
  Vec3,
  lerp,
} from 'meta/worlds';
import type {Entity, RayCastInput} from 'meta/worlds';

enum CameraCollisionState {
  NoCollision,
  Collided,
  WaitingToReturn,
  Returning,
}

export interface CameraCollisionQuery {
  pivotPosition: Vec3;
  desiredCameraPosition: Vec3;
  /** Target's largest world-scale axis; scales the cast distance with the rig. */
  scale: number;
  deltaTime: number;
  /** Excluded from hits so the player's own body never pushes the camera in. */
  targetEntity: Entity | null;
}

const RETURN_DELAY = 0.5;
const RETURN_DURATION = 0.75;

export class CameraCollision {
  private state: CameraCollisionState = CameraCollisionState.NoCollision;
  private currentCollisionDistance: number = 0;
  private closestCollisionDistance: number = 0;
  private uncollidedDistance: number = 0;
  private returnTimer: number = 0;
  private collisionFactor: number = 0;
  private collisionLayerMask: number = 0;
  private cachedRaycastResult: {hasCollision: boolean; hitDistance: number} = {
    hasCollision: false,
    hitDistance: 0,
  };
  // Monotonic id so an older raycast that resolves after a newer one cannot
  // overwrite the fresher result (one raycast is dispatched per frame).
  private raycastGeneration: number = 0;

  public numRaycastAttempts: number = 9;
  public collisionLayers: readonly CollisionLayer[] = [CollisionLayer.Layer2];

  constructor() {
    this.rebuildLayerMask();
  }

  public rebuildLayerMask(): void {
    this.collisionLayerMask = 0;
    for (const layer of this.collisionLayers) {
      this.collisionLayerMask |= 1 << layer;
    }
  }

  public reset(): void {
    this.state = CameraCollisionState.NoCollision;
    this.currentCollisionDistance = 0;
    this.closestCollisionDistance = 0;
    this.uncollidedDistance = 0;
    this.returnTimer = 0;
    this.collisionFactor = 0;
    this.cachedRaycastResult = {hasCollision: false, hitDistance: 0};
    this.raycastGeneration++;
  }

  /**
   * Returns the obstruction-adjusted camera position.
   *
   * Consumes the previous frame's raycast and dispatches a new one for the
   * next. The one-frame lag is imperceptible because the state machine already
   * smooths the transition, and it keeps the update loop synchronous.
   */
  public resolve(query: CameraCollisionQuery): Vec3 {
    const {pivotPosition, desiredCameraPosition, deltaTime} = query;
    if (this.collisionLayerMask === 0) {
      return desiredCameraPosition;
    }

    const direction = desiredCameraPosition.sub(pivotPosition);
    this.uncollidedDistance = direction.magnitude();
    if (this.uncollidedDistance < 0.001) {
      return desiredCameraPosition;
    }
    const rayDirection = direction.normalize();
    this.currentCollisionDistance = this.uncollidedDistance;

    if (this.cachedRaycastResult.hasCollision) {
      this.currentCollisionDistance = Math.max(
        0,
        Math.min(this.cachedRaycastResult.hitDistance, this.uncollidedDistance),
      );
    }

    void this.dispatchRaycast(query, rayDirection, this.uncollidedDistance);

    this.updateState(this.cachedRaycastResult.hasCollision, deltaTime);

    const collidedPosition = pivotPosition.add(
      rayDirection.mul(this.closestCollisionDistance),
    );
    return Vec3.lerp(
      desiredCameraPosition,
      collidedPosition,
      this.collisionFactor,
    );
  }

  private async dispatchRaycast(
    query: CameraCollisionQuery,
    direction: Vec3,
    distance: number,
  ): Promise<void> {
    const generation = ++this.raycastGeneration;
    const result = await this.raycastToClosestObstruction(
      query,
      direction,
      distance,
    );
    // Discard if a newer raycast was dispatched while this one was in flight.
    if (generation === this.raycastGeneration) {
      this.cachedRaycastResult = result;
    }
  }

  private async raycastToClosestObstruction(
    query: CameraCollisionQuery,
    direction: Vec3,
    distance: number,
  ): Promise<{hasCollision: boolean; hitDistance: number}> {
    const {pivotPosition: origin, scale, targetEntity} = query;
    try {
      const raycastInput: RayCastInput = {
        origin,
        dir: direction,
        distance: distance * scale,
        mode: CastMode.UnsortedHits,
        maxUnsortedHits: this.numRaycastAttempts,
        collisionLayerMask: this.collisionLayerMask,
      };

      const castOutput = await PhysicsService.get().rayCast(raycastInput);

      if (
        castOutput.hasHitSomething &&
        castOutput.hits &&
        castOutput.hits.length > 0
      ) {
        let closestHit: SceneHitData | null = null;
        for (const hit of castOutput.hits) {
          if (
            hit.actorEntity === targetEntity ||
            hit.shapeEntity === targetEntity
          ) {
            continue;
          }

          // Only static geometry should push the camera in; a moving prop
          // would otherwise yank the view every time it passed behind.
          const physicsBody =
            hit.actorEntity?.getComponent(PhysicsBodyComponent);
          if (
            physicsBody &&
            physicsBody.type !== PhysicsBodyType.StaticCollision
          ) {
            continue;
          }

          if (closestHit === null || hit.distance < closestHit.distance) {
            closestHit = hit;
          }
        }

        if (closestHit) {
          return {
            hasCollision: true,
            hitDistance: Math.min(closestHit.distance, distance),
          };
        }
      }
    } catch (error) {
      console.error('[CameraCollision] raycast failed:', error);
    }

    return {hasCollision: false, hitDistance: 0};
  }

  private updateState(isColliding: boolean, deltaTime: number): void {
    if (
      isColliding &&
      (this.state === CameraCollisionState.NoCollision ||
        this.requiresNewCollision())
    ) {
      this.triggerNewCollision();
      return;
    }

    switch (this.state) {
      case CameraCollisionState.NoCollision:
        break;

      case CameraCollisionState.Collided:
        this.state = CameraCollisionState.WaitingToReturn;
        this.returnTimer = RETURN_DELAY;
        break;

      case CameraCollisionState.WaitingToReturn:
        this.returnTimer -= deltaTime;
        if (this.returnTimer <= 0) {
          this.state = CameraCollisionState.Returning;
          this.returnTimer = RETURN_DURATION;
        }
        break;

      case CameraCollisionState.Returning: {
        this.returnTimer = Math.max(0, this.returnTimer - deltaTime);
        const t = this.returnTimer / RETURN_DURATION;
        this.collisionFactor = smoothStep(t);

        if (this.returnTimer === 0) {
          if (isColliding && this.requiresNewCollision()) {
            this.triggerNewCollision();
          } else {
            this.state = CameraCollisionState.NoCollision;
            this.closestCollisionDistance = 0;
          }
        }
        break;
      }
    }
  }

  private requiresNewCollision(): boolean {
    return this.currentCollisionDistance <= this.getReturningDistance();
  }

  private getReturningDistance(): number {
    return lerp(
      this.uncollidedDistance,
      this.closestCollisionDistance,
      this.collisionFactor,
    );
  }

  private triggerNewCollision(): void {
    this.state = CameraCollisionState.Collided;
    this.closestCollisionDistance = this.currentCollisionDistance;
    this.returnTimer = 0;
    this.collisionFactor = 1;
  }
}

function smoothStep(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
