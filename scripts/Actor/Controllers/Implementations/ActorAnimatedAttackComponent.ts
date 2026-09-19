/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v3

import {
    component,
    Component,
    editor,
    MeshComponent,
    NetworkMode,
    OnEntityCreateEvent,
    OnEntityDestroyEvent,
    OnEntityStartEvent,
    property,
    Quaternion,
    subscribe,
    TransformComponent,
    Vec3,
    WorldService,
    ExecuteOn,
    type Entity,
    type TemplateAsset,
} from 'meta/worlds';
import { IActorAttackControllerTypeId, type IActorAttackController, type IActorAttackPayload } from '../Definitions/IActorAttackController';
import type { IActorInterruptibleAttack } from '../Definitions/IActorInterruptibleAttack';
import type { IActorLastAttackerProvider } from '../Definitions/IActorLastAttackerProvider';
import type { IActorProjectile } from '../Definitions/IActorProjectile';
import {ActorSdkLogicComponent} from 'meta/worlds';
import { CharacterGASComponent } from '../../../gas/CharacterGASComponent';
import { CharacterAnimationController } from '../../../animation/CharacterAnimationController';
import { AnimAction } from '../../../animation/layers/TriggeredLayer';
import { AttackTuning } from '../../../animation/layers/AttackLayer';
import { RangedTuning } from '../../../animation/layers/RangedLayer';
/**
 * How an attack delivers its hit.
 *
 * Serialised through a plain `number` @property, not as an enum-typed one: an
 * enum @property reflects as `NativeTypeId::Enum`, which no `.hstf` in the repo
 * serialises, so a scene-authored value would never arrive. Same workaround as
 * `CameraManager.cameraMode` and the pickup starters' hand slot.
 *
 * Melee is 0 so a template instance that omits the property zero-inits to it —
 * the mode every actor in this package used before projectile delivery moved in
 * here.
 */
enum AttackDeliveryMode {
    Melee = 0,
    Projectile = 1,
}

/** One slot in the projectile pool: the spawned entity and its IActorProjectile. */
interface PooledProjectile {
    entity: Entity;
    projectile: IActorProjectile;
}

/**
 * Attack controller for animated Actor entities, in either delivery mode:
 * a melee strike that damages the target directly, or a projectile fired from a
 * pre-spawned pool. {@link deliveryMode} selects between them, and
 * {@link setDeliveryMode} switches at runtime — for a weapon pickup, an ammo
 * counter running dry, or an explicit order from game logic.
 *
 * The two modes are ONE component rather than two on purpose. Everything except
 * the delivery step — the cooldown, the timers, controller registration and the
 * projectile pool — is common, and while they were separate components the
 * shared half drifted: the melee copy gained interrupt support and GAS health
 * integration the projectile copy never received. Splitting again would
 * reintroduce that drift.
 *
 * It also removes an arbitration hazard. Both former components registered
 * under `IActorAttackControllerTypeId`, and `ActorBehaviorManagerImpl` drives
 * EVERY controller registered under a type with the winning behavior — so an
 * actor carrying both swung and threw in the same frame, for double damage,
 * with nothing warning about it. One component means one registration.
 *
 * It plays no animation itself. It asks the entity's `CharacterAnimationController`
 * for a melee or ranged action and for an abort, and holds no layer names, no state
 * names and no animator reference of its own.
 *
 * It DOES own the attack's timing (`swingDurationSec` / `swingCooldownSec` and the
 * projectile pair), because that pacing is this actor's, not the animation system's:
 * `damageDelaySeconds` is the contact frame INSIDE the swing and the two have to be
 * tuned against each other. They are handed to the animation layers at create time by
 * `pushAnimationTuning`, which is what lets the layers stay plain classes with no
 * per-actor properties of their own.
 */
@component({
    description: 'Attack controller for animated actors, melee or projectile (set deliveryMode): paces the attack, lands melee damage on the contact frame or fires a pooled projectile, and asks the entity\'s CharacterAnimationController to play it.',
})
export class ActorAnimatedAttackComponent extends Component implements IActorAttackController, IActorInterruptibleAttack {
    @property()
    @editor({ description: 'How this attack lands: `0` Melee — damage is applied directly to the target at damageDelaySeconds. `1` Projectile — a pooled projectile is fired at projectileSpawnDelay and applies its own damage on a trigger hit, so it can MISS. Projectile mode additionally needs projectileTemplate set. Typed as a number rather than an enum because an enum @property does not survive scene serialisation. `0` is also the template-instance zero-init, so an instance that omits this is melee.' })
    deliveryMode: number = AttackDeliveryMode.Melee;

    @property()
    @editor({ description: 'Minimum cooldown in seconds between attacks. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `2`.' })
    minTimeBetweenAttacks: number = 2;

    @property()
    @editor({ description: 'Damage dealt per attack to the target. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1`.' })
    damageAmount: number = 1;

    @property()
    @editor({ description: 'MELEE MODE ONLY (projectile mode uses projectileSpawnDelay). Delay in seconds before damage is applied after the attack starts — the swing\'s CONTACT FRAME, i.e. when the weapon visually connects. 🚨 Must be strictly LESS than swingDurationSec on this same component: at or above it the hit lands on the swing\'s last frame, so the victim\'s reaction only starts once the attack has finished (and no pre-contact window exists for interruptAttack() to abort). Tune per clip: too late and the reaction trails a finished swing, too early and the swing never reads before the victim recoils. The shipped Character swing wants 0.4 of its 1.0s duration — 1.0 trailed, 0.1 swallowed the swing entirely, 0.3 was no better than 0.4. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly.' })
    damageDelaySeconds: number = 0.4;

    @property()
    @editor({ description: 'Additional delay in seconds after the attack animation before returning to idle. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `0.5`.' })
    idleTransitionDelay: number = 0.5;

    @property()
    @editor({ description: 'MELEE MODE. Seconds the swing animation plays for. Must be strictly GREATER than damageDelaySeconds — that is the contact frame inside this swing, and a contact at or past the end lands on the last frame, so the victim reacts only once the swing has finished. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.0`.' })
    swingDurationSec: number = 1.0;

    @property()
    @editor({ description: 'MELEE MODE. Seconds after a swing before the animation layer allows another. Must stay above 0.1 — the layer leaves on `state_finished AND AttackCooldown > 0.1`, so a `0` freezes the character in the last frame of the swing pose. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly.' })
    swingCooldownSec: number = 0.5;

    @property()
    @editor({ description: 'PROJECTILE MODE. Seconds the throw animation plays for. Must be strictly GREATER than projectileSpawnDelay, which is the release point inside it. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.0`.' })
    throwDurationSec: number = 1.0;

    @property()
    @editor({ description: 'PROJECTILE MODE. Seconds after a throw before the animation layer allows another. Same `> 0.1` exit gate as the melee swing — a `0` freezes the throw pose. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly.' })
    throwCooldownSec: number = 0.5;

    @property()
    @editor({ description: 'MELEE MODE ONLY (a projectile carries no knockback). Scales the knockback impulse this attacker imparts on a hit, on top of the knockbackForce configured on the target. 1 leaves it unscaled, 2 doubles the throw, 0 removes knockback while still staggering. The value is NOT clamped — a negative number inverts the impulse and drags the victim toward this attacker instead of away, which is a valid vacuum/grapple effect but is usually a typo. It multiplies with the knockbackForce on the target, so two negatives cancel back into a push. Only takes effect on a target whose health component implements IActorLastAttackerProvider. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1` (a `0` silently removes knockback from this attacker).' })
    knockbackMultiplier: number = 1;

    @property()
    @editor({ description: 'PROJECTILE MODE ONLY. Template to spawn as the projectile. Its root must carry a component implementing IActorProjectile (`fire`/`onHit`; optional `getSpeed`) — the controller duck-types for one and will not fire without it. 🚨 That component owns its own VISIBILITY: pooled projectiles are hidden while parked, and `fire()` must show the projectile (and recycling must hide it again) by broadcasting a NetworkEvent and toggling `MeshComponent.isVisibleSelf` in an `ExecuteOn.Everywhere` handler — the controller cannot do it, because a visibility write on its side reaches only one machine. Copy `FireballProjectile.setActive()`. A projectile that skips this travels and deals damage while staying invisible. Any VFX should live as a CHILD entity inside this template so it travels with the projectile; drive it from the projectile\'s fire()/onHit() rather than autoPlay, and size it via VFX parameters, NOT entity transform scale. With this unset in projectile mode the controller does not register as an attack controller at all, so the actor simply has no attack.' })
    projectileTemplate: TemplateAsset | null = null;

    @property()
    @editor({ description: 'PROJECTILE MODE ONLY (melee mode uses damageDelaySeconds). Delay in seconds after the attack starts before the projectile is fired. Align with the animation\'s release point. Interrupt window: a stagger landing before this elapses aborts the shot, exactly as it aborts a melee swing before contact.' })
    projectileSpawnDelay: number = 0.5;

    @property()
    @editor({ description: 'PROJECTILE MODE ONLY. Actor-LOCAL muzzle offset (x=right, y=up, z=forward; local forward is -Z in MHE, so the forward component is NEGATIVE — default z=-0.5), rotated by the caster facing at fire time. A positive or zero z, or world-space values, spawn the projectile inside or behind the caster, where it self-collides or appears underground. Prefer the exact firing point (muzzle, wand tip, hand) when one exists.' })
    projectileSpawnOffset: Vec3 = new Vec3(0, 1.5, -0.5);

    @property()
    @editor({ description: 'PROJECTILE MODE ONLY. Number of projectiles pre-spawned into the object pool, networked, at world load. Sized to the maximum number that can be in flight at once; the pool is reused round-robin, so a too-small pool recycles a projectile that is still travelling. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly (a `0` leaves nothing to fire).' })
    poolSize: number = 15;

    @property()
    @editor({ description: 'PROJECTILE MODE ONLY. Aim at where a moving target WILL be rather than where it is, predicted from the target velocity at fire time, so movers are hit without homing. The lead is sized from IActorProjectile.getSpeed(); without one a fixed short lead is used. The projectile\'s own fire() must lead too — the spawn orientation alone does not redirect a fire() that re-derives a straight direction. Leave off for hitscan-style or deliberately non-tracking shots.' })
    leadTargetPrediction: boolean = false;

    @property()
    @editor({ description: 'Enable debug logging to console.' })
    debugLogEnabled: boolean = true;

    /**
     * The entity's animation driver, resolved once. Null leaves every play call a
     * no-op, which is the correct behaviour for an actor authored without one.
     */
    private animation: CharacterAnimationController | null = null;

    private lastAttackTime = 0;
    private isAttacking = false;
    private attackResetTimeoutId: number | null = null;
    // In-flight DELIVERY timers — the melee damage tick or the projectile
    // release, whichever this mode schedules. Tracked as a set so a re-entrant
    // attack() (which can happen when the delivery delay exceeds the attack-reset
    // window, letting the reset timer flip isAttacking back before delivery
    // lands) never orphans an earlier, still-pending, uncancellable timer.
    // Mirrors FireballProjectile's pendingVfxTimers. Cleared on cancel/destroy
    // so a timer cannot fire into a torn-down closure.
    //
    // Both modes share the set deliberately: it is what interruptAttack() reads
    // as "this attack has not yet committed", and aborting a throw before the
    // projectile spawns is the same guarantee as aborting a swing before contact.
    private pendingDeliveryTimers: Set<number> = new Set();

    // ── Projectile pool (projectile mode only) ──────────────────────────
    private pool: PooledProjectile[] = [];
    private nextPoolIndex: number = 0;
    // OnEntityStartEvent can fire more than once for an entity (ownership
    // handoff, re-initialization), and initializePool does not dedup — a second
    // pass would spawn a whole second pool and strand the first. Reset in
    // onDestroy, so a recycled entity rebuilds rather than coming back empty.
    // Same latch/reset pair as ActorHealthStarterComponent.behaviorsRegistered.
    private poolInitialized = false;
    // Incremented per build and on every teardown, so an async spawn that
    // resolves after its pool was torn down can tell and destroy itself instead
    // of pushing into a pool that no longer owns it.
    private poolGeneration = 0;

    // Lead horizon (seconds) used when the projectile does not report a speed
    // via getSpeed(). Matches the targeting stack's default velocityPredictionTime.
    private static readonly fallbackLeadTimeSeconds = 0.5;

    // Max |aimDir · Vec3.up| (aimDir is unit length) for which Quaternion.lookRotation
    // stays well-conditioned. Above this the aim is within ~2.6° of vertical, where
    // lookRotation(aimDir, Vec3.up) degenerates (NaN), so we keep the caster facing.
    private static readonly maxAimUpAlignment = 0.999;

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
    onCreate() {
        this.animation = this.entity.getComponent(CharacterAnimationController);
        this.pushAnimationTuning();

        // Attack gameplay state is per-life too. onDestroy() drains the pending
        // damage timers but never clears isAttacking, so an entity destroyed
        // mid-attack and later recycled would come back with isAttacking still
        // true — and attack()'s first guard (`if (this.isAttacking) return;`)
        // would then reject every attack for the rest of this life. Clear the
        // local state here.
        this.isAttacking = false;
        this.lastAttackTime = 0;
        if (this.attackResetTimeoutId != null) {
            clearTimeout(this.attackResetTimeoutId);
            this.attackResetTimeoutId = null;
        }
        for (const timerId of this.pendingDeliveryTimers) {
            clearTimeout(timerId);
        }
        this.pendingDeliveryTimers.clear();

        if (this.entity.isOwned()) {
            this.registerActorController();
        }

        if (this.debugLogEnabled) {
            const side = this.entity.isOwned() ? 'OWNER' : 'CLIENT';
            console.log(`[ActorAnimatedAttackComponent] [${side}] Initialized on '${this.entity.name}'`);
        }
    }

    /**
     * Owner-only, and projectile mode only: build the pool. Melee actors reach
     * this and do nothing, so the mode costs them no entities.
     */
    @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
    onStart() {
        this.initializePool();
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        if (this.attackResetTimeoutId != null) {
            clearTimeout(this.attackResetTimeoutId);
        }
        for (const timerId of this.pendingDeliveryTimers) {
            clearTimeout(timerId);
        }
        this.pendingDeliveryTimers.clear();
        this.destroyPool();
        this.unregisterActorController();
    }

    /**
     * Switches delivery mode at runtime — a weapon pickup, an ammo counter
     * running dry, or an explicit order from game logic.
     *
     * Any in-flight attack is cancelled first, so a swing already scheduled
     * cannot land as a projectile (or the reverse) after the switch.
     *
     * Owner-only, matching the pool build on `OnEntityStartEvent` and the
     * registration in `onCreate`. `deliveryMode` is NOT a replicated property:
     * the owner drives delivery and animation, and remote clients see the result
     * through `CharacterAnimationController`'s own replication, so they never
     * read this value to decide anything. Game logic that switches modes must
     * therefore run on the owner — calling this on a remote client is refused
     * rather than silently desyncing that client's mode from the owner's.
     */
    setDeliveryMode(mode: number): void {
        if (
            mode !== AttackDeliveryMode.Melee &&
            mode !== AttackDeliveryMode.Projectile
        ) {
            // Falling through to melee would be indistinguishable from a
            // deliberate switch to melee, so a typo'd mode would look like it
            // worked. Refuse instead.
            console.warn(`[ActorAnimatedAttackComponent] Ignoring setDeliveryMode(${mode}) on '${this.entity.name}' — expected 0 (melee) or 1 (projectile).`);
            return;
        }
        if (this.deliveryMode === mode) {
            return;
        }
        if (!this.entity.isOwned()) {
            console.warn(`[ActorAnimatedAttackComponent] Ignoring setDeliveryMode on non-owner '${this.entity.name}' — switch the mode on the owner.`);
            return;
        }
        this.cancelAttack();
        this.deliveryMode = mode;
        // An actor that started melee has no pool — initializePool() returned on
        // the mode guard at start. Build it now, or the first throw after the
        // switch animates and fires nothing. The latch makes this a no-op when
        // the pool already exists, so switching back and forth costs one build.
        this.initializePool();
        // Registration is mode-dependent — registerActorController() declines in
        // projectile mode with no template — so the registration made at create
        // time can be wrong for the new mode. Left alone, a melee actor switched
        // to templateless projectile mode stays registered while canAttack() is
        // now permanently false, and an actor that started that way stays
        // unregistered after switching to melee even though it can now attack.
        // Re-running both reconciles the controller list with the actual mode.
        this.unregisterActorController();
        this.registerActorController();
        if (this.debugLogEnabled) {
            console.log(`[ActorAnimatedAttackComponent] deliveryMode -> ${mode} on '${this.entity.name}'`);
        }
    }

    /** Plays the current mode's attack through the shared animation driver. */
    private playModeAnimation(): void {
        if (this.deliveryMode === AttackDeliveryMode.Projectile) {
            this.animation?.play(AnimAction.RANGED);
        } else {
            this.animation?.play(AnimAction.MELEE);
        }
    }

    /**
     * Hand this actor's attack pacing to the animation layers that play it.
     *
     * The layers are plain classes with no serialised properties of their own, so a value that
     * differs between actors has to come from the component that owns it — here, beside
     * damageDelaySeconds, which has to stay inside the swing it belongs to. Pushed from the
     * `ExecuteOn.Everywhere` create handler because a proxy writes the graph variables itself
     * when the replicated trigger arrives, so every client must already hold the same numbers.
     */
    private pushAnimationTuning(): void {
        const animation = this.animation;
        if (!animation) {
            return;
        }
        animation.tune(AnimAction.MELEE, AttackTuning.DURATION_SEC, this.swingDurationSec);
        animation.tune(AnimAction.MELEE, AttackTuning.COOLDOWN_SEC, this.swingCooldownSec);
        animation.tune(AnimAction.RANGED, RangedTuning.DURATION_SEC, this.throwDurationSec);
        animation.tune(AnimAction.RANGED, RangedTuning.COOLDOWN_SEC, this.throwCooldownSec);
    }

    attack(payload: IActorAttackPayload): void {
        const {target} = payload;

        // Cheap re-entrancy guard first — the behavior layer can call this every
        // frame while an attack is already in flight.
        if (this.isAttacking) {
            return;
        }

        // A dead attacker stops attacking, and a dead target takes no further
        // hits, in either delivery mode. Null-tolerant: a missing health
        // component never blocks the attack, and an invalid target is guarded
        // before it is dereferenced.
        const attackerHealth = this.entity.getComponent(CharacterGASComponent);
        if (attackerHealth && attackerHealth.isDead) {
            return;
        }
        if (target && target.valid) {
            const targetHealth = this.resolveTargetHealth(target);
            if (targetHealth && targetHealth.isDead) {
                return;
            }
        }

        this.isAttacking = true;
        this.lastAttackTime = WorldService.get().getWorldTime();

        this.playModeAnimation();

        // Damage per hit prefers the attacking behavior's value (payload.damage,
        // set by EngageCombatBehavior/AttackEntityInRangeBehavior) and falls back
        // to this controller's own damageAmount for standalone use.
        const damage = payload.damage ?? this.damageAmount;

        // The one step the two delivery modes do not share. Everything above and
        // below is common. Land it on the animation's contact/release frame; a
        // zero or negative delay means "now" and runs synchronously, which also
        // keeps both delivery paths unit-testable without fake timers.
        const projectileMode = this.deliveryMode === AttackDeliveryMode.Projectile;
        const deliveryDelay = projectileMode
            ? this.projectileSpawnDelay
            : this.damageDelaySeconds;
        const deliver = projectileMode
            ? () => this.fireNextProjectile({
                target,
                damage,
                attackRange: payload.attackRange,
                targetVelocity: payload.targetVelocity,
            })
            : () => this.dealDamage(target, damage);

        if (deliveryDelay > 0) {
            const timerId = setTimeout(() => {
                this.pendingDeliveryTimers.delete(timerId);
                deliver();
            }, deliveryDelay * 1000);
            this.pendingDeliveryTimers.add(timerId);
        } else {
            deliver();
        }

        // Reopen the attack once it has played out. This is the gameplay
        // re-entrancy window only — the animation layer returns itself to rest
        // on the graph's own exit gate, so nothing here drives animation.
        const attackSeconds = this.deliveryMode === AttackDeliveryMode.Projectile
            ? this.throwDurationSec
            : this.swingDurationSec;
        const totalDelay = (attackSeconds + this.idleTransitionDelay) * 1000;
        this.attackResetTimeoutId = setTimeout(() => {
            this.isAttacking = false;
            this.attackResetTimeoutId = null;
        }, totalDelay);
    }

    /**
     * Applies an attack's damage to the target's health, owner-authoritatively.
     *
     * Mirrors the projectile hit path (`FireballProjectile.applyHit`): resolve a
     * `CharacterGASComponent` on the target root or any descendant and call
     * `takeDamage`. This is what makes a melee actor actually reduce a target's
     * health — a stock target with a `CharacterGASComponent` and a collider
     * (including a static structure like a castle) takes damage with no per-frame
     * proximity/damage loop authored on the attacker.
     */
    dealDamage(target: Entity, amount: number): void {
        if (!target || !target.valid || amount <= 0) {
            return;
        }
        // A delayed hit can land after this attacker was despawned (e.g. the pool
        // recycled it, or a lethal counter-hit killed it first). Guard the
        // attacker before touching isOwned() so a pending timer never dereferences
        // a torn-down entity.
        if (!this.entity || !this.entity.valid) {
            return;
        }
        // Apply damage on the attacker's owner only, so a networked NPC does not
        // multi-count a single hit across clients (same authority rule the
        // projectile path enforces with ExecuteOn.Owner).
        if (!this.entity.isOwned()) {
            return;
        }
        const health = this.resolveTargetHealth(target);
        if (!health) {
            if (this.debugLogEnabled) {
                console.warn(`[ActorAnimatedAttackComponent] Target '${target.name}' has no CharacterGASComponent — no damage applied`);
            }
            return;
        }
        // The scheduling→firing delay can outlive a death: the attacker may have
        // been killed mid-delay, or the target may have died to another source in
        // the window. Re-check both so a queued hit never lands after a death.
        const attackerHealth = this.entity.getComponent(CharacterGASComponent);
        if ((attackerHealth && attackerHealth.isDead) || health.isDead) {
            return;
        }
        // Name the attacker BEFORE the hit lands, so StaggerBehavior can push the
        // target away from us instead of along its own facing. Must precede
        // takeDamage(): the provider promotes this pending value inside that
        // call, so recording after it would attribute this hit to the next one.
        // Feature-detected -- a target that skips the provider just keeps the
        // facing fallback.
        //
        // NOTE: this lands on whichever machine is attacking. When the target's
        // health is owned elsewhere (an NPC hitting a player), the damage is
        // routed to that owner but this attribution is not, so the owner's
        // stagger falls back to facing. Fine while only NPCs are staggered.
        (health as Partial<IActorLastAttackerProvider>).recordAttacker?.(
            this.entity,
            this.knockbackMultiplier,
        );
        health.takeDamage(amount);
        if (this.debugLogEnabled) {
            // Deliberately does NOT report health: when the target's health is
            // owned elsewhere the damage is applied there, so any value read
            // here is this machine's stale copy. Logging it read as "the hit
            // did nothing" while the hit was in fact working.
            console.log(`[ActorAnimatedAttackComponent] Attack hit '${target.name}' for ${amount}`);
        }
    }

    private resolveTargetHealth(target: Entity): CharacterGASComponent | null {
        return (
            target.getComponent(CharacterGASComponent) ??
            target
                .getChildrenWithComponent(CharacterGASComponent, true)[0]
                ?.getComponent(CharacterGASComponent) ??
            null
        );
    }

    canAttack(): boolean {
        const attackerHealth = this.entity.getComponent(CharacterGASComponent);
        if (attackerHealth && attackerHealth.isDead) {
            return false;
        }
        // Projectile mode with nothing to fire. registerActorController()
        // already declines to register in that case, so a behavior should never
        // reach this — but canAttack() is public and StaggerBehavior reaches
        // controllers directly, so the answer has to be honest either way.
        if (this.deliveryMode === AttackDeliveryMode.Projectile && !this.projectileTemplate) {
            return false;
        }
        const currentTime = WorldService.get().getWorldTime();
        return currentTime - this.lastAttackTime > this.minTimeBetweenAttacks;
    }

    /**
     * Aborts a swing that has not yet dealt its damage, so an incoming hit
     * visibly cuts the attack off instead of queueing behind it. See
     * {@link IActorInterruptibleAttack} for why the pre-contact restriction is
     * what keeps two evenly-matched actors from cancelling each other forever.
     *
     * `pendingDeliveryTimers` IS the contact signal, not a proxy for one: it is
     * non-empty for exactly the window between the swing starting and its
     * damage landing. That also makes a controller configured with
     * `damageDelaySeconds <= 0` uninterruptible by construction — damage is
     * applied synchronously there, so the swing is already past contact on its
     * first frame and there is nothing left to take back.
     *
     * Deliberately does NOT consult `isAttacking`, for the reason cancelAttack()
     * documents below: when damageDelaySeconds exceeds the attack-reset window,
     * the reset timer has already flipped isAttacking back to false while a
     * damage timer is still pending. Gating on it there would return false and
     * strand exactly the timer this method exists to drain, landing the hit the
     * stagger was supposed to abort. pendingDeliveryTimers is strictly the
     * narrower test in every consistent state and the correct one in the
     * inconsistent one, so it is the only gate.
     *
     * Owner-only, because that is where the timers live and where the animation
     * is driven from. Remote clients pick the abort up through the controller's
     * own replication channel, on the same path and therefore with the same
     * latency as the attack's start.
     */
    interruptAttack(): boolean {
        if (!this.entity.isOwned()) {
            return false;
        }
        if (this.pendingDeliveryTimers.size === 0) {
            return false;
        }

        for (const timerId of this.pendingDeliveryTimers) {
            clearTimeout(timerId);
        }
        this.pendingDeliveryTimers.clear();
        if (this.attackResetTimeoutId != null) {
            clearTimeout(this.attackResetTimeoutId);
            this.attackResetTimeoutId = null;
        }
        this.animation?.stop(AnimAction.MELEE);
        this.isAttacking = false;

        if (this.debugLogEnabled) {
            console.log(`[ActorAnimatedAttackComponent] Attack interrupted before contact on '${this.entity.name}'`);
        }
        return true;
    }

    cancelAttack(): void {
        // Drain timers unconditionally: when damageDelaySeconds exceeds the
        // attack-reset window, the reset timer has already flipped isAttacking
        // back to false while a damage timer is still pending — an early-return on
        // isAttacking would leak that timer and land a stray hit after cancel.
        if (this.attackResetTimeoutId != null) {
            clearTimeout(this.attackResetTimeoutId);
            this.attackResetTimeoutId = null;
        }
        for (const timerId of this.pendingDeliveryTimers) {
            clearTimeout(timerId);
        }
        this.pendingDeliveryTimers.clear();
        // No animation call: unlike interruptAttack(), a cancel is not a visible
        // abort. The layer finishes the swing it is playing and leaves on the
        // graph's own exit gate.
        this.isAttacking = false;
    }

    registerActorController(): void {
        // A projectile attacker with no template has no attack to offer: the
        // pool would be empty, so every request would play a throw animation and
        // fire nothing. Declining to register keeps the actor's attack-controller
        // list honest — a behavior sees no attack controller rather than one that
        // silently never lands.
        if (this.deliveryMode === AttackDeliveryMode.Projectile && !this.projectileTemplate) {
            console.warn(`[ActorAnimatedAttackComponent] '${this.entity.name}' is in projectile mode with no projectileTemplate — not registering as an attack controller. Assign a template whose root implements IActorProjectile, or set deliveryMode to 0 for melee.`);
            return;
        }
        const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
        if (actorLogic) {
            actorLogic.registerController(IActorAttackControllerTypeId, this);
            if (this.debugLogEnabled) {
                console.log(`[ActorAnimatedAttackComponent] Registered attack controller for ${this.entity.name}`);
            }
        } else {
            console.warn(`[ActorAnimatedAttackComponent] No ActorSdkLogicComponent found on ${this.entity.name}`);
        }
    }

    unregisterActorController(): void {
        const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
        if (actorLogic) {
            actorLogic.unregisterController(this);
        }
    }

    // ── Projectile pool (projectile mode only) ──────────────────────────

    /**
     * Pre-spawns {@link poolSize} projectiles, parked far off-screen and hidden,
     * so firing costs a teleport rather than a spawn. No-op in melee mode.
     */
    private initializePool(): void {
        if (this.poolInitialized) {
            return;
        }
        if (this.deliveryMode !== AttackDeliveryMode.Projectile) {
            return;
        }
        if (!this.projectileTemplate) {
            // registerActorController() has already warned and declined to
            // register, so this is a silent no-op rather than a second line
            // saying the same thing once per actor.
            return;
        }
        this.poolInitialized = true;
        // Spawning is async, so a teardown can land between the request and its
        // resolution. The generation stamps this batch; destroyPool() bumps the
        // counter, which is what tells a late callback its pool no longer exists.
        const generation = ++this.poolGeneration;

        // Counts SETTLED spawns, not successful ones. Counting only the pushes
        // would suppress the completion log on exactly the runs worth seeing —
        // one rejected or dropped spawn and the counter never reaches poolSize.
        let settled = 0;
        const noteSettled = () => {
            settled++;
            if (
                settled === this.poolSize &&
                generation === this.poolGeneration &&
                this.debugLogEnabled
            ) {
                console.log(`[ActorAnimatedAttackComponent] Pool ready: ${this.pool.length} of ${this.poolSize} projectiles on '${this.entity.name}'`);
            }
        };

        for (let i = 0; i < this.poolSize; i++) {
            WorldService.get().spawnTemplate({
                templateAsset: this.projectileTemplate,
                networkMode: NetworkMode.Networked,
                position: new Vec3(0, -1000, 0), // Park off-screen
            }).then((spawnedEntity: Entity) => {
                if (!spawnedEntity || spawnedEntity.isDestroyed()) {
                    noteSettled();
                    return;
                }
                // The pool this entity was spawned for is gone (onDestroy, or a
                // re-fired start that began a new batch). Nothing will ever fire
                // or destroy it, so destroy it here — otherwise it is stranded
                // networked at y=-1000 for the rest of the world's life.
                if (generation !== this.poolGeneration) {
                    spawnedEntity.destroy();
                    noteSettled();
                    return;
                }

                const projectile = this.findProjectileComponent(spawnedEntity);
                if (projectile) {
                    // Hide until fired: the pool sits in the world from load.
                    //
                    // Owner-side and root-mesh only, so this is a floor, not the
                    // mechanism. Showing the projectile again is the IActorProjectile
                    // implementation's job, in fire() — the controller deliberately
                    // does NOT restore visibility in fireNextProjectile(). It cannot:
                    // isVisibleSelf written here reaches only this machine, so a
                    // controller-side reveal would show the shot on the owner and
                    // leave it invisible on every remote client. Replicating it needs
                    // a NetworkEvent broadcast plus an ExecuteOn.Everywhere handler,
                    // which lives on the projectile (see FireballProjectile.setActive
                    // and its onCreate, which also hides on remote clients — this
                    // write does not reach them — and covers child VFX, which
                    // isVisibleSelf does not affect).
                    const meshComp = spawnedEntity.getComponent(MeshComponent);
                    if (meshComp) {
                        meshComp.isVisibleSelf = false;
                    }
                    this.pool.push({entity: spawnedEntity, projectile});
                } else {
                    // Never pushed, so destroyPool() cannot reach it. Destroy it
                    // here or a misconfigured template strands poolSize networked
                    // entities at y=-1000 for the rest of the world's life — the
                    // same leak the generation branch above guards against.
                    console.warn('[ActorAnimatedAttackComponent] Spawned projectile has no IActorProjectile component — check the projectileTemplate root');
                    spawnedEntity.destroy();
                }

                noteSettled();
            }).catch((error: unknown) => {
                // Without this the rejection is unhandled and the only symptom is
                // a pool that is quietly smaller than poolSize, with nothing
                // saying why.
                console.warn(`[ActorAnimatedAttackComponent] Projectile spawn failed on '${this.entity.name}': ${String(error)}`);
                noteSettled();
            });
        }
    }

    private destroyPool(): void {
        for (const entry of this.pool) {
            if (entry.entity && !entry.entity.isDestroyed()) {
                entry.entity.destroy();
            }
        }
        this.pool = [];
        this.nextPoolIndex = 0;
        this.poolInitialized = false;
        // Invalidates any spawn still in flight from the batch just torn down.
        this.poolGeneration++;
    }

    private fireNextProjectile(payload: IActorAttackPayload): void {
        if (this.pool.length === 0) {
            if (this.debugLogEnabled) {
                console.warn('[ActorAnimatedAttackComponent] Projectile pool is empty — cannot fire');
            }
            return;
        }

        const entry = this.pool[this.nextPoolIndex];

        if (entry.entity.isDestroyed()) {
            // Drop the slot rather than stepping over it. Left in place it is
            // hit again on every lap of the round-robin, so one attack in every
            // pool.length silently fires nothing for the rest of this life.
            this.pool.splice(this.nextPoolIndex, 1);
            if (this.nextPoolIndex >= this.pool.length) {
                this.nextPoolIndex = 0;
            }
            if (this.debugLogEnabled) {
                console.warn(`[ActorAnimatedAttackComponent] Pool entry destroyed — removed, ${this.pool.length} left`);
            }
            return;
        }

        // Every remaining early return happens BEFORE the index advances, so a
        // shot that never leaves keeps its slot instead of burning it for a full
        // round-robin lap.
        const transform = this.entity.getComponent(TransformComponent);
        if (!transform) {
            return;
        }

        this.nextPoolIndex = (this.nextPoolIndex + 1) % this.pool.length;

        const worldPos = transform.worldPosition;
        const worldRot = transform.worldRotation;
        // projectileSpawnOffset is actor-local. Rotate it into world space so the
        // forward component clears the caster in the direction the projectile
        // travels — a raw world-space add spawns inside/behind the caster once it
        // turns. First offset along the caster facing to size the lead; once the
        // travel direction is known we re-offset along it (below).
        const facingOffset = worldRot.mulVec3(this.projectileSpawnOffset);
        const facingSpawnPos = new Vec3(
            worldPos.x + facingOffset.x,
            worldPos.y + facingOffset.y,
            worldPos.z + facingOffset.z,
        );

        // By default the projectile flies along the caster's facing — straight
        // at the target's current position. When lead prediction is enabled and
        // the target's velocity is known, aim at the predicted intercept point
        // instead, so a moving target is hit without homing.
        let aimRot = worldRot;
        // Tracked explicitly rather than inferred from `aimRot !== worldRot`:
        // reference identity only reports the lead correctly while the sole
        // reassignment happens to allocate, so any future edit that produced a
        // structurally-equal quaternion would silently mislabel the log.
        let leading = false;
        const targetVelocity = payload.targetVelocity;
        if (this.leadTargetPrediction && payload.target && targetVelocity) {
            const targetTransform = payload.target.getComponent(TransformComponent);
            if (targetTransform) {
                const aimDir = this.computeLeadAimDirection(
                    facingSpawnPos,
                    targetTransform.worldPosition,
                    targetVelocity,
                    entry.projectile.getSpeed?.() ?? 0,
                );
                // Quaternion.lookRotation degenerates when aimDir is (anti)parallel
                // to its up reference (Vec3.up) — a target directly overhead/below
                // would yield a NaN rotation. aimDir is unit length and Vec3.up is
                // (0,1,0), so |aimDir.y| is its alignment with up; for near-vertical
                // shots keep the caster facing instead.
                if (
                    aimDir &&
                    Math.abs(aimDir.y) < ActorAnimatedAttackComponent.maxAimUpAlignment
                ) {
                    aimRot = Quaternion.lookRotation(aimDir, Vec3.up);
                    leading = true;
                }
            }
        }

        // Offset the muzzle along the actual travel direction (aimRot) so the
        // spawn clears the caster along the flight path, not just the caster
        // facing — otherwise a large lead angle starts the projectile in front of
        // the old facing while it flies off at an angle, clipping the caster. When
        // not leading, aimRot is still worldRot so this equals facingSpawnPos.
        const spawnOffset = aimRot.mulVec3(this.projectileSpawnOffset);
        const spawnPos = new Vec3(
            worldPos.x + spawnOffset.x,
            worldPos.y + spawnOffset.y,
            worldPos.z + spawnOffset.z,
        );

        const projectileTransform = entry.entity.getComponent(TransformComponent);
        if (projectileTransform) {
            // Spawn facing the aim rotation so fire() flies toward the target —
            // lead-predicted when the target is moving, straight otherwise.
            projectileTransform.teleportTo(spawnPos, aimRot);
            if (this.debugLogEnabled) {
                const ledSuffix = leading ? ' (leading moving target)' : '';
                console.log(`[ActorAnimatedAttackComponent] Spawned projectile at (${spawnPos.x.toFixed(2)}, ${spawnPos.y.toFixed(2)}, ${spawnPos.z.toFixed(2)}) from caster at (${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)}, ${worldPos.z.toFixed(2)})${ledSuffix}`);
            }
        } else if (this.debugLogEnabled) {
            console.warn('[ActorAnimatedAttackComponent] No TransformComponent on projectile — teleport skipped; projectile fired from its current position');
        }

        entry.projectile.fire(payload);
    }

    /**
     * Computes the normalized world-space aim direction that leads a moving
     * target, or null when the aim point is effectively on top of the muzzle.
     *
     * First-order lead: aimPoint = targetPos + velocity · leadTime, matching the
     * targeting stack's predicted-position model. When the projectile reports a
     * speed (> 0) the lead time is sized to the actual flight time
     * (distance ÷ speed, refined one step toward the true intercept); otherwise
     * a fixed fallback horizon is used. A stationary target (zero velocity)
     * resolves to aiming straight at its current position.
     *
     * Assumes a straight-line (non-ballistic) projectile, consistent with the
     * player projectile path.
     *
     * ACCURACY: exactly one refinement pass, deliberately, not for lack of a
     * better method. The exact intercept is the positive root of
     * `|targetPos + v·t - spawnPos| = projectileSpeed·t`, a quadratic in t, and
     * the loop here is one fixed-point step toward it. The residual grows with
     * the speed ratio `|v| / projectileSpeed`: negligible for the slow walkers
     * this controller aims at, and visible only as the target's speed approaches
     * the projectile's — where the intercept is ill-conditioned anyway and no
     * lead looks right.
     *
     * The pass count is NOT free to change here. `FireballProjectile.fire()`
     * runs the identical two-step refinement so the controller's spawn
     * orientation and the projectile's own re-derived direction agree; that
     * agreement is why {@link IActorProjectile.getSpeed} asks implementations to
     * report the same speed `fire()` applies. Adding an iteration on this side
     * alone would reintroduce the split between where the shot is pointed and
     * where it flies. Change both, or neither.
     */
    private computeLeadAimDirection(
        spawnPos: Vec3,
        targetPos: Vec3,
        targetVelocity: Vec3,
        projectileSpeed: number,
    ): Vec3 | null {
        let leadTime: number;
        if (projectileSpeed > 0) {
            leadTime = targetPos.sub(spawnPos).magnitude() / projectileSpeed;
            const firstGuess = targetPos.add(targetVelocity.mul(leadTime));
            leadTime = firstGuess.sub(spawnPos).magnitude() / projectileSpeed;
        } else {
            leadTime = ActorAnimatedAttackComponent.fallbackLeadTimeSeconds;
        }

        const aimPoint = targetPos.add(targetVelocity.mul(leadTime));
        const aimDir = aimPoint.sub(spawnPos);
        return aimDir.magnitude() > 0.0001 ? aimDir.normalize() : null;
    }

    /**
     * Searches an entity for a component implementing IActorProjectile.
     * Uses a duck-type check since MHS does not support getComponent by interface.
     */
    private findProjectileComponent(entity: Entity): IActorProjectile | null {
        const components = entity.getComponents(Component);
        for (const comp of components) {
            const candidate = comp as unknown as IActorProjectile;
            if (typeof candidate.fire === 'function' && typeof candidate.onHit === 'function') {
                return candidate;
            }
        }
        return null;
    }
}
