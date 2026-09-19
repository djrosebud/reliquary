/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v2

/**
 * Optional extension for an attack controller whose in-flight attack can be
 * aborted by an incoming hit.
 *
 * `IActorAttackController` carries only `attack()` / `canAttack()`, and the
 * priority claim StaggerBehavior already makes on it merely stops the manager
 * handing the controller to another behavior — it cannot reach back into an
 * attack that is already running. So a swing in flight keeps its timers and
 * plays to completion no matter how hard the actor is hit.
 *
 * A controller that wants the pre-contact rule implements this interface;
 * StaggerBehavior calls it from `onHitDetected()`, the one place that already
 * knows a stagger is beginning. Same arrangement, and for the same reason, as
 * {@link IActorStaggerImpulseReceiver}.
 *
 * Implementing it is optional. The one attack controller this package ships,
 * `ActorAnimatedAttackComponent`, does implement it, and covers BOTH of its
 * delivery modes through the same timer set — aborting a throw before the
 * projectile spawns is the same pre-contact guarantee as aborting a swing
 * before it connects. (Ranged used to sit in a separate generated component
 * that could not take this interface, so StaggerBehavior had to fall back to
 * `cancelAttack()` to stop a staggered ranged actor firing. The two controllers
 * were merged; the fallback below is now only for a controller from outside
 * this package.)
 */
export interface IActorInterruptibleAttack {
    /**
     * Aborts an in-flight attack that has NOT yet reached its contact frame,
     * cancelling both its animation and the damage it would have dealt.
     *
     * The pre-contact restriction is what keeps two evenly-matched actors from
     * deadlocking: if any hit could void a swing at any point, two NPCs trading
     * on the same cadence would cancel each other forever and neither would
     * ever land. Gating on contact means whoever connects first still resolves,
     * and only the slower swing is lost.
     *
     * Returns true when a swing was actually aborted, so a caller can tell
     * "interrupted" apart from "there was nothing to interrupt" and from
     * "contact had already resolved" — all three are ordinary outcomes, not
     * failures.
     */
    interruptAttack(): boolean;
}
