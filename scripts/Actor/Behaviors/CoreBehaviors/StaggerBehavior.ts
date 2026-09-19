/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v2

import type {TemplateAsset, Vec3} from 'meta/worlds';
import {ActorBehavior, TransformComponent} from 'meta/worlds';
import type {ActorController} from 'meta/worlds';
import {
  ActorMovementControllerTypeId,
  ActorMoveParams,
  type ActorMovementController,
} from 'meta/worlds';
import {ActorBodyDirectionControllerTypeId} from 'meta/worlds';
import {
  IActorAttackControllerTypeId,
  type IActorAttackController,
} from '../../Controllers/Definitions/IActorAttackController';
import type {IActorInterruptibleAttack} from '../../Controllers/Definitions/IActorInterruptibleAttack';
import {
  ActorStaggerControllerTypeId,
  ActorStaggerParams,
  type ActorStaggerController,
} from 'meta/worlds';
import {
  ActorHealthControllerTypeId,
  type ActorHealthController,
} from 'meta/worlds';
import type {IActorStaggerImpulseReceiver} from '../../Controllers/Definitions/IActorStaggerImpulseReceiver';
import type {IActorLastAttackerProvider} from '../../Controllers/Definitions/IActorLastAttackerProvider';

/**
 * StaggerBehavior temporarily prevents the Actor from moving, rotating, or attacking
 * when damage is received.
 *
 * This behavior:
 * - Polls the ActorHealthController for hit state changes
 * - Takes over Move, BodyDirection, Attack, and Stagger controller priorities during stagger
 * - Does nothing with Move/BodyDirection/Attack controllers (the Actor stands still)
 * - Pushes stagger parameters to the ActorStaggerController on first use
 * - Automatically ends after staggerDuration completes
 * - Cannot re-activate until staggerCooldown time passes after recovery
 *
 * The behavior uses a high base priority (default 100) to override other behaviors
 * like FollowBehavior or AttackEntityInRangeBehavior during the stagger window.
 */
export class StaggerBehavior extends ActorBehavior {
  /**
   * The knockback force applied to the Actor when hit, in meters per second.
   * Delivered to the stagger controller via setStaggerParams(); the impulse
   * itself is triggered from onHitDetected().
   */
  knockbackForce: number = 5;

  /**
   * The duration the Actor is staggered and unable to perform actions, in seconds.
   */
  staggerDuration: number = 0.3;

  /**
   * Time after recovery before the Actor can be staggered again, in seconds.
   */
  staggerCooldown: number = 0.5;

  /**
   * Time to reach the knockback destination, in seconds.
   * Reserved for future use.
   */
  knockbackMoveTime: number = 0.15;

  /**
   * Template asset for hit impact VFX spawned when enemy takes damage.
   */
  hitImpactVfx: TemplateAsset | null = null;

  protected isStaggerActive: boolean = false;
  protected staggerEndTime: number = 0;
  protected nextStaggerAllowedTime: number = 0;
  protected currentTime: number = 0;
  private wasHit: boolean = false;

  override update(deltaTime: number): void {
    this.currentTime += deltaTime;

    // Poll the health controller for hit state via the behavior manager
    const healthControllers = this.behaviorManager?.getControllers<ActorHealthController>(
      ActorHealthControllerTypeId,
    );
    healthControllers?.forEach(healthController => {
      const data = healthController.getHealthData();
      if (data.isHit && !this.wasHit) {
        this.onHitDetected();
      }
      this.wasHit = data.isHit;
    });

    if (this.isStaggerActive && this.currentTime >= this.staggerEndTime) {
      this.isStaggerActive = false;
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType === ActorStaggerControllerTypeId) {
      return this.basePriority;
    }

    if (!this.isStaggerActive) {
      return -1;
    }

    if (
      controllerType === ActorMovementControllerTypeId ||
      controllerType === ActorBodyDirectionControllerTypeId ||
      controllerType === IActorAttackControllerTypeId
    ) {
      return this.basePriority;
    }

    return -1;
  }

  override useController(
    controllerType: string,
    controller: ActorController,
  ): void {
    if (controllerType === ActorStaggerControllerTypeId) {
      const staggerController = controller as ActorStaggerController;
      if (!staggerController.areStaggerParamsInitialized()) {
        staggerController.setStaggerParams(
          new ActorStaggerParams(
            this.knockbackForce,
            this.staggerDuration,
            this.staggerCooldown,
            this.knockbackMoveTime,
            this.hitImpactVfx,
          ),
        );
      }
    }

    if (controllerType === ActorMovementControllerTypeId) {
      (controller as ActorMovementController).moveToPosition(
        new ActorMoveParams(null, null),
      );
    }

    // BodyDirection: claiming the controller at high priority is sufficient
    // to prevent other behaviors from rotating the Actor.
    // Attack: intentionally empty — stagger means the Actor does not attack.
  }

  protected onHitDetected(): void {
    if (this.currentTime < this.nextStaggerAllowedTime) {
      return;
    }

    this.isStaggerActive = true;
    this.staggerEndTime = this.currentTime + this.staggerDuration;
    this.nextStaggerAllowedTime =
      this.currentTime + this.staggerDuration + this.staggerCooldown;

    this.interruptInFlightAttack();
    this.applyStaggerImpulse();
  }

  /**
   * Cuts off a swing the actor had already started, on any attack controller
   * that supports it.
   *
   * The priority claim in getControllerUsePriority() only stops the manager
   * handing the attack controller to another behavior — it cannot reach an
   * attack that is already running, which is why useController() can leave the
   * attack case empty and still let an in-flight swing play to completion. This
   * is the part that actually stops it.
   *
   * Called from onHitDetected() rather than update() so it inherits the stagger
   * cooldown gate above: a hit landing inside the recovery window does not
   * interrupt, which reads as brief poise after a stagger rather than as an
   * actor that can be perpetually locked down by fast chip damage.
   *
   * Two entry points, because neither method is on the SDK's
   * `IActorAttackController`, so both have to be feature-detected (same reason
   * as applyStaggerImpulse()):
   *
   *  - `interruptAttack()` is preferred. It applies the pre-contact rule, so an
   *    attack whose damage has already resolved is left alone.
   *  - `cancelAttack()` is the fallback for a controller that does not
   *    implement {@link IActorInterruptibleAttack}.
   *
   * `ActorAnimatedAttackComponent`, the only attack controller this package
   * ships, implements `interruptAttack()` for both of its delivery modes — the
   * pending-delivery timer it inspects is the melee contact tick or the
   * projectile release, whichever the mode scheduled. The fallback therefore
   * only matters for a controller from outside this package; it is kept because
   * a bare `interruptAttack` probe that finds nothing reports nothing, so
   * without the branch such a controller would keep attacking through a
   * stagger, silently.
   *
   * Preferring `interruptAttack()` when both exist keeps the shipped controller
   * on its stricter path — its `cancelAttack()` is the unconditional
   * hard-cancel used by teardown and death.
   *
   * Iterating every registered controller (rather than the first) is
   * deliberate: `getControllers` returns a bucket, and an actor could carry a
   * controller from elsewhere alongside this one.
   */
  protected interruptInFlightAttack(): void {
    const attackControllers =
      this.behaviorManager?.getControllers<IActorAttackController>(
        IActorAttackControllerTypeId,
      );
    attackControllers?.forEach(attackController => {
      const interruptible = attackController as Partial<IActorInterruptibleAttack> &
        Partial<{cancelAttack: () => void}>;
      if (typeof interruptible.interruptAttack === 'function') {
        interruptible.interruptAttack();
      } else if (typeof interruptible.cancelAttack === 'function') {
        interruptible.cancelAttack();
      }
    });
  }

  /**
   * Fires the knockback impulse on any stagger controller that accepts one.
   *
   * This is the only place that knows a stagger is STARTING. setStaggerParams()
   * cannot carry the signal: getControllerUsePriority() above returns
   * basePriority for the stagger controller unconditionally, so the manager
   * grants it on the first frame, and useController() pushes params only while
   * areStaggerParamsInitialized() is false — once, before any damage. Driving
   * the impulse from there applied it at spawn and never again.
   *
   * Feature-detected rather than required, since the SDK's
   * ActorStaggerController interface has no such method: a controller that only
   * consumes the config push is left alone.
   */
  protected applyStaggerImpulse(): void {
    const knockback = this.resolveKnockbackFromAttacker();
    const staggerControllers =
      this.behaviorManager?.getControllers<ActorStaggerController>(
        ActorStaggerControllerTypeId,
      );
    staggerControllers?.forEach(staggerController => {
      const receiver =
        staggerController as Partial<IActorStaggerImpulseReceiver>;
      if (typeof receiver.applyStaggerImpulse === 'function') {
        receiver.applyStaggerImpulse(
          knockback?.attackerPosition ?? null,
          knockback?.forceScale,
        );
      }
    });
  }

  /**
   * Resolves the world position of whoever just hit this actor, plus the impulse
   * scale that attacker asked for. The receiver turns the position into a
   * direction; this behavior only supplies the source.
   *
   * Feature-detected on the health controller for the same reason the impulse
   * itself is feature-detected on the stagger controller: the SDK's
   * `ActorHealthController` exposes only `getHealthData()`, whose
   * `ActorHealthControllerData` has no attacker field. See
   * {@link IActorLastAttackerProvider}.
   *
   * Returns null when the source is unknown -- no provider, no recorded attacker
   * for this hit, a destroyed attacker, or an attacker with no transform. The
   * caller forwards that as the explicit `null` source, which selects the
   * receiver's facing fallback: what every stagger did before this.
   */
  private resolveKnockbackFromAttacker():
    | {attackerPosition: Vec3; forceScale: number}
    | null {
    const healthControllers =
      this.behaviorManager?.getControllers<ActorHealthController>(
        ActorHealthControllerTypeId,
      );
    if (!healthControllers) {
      return null;
    }

    for (const healthController of healthControllers) {
      const provider = healthController as Partial<IActorLastAttackerProvider>;
      if (typeof provider.getLastAttacker !== 'function') {
        continue;
      }
      const attacker = provider.getLastAttacker();
      if (!attacker || !attacker.valid) {
        continue;
      }
      const attackerPosition =
        attacker.getComponent(TransformComponent)?.worldPosition;
      if (!attackerPosition) {
        continue;
      }

      const forceScale =
        typeof provider.getLastKnockbackMultiplier === 'function'
          ? provider.getLastKnockbackMultiplier()
          : 1;
      return {attackerPosition, forceScale};
    }

    return null;
  }
}
