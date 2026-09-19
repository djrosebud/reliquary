/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v1

import {
    component,
    Component,
    subscribe,
    OnEntityCreateEvent,
    OnEntityDestroyEvent,
    property,
    editor,
    Vec3,
    TransformComponent,
    ExecuteOn,
    type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import { CharacterForceControllerBase } from '../../../Character/Force/CharacterForceControllerBase';
import {
    ActorStaggerControllerTypeId,
    ActorStaggerParams,
    type ActorStaggerController,
} from 'meta/worlds';
import type {IActorStaggerImpulseReceiver} from '../Definitions/IActorStaggerImpulseReceiver';

// Matches StaggerBehavior.knockbackForce's own default, so an actor whose
// params never arrive behaves the same as one configured with the defaults.
const DEFAULT_KNOCKBACK_FORCE = 5;

// Below this XZ separation the attacker and victim are effectively stacked, so
// the away-from-attacker vector is noise and the facing fallback is used.
const MIN_KNOCKBACK_SEPARATION_M = 1e-3;

// Below this the actor's facing has no meaningful XZ component (it is looking
// straight up or down), so there is no horizontal direction to push it along.
// Same numeric value as the separation floor above, deliberately named apart:
// one is a distance between two actors, the other the length of a direction
// vector, and they would not necessarily move together.
const MIN_FACING_XZ_MAGNITUDE = 1e-3;

/**
 * Knockback executor for a staggered actor. Pure executor: StaggerBehavior owns
 * the stagger window and the cooldown gate, and calls applyStaggerImpulse()
 * once per stagger from onHitDetected(). This controller holds no timers and no
 * stagger state of its own — a second copy of that bookkeeping here could only
 * drift from the behavior's.
 *
 * Knockback only. The hit REACTION ANIMATION belongs to
 * CharacterGASComponent, which asks the entity's CharacterAnimationController for
 * it; that controller replicates the reaction, so it plays on every client.
 * Driving that layer from here too would put two independent clocks on one
 * state machine, and this controller's paths are owner-only.
 *
 * `setStaggerParams()` is a one-time CONFIG push, NOT a stagger event — see
 * {@link IActorStaggerImpulseReceiver} for why, and why the impulse is
 * triggered from StaggerBehavior instead.
 *
 * StaggerBehavior supplies the ATTACKER POSITION and this controller derives the
 * direction from it, pushing directly away; a `null` source selects the actor's
 * own `-worldForward` as the fallback. The MAGNITUDE is `knockbackForce` from
 * the config push, scaled by the attacker's per-hit multiplier.
 *
 * The impulse goes through `CharacterForceControllerBase.addVelocity()` on the
 * simulated body, NOT `PhysicsBodyComponent.linearVelocity`. This character is
 * KCC-driven: `ActorTransformMoveComponent` moves it with `addMoveDelta()` and
 * `KinematicForceController` owns velocity integration, so the force controller
 * is the only channel that actually moves it. That is also what decelerates the
 * impulse — the force controller applies gravity and ground friction to the
 * velocity each frame — and it is the same call `JumpAbility` uses.
 */
@component({
    description: 'Applies a knockback impulse when StaggerBehavior staggers the actor. Hit animation is owned by CharacterGASComponent.',
})
export class ActorPhysicalStaggerController
    extends Component
    implements ActorStaggerController, IActorStaggerImpulseReceiver
{
    @property()
    @editor({ description: 'Optional entity carrying the character\'s CharacterForceControllerBase (the simulated body, e.g. "KinematicCharacter"). If null, this entity and then its children are searched, so the common single- and two-entity layouts both work without setting it.' })
    simulatedEntity: Entity | null = null;

    @property()
    @editor({ description: 'Enable debug logging.' })
    debugLogEnabled: boolean = false;

    private actorLogicComponent: ActorSdkLogicComponent | null = null;
    private transformComponent: TransformComponent | null = null;
    private forceController: CharacterForceControllerBase | null = null;
    // One-shot: a missing force controller costs knockback on every stagger.
    private missingForceControllerWarned: boolean = false;
    private missingTransformWarned: boolean = false;

    // Config pushed once by StaggerBehavior via setStaggerParams().
    private paramsInitialized: boolean = false;
    private knockbackForce: number = DEFAULT_KNOCKBACK_FORCE;

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
    onCreate() {
        this.transformComponent = this.entity.getComponent(TransformComponent);
        this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
        this.forceController = null;
        // Everything below is per-life state, reset alongside the resolved
        // component cache. A pooled/recycled entity would otherwise inherit the
        // previous actor's config and stay permanently silent on diagnostics
        // whose underlying state was just invalidated:
        //  - paramsInitialized latched true makes StaggerBehavior skip its
        //    config push (it only pushes while areStaggerParamsInitialized() is
        //    false), so knockbackForce would keep the prior actor's value.
        //  - the one-shot warn flags would suppress a genuine new failure.
        this.paramsInitialized = false;
        this.knockbackForce = DEFAULT_KNOCKBACK_FORCE;
        this.missingForceControllerWarned = false;
        this.missingTransformWarned = false;

        if (this.entity.isOwned()) {
            this.registerActorController();
        }
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        this.unregisterActorController();
    }

    // ── ActorStaggerController ──────────────────────────────────────

    areStaggerParamsInitialized(): boolean {
        return this.paramsInitialized;
    }

    /**
     * Config only. StaggerBehavior calls this once, on its first grant of this
     * controller, which happens before any damage — nothing here may assume a
     * stagger is starting.
     */
    setStaggerParams(params: ActorStaggerParams): void {
        this.knockbackForce = params.knockbackForce;
        this.paramsInitialized = true;

        if (this.debugLogEnabled) {
            console.log(`[PhysicalStaggerCtrl] Params received: force=${this.knockbackForce}`);
        }
    }

    // ── IActorStaggerImpulseReceiver ─────────────────────────────────

    /**
     * Applies a one-shot velocity impulse to the staggered NPC, pushing it
     * directly away from `attackerPosition` so a flank or rear hit knocks it the
     * correct way.
     *
     * A `null` source (no {@link IActorLastAttackerProvider} on the health
     * component, a damage source that recorded no attacker, or a destroyed
     * attacker) selects the facing fallback: backward along the actor's own
     * `-worldForward`, right only for a head-on hit, and what every stagger did
     * before the provider existed. Two actors standing within
     * `MIN_KNOCKBACK_SEPARATION_M` of each other take the same fallback, since
     * the away-vector is noise at that separation.
     *
     * Added to the force controller's velocity rather than written over it, so
     * an in-flight fall or existing motion is preserved; the controller's own
     * gravity and ground friction decelerate it from there.
     */
    applyStaggerImpulse(attackerPosition: Vec3 | null, forceScale?: number): void {
        // Both resolvers return a UNIT vector or null, so the magnitude is
        // computed exactly once per stagger, inside whichever one ran.
        const awayFromAttacker = this.resolveAwayFromAttackerDirection(attackerPosition);
        const knockbackDir = awayFromAttacker ?? this.resolveFacingKnockbackDirection();
        if (!knockbackDir) {
            return;
        }

        const forceController = this.resolveForceController();
        if (!forceController) {
            if (!this.missingForceControllerWarned) {
                this.missingForceControllerWarned = true;
                console.warn(`[PhysicalStaggerCtrl] No CharacterForceControllerBase found on '${this.entity.name}', its simulatedEntity, or its children — the actor still staggers but no knockback is applied. Point simulatedEntity at the character's simulated body.`);
            }
            return;
        }

        // Scale is the attacker's per-hit multiplier; undefined means unscaled.
        const scaledForce = this.knockbackForce * (forceScale ?? 1);
        const impulse = knockbackDir.mul(scaledForce);
        forceController.addVelocity(impulse);

        if (this.debugLogEnabled) {
            const source = awayFromAttacker ? 'attacker' : 'facing';
            // Log the APPLIED impulse, not the resolved direction. Neither
            // knockbackForce nor forceScale is clamped, so a negative on either
            // inverts the push into a pull; printing the unit vector would claim
            // the actor was knocked away while it was actually dragged in.
            console.log(`[PhysicalStaggerCtrl] Knockback: impulse=(${impulse.x.toFixed(2)}, ${impulse.z.toFixed(2)}) src=${source}, force=${scaledForce}`);
        }
    }

    /**
     * UNIT direction from the attacker to this actor, flattened to XZ. Null when
     * the source is unknown, when this actor has no transform to measure from, or
     * when the two are close enough that the vector carries no usable bearing --
     * each of which sends the caller to the facing fallback.
     */
    private resolveAwayFromAttackerDirection(attackerPosition: Vec3 | null): Vec3 | null {
        if (!attackerPosition || !this.transformComponent) {
            return null;
        }
        const selfPosition = this.transformComponent.worldPosition;
        const dx = selfPosition.x - attackerPosition.x;
        const dz = selfPosition.z - attackerPosition.z;
        const magnitude = Math.sqrt(dx * dx + dz * dz);
        if (magnitude < MIN_KNOCKBACK_SEPARATION_M) {
            return null;
        }
        return new Vec3(dx / magnitude, 0, dz / magnitude);
    }

    /**
     * The pre-provider heuristic: push the actor backward along its own facing,
     * as a UNIT vector. Null when the transform never resolved, and null when the
     * facing has no meaningful XZ component (an actor looking straight up or
     * down) -- there is no horizontal direction to push along in either case.
     */
    private resolveFacingKnockbackDirection(): Vec3 | null {
        if (!this.transformComponent) {
            // Eagerly resolved in onCreate and never retried, unlike the force
            // controller — warn rather than fail silently, since the symptom
            // (no knockback) is identical to a missing force controller.
            if (!this.missingTransformWarned) {
                this.missingTransformWarned = true;
                console.warn(`[PhysicalStaggerCtrl] No TransformComponent on '${this.entity.name}' — no knockback can be applied.`);
            }
            return null;
        }
        const forward = this.transformComponent.worldForward;
        const dx = -forward.x;
        const dz = -forward.z;
        const magnitude = Math.sqrt(dx * dx + dz * dz);
        if (magnitude < MIN_FACING_XZ_MAGNITUDE) {
            return null;
        }
        return new Vec3(dx / magnitude, 0, dz / magnitude);
    }

    /**
     * Resolves the character's force controller through the same fallback chain
     * shape as resolveAnimatorComponent: explicit entity, then this entity, then
     * immediate children. The child search is what makes the two-entity layout
     * (root + simulated body) work with nothing set on the template.
     */
    private resolveForceController(): CharacterForceControllerBase | null {
        if (this.forceController) {
            return this.forceController;
        }

        if (this.simulatedEntity !== null) {
            const explicit = this.simulatedEntity.getComponent(CharacterForceControllerBase);
            if (explicit) {
                this.forceController = explicit;
                return explicit;
            }
        }

        const own = this.entity.getComponent(CharacterForceControllerBase);
        if (own) {
            this.forceController = own;
            return own;
        }

        const children = this.entity.getChildrenWithComponent(CharacterForceControllerBase);
        if (children.length > 0) {
            const child = children[0].getComponent(CharacterForceControllerBase);
            if (child) {
                this.forceController = child;
                return child;
            }
        }

        return null;
    }

    // ── Controller Registration ──────────────────────────────────────

    registerActorController(): void {
        this.actorLogicComponent?.registerController(ActorStaggerControllerTypeId, this);
    }

    unregisterActorController(): void {
        this.actorLogicComponent?.unregisterController(this);
    }
}
