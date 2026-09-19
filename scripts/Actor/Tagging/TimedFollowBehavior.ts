/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v1

import type {ActorBehaviorManager} from 'meta/worlds';
import {FollowTaggedEntityBehavior} from './FollowTaggedEntityBehavior';

/**
 * TimedFollowBehavior — a `FollowTaggedEntityBehavior` that is only active in
 * repeating timed windows, for a "follow on a schedule" cycle (e.g. "wander,
 * then follow the player for 15s every 3s, then wander again").
 *
 * This is the idiomatic way to build a TIME-BASED behavior cycle: it stays
 * REGISTERED the whole time and gates itself by priority — while dormant it
 * returns `-1` from `getControllerUsePriority`, so a lower-priority default
 * behavior (e.g. `IdleWanderBehavior`) automatically owns movement; when the
 * active window opens it reclaims control at its own `basePriority`. Register it
 * ONCE in a start component alongside the default behavior.
 *
 * Do NOT drive a timed cycle with an `OnWorldUpdateEvent` component that calls
 * `actorLogic.addBehavior(...)` / `removeBehavior(...)` on a phase timer — that
 * fights the priority-arbitration system and is fragile (see the
 * `working-with-actor-behaviors` skill).
 *
 * @example
 * ```typescript
 * import {IdleWanderBehavior} from '../Behaviors/IdleWanderBehavior';
 * import {TimedFollowBehavior} from './TimedFollowBehavior';
 *
 * // In a start component's onStart (ExecuteOn.Owner):
 * const wander = new IdleWanderBehavior();
 * wander.basePriority = 10;               // default, always active
 *
 * const follow = new TimedFollowBehavior();
 * follow.basePriority = 20;               // higher → wins while active
 * follow.targetTags = ['player'];
 * follow.activeDuration = 15;             // ... follow for 15s each active window
 * follow.dormantDuration = 3;             // starts dormant 3s, then repeats
 *
 * actorLogic.addBehavior(wander);
 * actorLogic.addBehavior(follow);
 * // The behavior manager handles the transitions — no update loop, no add/remove.
 * ```
 */
export class TimedFollowBehavior extends FollowTaggedEntityBehavior {
  override name: string = 'TimedFollowBehavior';

  /** Seconds the follow window stays active before going dormant. */
  activeDuration: number = 15.0;

  /** Seconds the behavior stays dormant (default behavior runs) between windows. */
  dormantDuration: number = 3.0;

  /** true while the active follow window is open. Starts dormant. */
  private active: boolean = false;

  /** Countdown to the next phase flip. Seeded in initialize() from the
   * configured dormantDuration (field initializers run before instance config
   * is applied, so this cannot be set as a field default). */
  private phaseTimer: number = 0;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    // Both durations must be > 0, else a phase would be skipped (or, if both are
    // 0, the catch-up loop in update() would spin). Clamp to a small positive
    // floor so a misconfigured 0/negative value degrades gracefully.
    this.activeDuration = Math.max(0.001, this.activeDuration);
    this.dormantDuration = Math.max(0.001, this.dormantDuration);
    this.active = false;
    this.phaseTimer = this.dormantDuration;
    super.initialize(behaviorManager);
  }

  override update(deltaTime: number): void {
    this.phaseTimer -= deltaTime;
    // Carry the overshoot into the next window rather than resetting to the full
    // duration (avoids drift), and advance up to a few phases so a single large
    // deltaTime spike catches up instead of silently skipping cycles. The guard
    // caps iterations so a pathological spike (e.g. 10s post-resume) with tiny
    // durations can never spin the frame — any residual is absorbed next frame.
    let guard = 10;
    while (this.phaseTimer <= 0 && guard-- > 0) {
      this.active = !this.active;
      this.phaseTimer += this.active ? this.activeDuration : this.dormantDuration;
    }
    // If a pathological deltaTime spike exhausted the guard, resync to a full
    // window so the phase state is always well-defined (phaseTimer > 0) after
    // update() rather than lagging negative across frames.
    if (this.phaseTimer <= 0) {
      this.phaseTimer = this.active ? this.activeDuration : this.dormantDuration;
    }
    // Only tick the composed targeting/follow sub-behaviors while active. Running
    // them during the dormant window would churn shared targeting/blackboard
    // state for a behavior that is releasing all controllers anyway; on the next
    // activation super.update() reacquires within a frame.
    if (this.active) {
      super.update(deltaTime);
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    // Dormant window → release all controllers so the lower-priority default
    // behavior resumes automatically.
    if (!this.active) {
      return -1;
    }
    return super.getControllerUsePriority(controllerType);
  }
}
