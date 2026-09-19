/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Bot Player Scripts v1

import {
  type Entity,
  PlayerService,
  Service,
  service,
  type Maybe,
} from 'meta/worlds';
import {WorldsBotPlayerService} from './WorldsBotPlayerService';

// Upper bound on spawns + removals within a single reconcile pass. Sized well
// above any plausible player target so it is only ever reached by pathological
// churn, never by ordinary filling.
const kMaxStepsPerPass = 64;

/**
 * Coerce a caller-supplied target to a whole, finite, non-negative number.
 *
 * The target arrives from an editor property and from game code, neither of
 * which is constrained to whole finite values, and the reconcile loop compares
 * it against `bots.length` -- an integer. A fractional target is a number that
 * comparison can never reach, so the loop alternates spawn and removal until it
 * hits the step bound, churning networked player entities and reporting failure
 * every time. A non-finite one makes both comparisons false, which reads as
 * "already settled" while the world stays empty. Both are silently wrong for
 * the whole session, so the coercion happens once, here at the boundary, rather
 * than being re-derived at every use.
 */
function toWholeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Coerce a caller-supplied cap to a whole bot count, or to null for "uncapped".
 *
 * The cap needs its own coercion because zero is a sentinel here, not a count:
 * flooring it like a target would send every cap in (0, 1) to zero, and a
 * caller asking for the tightest cap expressible would get no cap at all. So
 * any positive request floors to at least one, which is the tightest cap that
 * is actually a count and never more than what was asked. Non-finite bounds
 * nothing, so it reads as uncapped rather than as the 1 a floor would produce.
 */
function toCap(value: Maybe<number> | undefined): Maybe<number> {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Keeps a world topped up to a target number of participants by spawning and
 * removing bots as humans join and leave. Pure TypeScript: all spawning goes
 * through {@link WorldsBotPlayerService}, never a native bot service.
 *
 * The bots are stand-ins for humans, not NPCs: they spawn as plain idle players
 * and never act on their own. That makes this the way to put a multiplayer
 * feature under test from a single client, as well as the way to keep a live
 * world from feeling empty. See {@link WorldsBotPlayerService} for where the
 * line with the Actor Framework falls, and for how to add behaviour on top.
 *
 * COUNTING MODEL
 * Every bot registers as a real (remote) player, so PlayerService counts it.
 * The human count is the player registry minus the bots this service manages,
 * and the number of bots we want is `targetPlayerCount - humans` (clamped to
 * >= 0 and to maxBots). Both counts are re-derived after every spawn and every
 * removal, never once per pass: players join and leave, and bots register
 * asynchronously, across the awaits inside a pass.
 *
 * WHY A LOCAL BOT LIST
 * The service keeps its own ordered list of the bots it spawned. The primitive
 * can remove a bot by handle or remove all, but not "remove one," and topping
 * down needs to drop specific bots -- so the list is the source of truth for
 * which bots this service may reclaim. Removing the newest first (LIFO) keeps
 * the oldest bots stable across churn.
 *
 * AUTHORITY
 * This service performs no dedup itself: run it from a single context. There is
 * one instance per context, so if two contexts both reconcile against the same
 * world they will each spawn a full set. The controller enforces this by bailing
 * out unless it is running on the server. reconcile() is target-based and
 * idempotent, so repeated or overlapping calls from the SAME context converge
 * without over-spawning.
 *
 * Callers use `WorldsBotFillService.get()`; do not cache the handle across
 * hot-reload. The bot list is preserved across hot-reload with the service.
 */
@service()
export class WorldsBotFillService extends Service {
  // Desired total participants (humans + bots). Bots fill the gap up to this.
  private targetPlayerCount: number = 0;

  // Optional hard cap on bots regardless of the gap. null = no explicit cap.
  private maxBots: Maybe<number> = null;

  // When false, reconcile() drives the bot count to zero.
  private enabled: boolean = false;

  // Bots this service spawned, oldest first. Also live in the primitive's
  // roster; this list is what this service is allowed to reclaim.
  private bots: Entity[] = [];

  // Debounce: coalesce triggers that arrive while an async reconcile is in
  // flight, then run once more if anything changed during the pass. Holding the
  // promise (not just a flag) is what lets coalesced callers await completion.
  private inFlight: Maybe<Promise<boolean>> = null;
  private dirty: boolean = false;

  /**
   * Apply fill configuration. Does not spawn or remove on its own -- call
   * reconcile() afterward (the controller does this on start).
   *
   * `maxBots` of null, non-finite, or <= 0 means UNCAPPED -- the bot count is
   * then bounded only by the target. "Allow no bots at all" is `enabled: false`,
   * not `maxBots: 0`, so that zero reads the same way here as it does on the
   * controller's editor property. Any positive cap is at least 1.
   */
  public configure(config: {
    targetPlayerCount: number;
    maxBots?: Maybe<number>;
    enabled?: boolean;
  }): void {
    this.targetPlayerCount = toWholeCount(config.targetPlayerCount);
    this.maxBots = toCap(config.maxBots);
    if (config.enabled != null) {
      this.enabled = config.enabled;
    }
    this.markChanged();
  }

  public setTargetPlayerCount(count: number): void {
    this.targetPlayerCount = toWholeCount(count);
    this.markChanged();
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.markChanged();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getTargetPlayerCount(): number {
    return this.targetPlayerCount;
  }

  /**
   * Number of bots this service currently manages.
   *
   * Prunes first, so the answer never counts a bot whose entity has already
   * been destroyed. Callers use this to decide whether the world is full, and a
   * stale handle would report a world that is short as one that is full.
   */
  public getBotCount(): number {
    this.pruneDestroyed();
    return this.bots.length;
  }

  /** True if the entity is a bot this service spawned and still manages. */
  public isManagedBot(entity: Maybe<Entity>): boolean {
    return entity != null && this.bots.includes(entity);
  }

  /**
   * Drop a bot from the managed list WITHOUT destroying it. Use when the bot's
   * player entity was already destroyed elsewhere (e.g. an OnPlayerDestroyEvent
   * for one of our bots), so the count stays accurate before the next reconcile.
   */
  public forgetBot(bot: Maybe<Entity>): void {
    if (bot == null) {
      return;
    }
    const index = this.bots.indexOf(bot);
    if (index < 0) {
      // Not ours -- some other caller spawned it. Leave the primitive's roster
      // alone; deregistering a bot we never managed is not ours to do.
      return;
    }
    this.bots.splice(index, 1);
    // Also drop it from the primitive's roster so its getBotCount() does not keep
    // a stale handle. The entity was already destroyed elsewhere, so forgetBot()
    // (not removeBotPlayer()) -- we must not try to destroy it again.
    WorldsBotPlayerService.get().forgetBot(bot);
  }

  /**
   * Remove every bot this service manages and clear the list.
   *
   * This is "remove what exists now", NOT "stay empty": while backfill is
   * enabled the next reconcile will fill straight back up to the target. To
   * empty the world and keep it empty, call setEnabled(false) (then reconcile).
   */
  public removeAllBots(): void {
    const botService = WorldsBotPlayerService.get();
    for (const bot of this.bots.splice(0)) {
      botService.removeBotPlayer(bot);
    }
    this.markChanged();
  }

  /**
   * Bring the bot count in line with the target for the current human count.
   * Idempotent and safe to call repeatedly; overlapping calls are coalesced.
   *
   * A call that arrives while a pass is in flight schedules another pass and
   * returns that same in-flight promise, so it resolves only once its own work
   * has been done -- never early, against a pre-reconcile count.
   *
   * Resolves TRUE when the bot count settled on the target, FALSE when the pass
   * was abandoned (a spawn failed) and the count is therefore still short. The
   * result is reported rather than thrown because a failed fill is a degraded
   * world, not a broken one. Callers that must reach the target should retry on
   * false; callers that only want a best effort can ignore it. Never rejects.
   */
  public reconcile(): Promise<boolean> {
    if (this.inFlight != null) {
      this.dirty = true;
      return this.inFlight;
    }
    // The promise has to be PUBLISHED BEFORE the work starts, not after it.
    // runPasses() runs synchronously up to its first await, and the thing being
    // awaited is a spawn whose own synchronous prefix can re-enter reconcile()
    // -- registering a player fires events, and an event handler that asks for
    // a reconcile would find inFlight still null, read that as "nothing
    // running", and start a rival pass racing the first for the same bot
    // budget. Handing the work to an already-published promise closes that
    // window while keeping the first spawn synchronous.
    let startPass!: (result: Promise<boolean>) => void;
    const pass = new Promise<boolean>(resolve => {
      startPass = resolve;
    });
    this.inFlight = pass;
    startPass(this.runPasses());
    return pass;
  }

  private async runPasses(): Promise<boolean> {
    let settled = false;
    try {
      do {
        this.dirty = false;
        settled = await this.reconcileOnce();
        // An abandoned pass stops the loop: whatever made the spawn fail will
        // still be true on an immediate retry, so re-running here would only
        // spin. The caller sees false and decides.
      } while (this.dirty && settled);
    } finally {
      this.inFlight = null;
    }
    return settled;
  }

  /**
   * One pass: move the bot count one step at a time until it matches the
   * target, re-deriving the target after every step. Returns false if the pass
   * was abandoned on a spawn failure.
   */
  private async reconcileOnce(): Promise<boolean> {
    const botService = WorldsBotPlayerService.get();

    // A step is one spawn or one removal, so a settled pass needs at most a
    // target's worth of them. The bound only exists so that state churning
    // faster than we can act on it cannot spin this loop forever.
    let stepsRemaining = kMaxStepsPerPass;
    while (stepsRemaining-- > 0) {
      // Re-checked every step because entities can die across the awaits below.
      this.pruneDestroyed();

      // Re-derived every step, never hoisted: configure(), setEnabled(),
      // setTargetPlayerCount() and removeAllBots() can all land while this pass
      // is suspended on the spawn await, and a hoisted target would keep
      // spawning toward a number the caller has already changed.
      const desiredBots = this.computeDesiredBots();

      if (this.bots.length < desiredBots) {
        let bot: Maybe<Entity> = null;
        try {
          // serverOwned: true, passed explicitly rather than taking the default.
          // Backfill bots belong to the world, not to whoever happened to trigger
          // the fill -- they must outlive any single client's session.
          bot = await botService.spawnBotPlayer(true);
        } catch (error) {
          // The primitive rejects when no player template is configured. This
          // runs from broadcast event handlers that do not catch, so letting it
          // escape would be an unhandled rejection on start and on every join
          // and leave, with nothing naming the actual problem.
          console.error(
            '[WorldsBotFillService] Bot spawn failed; abandoning this reconcile pass. ' +
              'A missing player template is the usual cause -- check that a ' +
              'WorldsBotPlayerConfig is placed in the world with its template assigned.',
            error,
          );
          return false;
        }
        if (bot == null) {
          // Spawn resolved with no entity. Retrying inside this pass would just
          // repeat a failure that is not going to clear on its own.
          return false;
        }
        this.bots.push(bot);
      } else if (this.bots.length > desiredBots) {
        // Remove newest first, so the oldest bots stay stable across churn.
        const bot = this.bots.pop();
        if (bot != null) {
          botService.removeBotPlayer(bot);
        }
      } else {
        return true;
      }
    }

    console.warn(
      `[WorldsBotFillService] Reconcile hit the ${kMaxStepsPerPass}-step bound without ` +
        'settling; the target is likely changing faster than bots can be spawned.',
    );
    return false;
  }

  private computeDesiredBots(): number {
    let desiredBots = this.enabled
      ? Math.max(0, this.targetPlayerCount - this.countHumans())
      : 0;
    if (this.maxBots != null) {
      desiredBots = Math.min(desiredBots, this.maxBots);
    }
    return desiredBots;
  }

  /**
   * Humans currently in the world, counted by walking the player registry and
   * discounting our own bots.
   *
   * Deliberately NOT `getPlayerCount() - this.bots.length`: a bot is registered
   * as a player asynchronously, through the engine's reactive player path, so
   * between the spawn resolving and that registration the subtraction charges
   * a bot against the human count. That under-counts humans, inflates the
   * target, and over-spawns. Walking the registry cannot drift the same way --
   * a bot that has not registered yet is absent from both sides of the sum.
   *
   * Matching entities by identity is sound because the SDK interns entity
   * handles: the handle held in `bots` is the same object the registry returns.
   */
  private countHumans(): number {
    let humans = 0;
    for (const player of PlayerService.get().getAllPlayers()) {
      if (!player.isDestroyed() && !this.bots.includes(player)) {
        humans++;
      }
    }
    return humans;
  }

  /**
   * Drop handles whose entity died without us seeing an OnPlayerDestroyEvent
   * (world teardown, an external destroy()). A stale handle inflates the bot
   * count, which deflates the human count and starves the fill.
   *
   * The drop is forwarded to the primitive rather than being kept local. Both
   * hold the same handle, and nothing else will ever clear it there: the only
   * other route into the primitive's roster is removeBotPlayer(), which would
   * try to destroy an entity that is already gone.
   */
  private pruneDestroyed(): void {
    if (this.bots.length === 0) {
      return;
    }
    const botService = WorldsBotPlayerService.get();
    this.bots = this.bots.filter(bot => {
      if (!bot.isDestroyed()) {
        return true;
      }
      botService.forgetBot(bot);
      return false;
    });
  }

  // Mark an in-flight pass as needing another round. Every mutator calls this:
  // a pass suspended on an await must not finish against configuration that
  // changed underneath it. No-op when nothing is running -- the caller
  // reconciles when it is ready.
  private markChanged(): void {
    if (this.inFlight != null) {
      this.dirty = true;
    }
  }
}
