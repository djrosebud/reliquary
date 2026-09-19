/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v1

import type {Vec3} from 'meta/worlds';

/**
 * Optional extension for a stagger controller that applies a physical impulse.
 *
 * The SDK's `ActorStaggerController` interface carries only
 * `setStaggerParams()` / `areStaggerParamsInitialized()`, and
 * `setStaggerParams()` is a one-time CONFIG push — StaggerBehavior claims the
 * stagger controller unconditionally and pushes params on its first grant, which
 * happens before any damage. There is therefore no SDK-level signal for "a
 * stagger just started", which is what a knockback impulse needs.
 *
 * A controller that wants that signal implements this interface; StaggerBehavior
 * calls it from `onHitDetected()`, the one place that already knows a stagger is
 * beginning and has already applied the cooldown gate. Implementing it is
 * optional — StaggerBehavior feature-detects, so a controller that only wants
 * the config push is unaffected.
 */
export interface IActorStaggerImpulseReceiver {
    /**
     * Called once per stagger, on the owner, at the moment StaggerBehavior
     * decides a hit staggers the actor. Already past the stagger cooldown.
     *
     * @param attackerPosition World position of the entity that dealt the hit,
     * resolved by StaggerBehavior via {@link IActorLastAttackerProvider}. The
     * receiver pushes directly away from it, so a flank or rear hit knocks the
     * actor the correct way. `null` is the explicit "source unknown" signal and
     * selects the receiver's facing fallback (`-worldForward`), which is right
     * only for a head-on hit — passed when the health component implements no
     * provider, when the damage source recorded no attacker, or when the
     * attacker has since been destroyed.
     * @param forceScale Multiplier on the configured knockback force, supplied
     * by the attacker. Undefined means unscaled; treat it as 1.
     */
    applyStaggerImpulse(attackerPosition: Vec3 | null, forceScale?: number): void;
}
