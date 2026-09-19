/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Bot Player Scripts v1

import {
  Component,
  NetworkingService,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnPlayerCreateEvent,
  OnPlayerCreateEventPayload,
  OnPlayerDestroyEvent,
  OnPlayerDestroyEventPayload,
  component,
  editor,
  property,
  subscribe,
  type Maybe,
} from 'meta/worlds';
import {WorldsBotFillService} from './WorldsBotFillService';

// How long to wait before retrying a reconcile that did not settle, and how
// many times. Long enough for a template assignment or a transient spawn
// failure to clear, short enough that the world fills promptly.
const kReconcileRetryDelayMs = 1000;
const kMaxReconcileRetries = 5;

/**
 * Editor-placeable driver for {@link WorldsBotFillService}. Place one in the
 * world. It configures the fill target and reconciles the bot count whenever a
 * player joins or leaves.
 *
 * NOTHING RECONCILES SYNCHRONOUSLY
 * Every trigger goes through scheduleReconcile(), which defers the pass to the
 * next macrotask and retries it if it does not settle. Two reasons, both about
 * not trusting the instant a handler fires:
 *   - ORDERING. OnEntityStart gives no order between components, so this
 *     controller can start before the WorldsBotPlayerConfig that supplies the
 *     player template. Reconciling inline would fail on a template that is
 *     moments away from existing; deferring plus retrying makes placement order
 *     in the scene irrelevant.
 *   - SETTLING. The player events fire around registry mutation, not after it:
 *     a leaving player can still be listed when OnPlayerDestroy runs. Counting
 *     on the next macrotask reads the registry the trigger was announcing,
 *     rather than the one it interrupted.
 *
 * EXACTLY ONE CHAIN
 * A "chain" is one deferred pass plus whatever retries follow it, and at most
 * one is ever alive. `chainActive` covers the WHOLE chain -- the waits AND the
 * awaited passes -- rather than just the moment a timer is armed, so a trigger
 * arriving mid-pass cannot start a second chain that races the first for the
 * timer handle and doubles the retry budget and the warnings. Such a trigger
 * instead sets `retriggered`, and the running chain does one more pass once it
 * settles. Since reconcile() is target-based, one late pass covers any number
 * of triggers that arrived behind it.
 *
 * TEARDOWN
 * Cancelling the timer is not enough on its own: a pass can be suspended on its
 * await while the entity is destroyed, and would then arm a fresh timer on a
 * dead component. Every chain step therefore re-checks isTornDown() after the
 * await, and stops there.
 *
 * AUTHORITY -- SERVER ONLY
 * Backfill must run on EXACTLY ONE context, and that context is the server, so
 * every handler bails unless `NetworkingService.isServerContext()`. Bots are
 * therefore server-spawned and server-owned, and they survive any one client
 * leaving.
 *
 * Entity ownership is NOT a usable gate here. These events are broadcasts that
 * fire on the server and on every client, and `ExecuteOn.Owner` does not narrow
 * that for a typical placement: a non-networked entity (a scene root, say)
 * reports `isOwned() === true` in every context, so Owner degrades to
 * Everywhere and each client spawns its own full set of client-owned bots.
 * isServerContext() is synchronous and race-free, which ownership checks during
 * startup are not.
 *
 * TEMPLATE SOURCE
 * This controller does not know about the player template at all. The template
 * is set once by a WorldsBotPlayerConfig placed in the same world; everything
 * here goes through WorldsBotFillService -> WorldsBotPlayerService, which owns
 * it. One assigner, no last-writer-wins.
 */
@component({
  description:
    'Drives WorldsBotFillService: keeps the world topped up to targetPlayerCount by spawning/removing bots as humans join and leave. Place one per world.',
})
export class WorldsBotFillController extends Component {
  @property()
  @editor({
    description:
      'Desired total participants (humans + bots). Bots fill the gap up to this count.',
  })
  targetPlayerCount: number = 4;

  @property()
  @editor({
    description:
      'Hard cap on bots regardless of the gap. 0 (or less) means no explicit cap.',
  })
  maxBots: number = 0;

  @property()
  @editor({description: 'Turn backfill on. When off, all managed bots are removed.'})
  enabled: boolean = true;

  @property()
  @editor({description: 'Enable debug logging to console.'})
  debugLogEnabled: boolean = false;

  // The single chain's current timer, if it is waiting rather than running.
  // Only ever written by the one live chain, so it cannot be orphaned.
  private pendingReconcile: Maybe<ReturnType<typeof setTimeout>> = null;

  // A chain exists: waiting on its timer OR inside an awaited pass. This, not
  // pendingReconcile, is what keeps triggers from starting a second chain.
  private chainActive: boolean = false;

  // A trigger arrived while a chain was running. The chain does one more pass
  // before finishing, so no trigger is dropped just for arriving mid-pass.
  private retriggered: boolean = false;

  // Latest trigger's reason, for logging. Coalesced triggers overwrite it, so
  // the log names what most recently asked for the pass.
  private pendingReason: string = 'start';

  // Set on OnEntityDestroy. Checked after every await, because cancelling the
  // timer cannot reach a pass that is already suspended.
  private destroyed: boolean = false;

  @subscribe(OnEntityStartEvent)
  onStart(): void {
    if (!this.isServer()) {
      return;
    }
    WorldsBotFillService.get().configure({
      targetPlayerCount: this.targetPlayerCount,
      // Passed straight through: the service reads <= 0 as uncapped too.
      maxBots: this.maxBots,
      enabled: this.enabled,
    });
    this.log(
      `configured target=${this.targetPlayerCount} maxBots=${this.maxBots} enabled=${String(this.enabled)}`,
    );
    this.scheduleReconcile('start');
  }

  @subscribe(OnPlayerCreateEvent)
  onPlayerCreate(payload: OnPlayerCreateEventPayload): void {
    if (!this.isServer()) {
      return;
    }
    // A bot we just spawned also fires this; skip it so we only react to
    // humans (and other, unmanaged players) joining.
    if (WorldsBotFillService.get().isManagedBot(payload.entity)) {
      return;
    }
    this.scheduleReconcile('player joined');
  }

  @subscribe(OnPlayerDestroyEvent)
  onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    if (!this.isServer()) {
      return;
    }
    const fill = WorldsBotFillService.get();
    // If one of our own bots was destroyed elsewhere, drop the stale handle so
    // the count stays accurate before we recompute. Done inline, not deferred:
    // the payload is the only place that handle is named.
    if (fill.isManagedBot(payload.entity)) {
      fill.forgetBot(payload.entity);
    }
    this.scheduleReconcile('player left');
  }

  @subscribe(OnEntityDestroyEvent)
  onEntityDestroy(): void {
    // Two halves, and both are needed. The flag stops a pass that is already
    // suspended on its await from arming anything further; cancelling the timer
    // stops a chain that is merely waiting from ever waking up.
    this.destroyed = true;
    if (this.pendingReconcile != null) {
      clearTimeout(this.pendingReconcile);
      this.pendingReconcile = null;
    }
    this.endChain();
  }

  /**
   * Ask for a reconcile on the next macrotask instead of running one now. See
   * the class doc for why nothing here reconciles synchronously, and why at
   * most one chain runs at a time.
   */
  private scheduleReconcile(reason: string): void {
    if (this.isTornDown()) {
      return;
    }
    this.pendingReason = reason;
    if (this.chainActive) {
      // A chain already owns the work. Tell it there is more to do rather than
      // starting a rival one -- see EXACTLY ONE CHAIN in the class doc.
      this.retriggered = true;
      return;
    }
    this.chainActive = true;
    this.armChainStep(0, kMaxReconcileRetries);
  }

  // Wait, then take the next step of the live chain. Only ever called with
  // chainActive already true, which is what makes the handle safe to store.
  private armChainStep(delayMs: number, retriesLeft: number): void {
    this.pendingReconcile = setTimeout(() => {
      this.pendingReconcile = null;
      void this.runChainStep(retriesLeft);
    }, delayMs);
  }

  private endChain(): void {
    this.chainActive = false;
    this.retriggered = false;
  }

  // True once this component is going away. The flag is the real signal; the
  // entity check also covers a teardown path that never delivers the event.
  private isTornDown(): boolean {
    return this.destroyed || !(this.entity?.valid ?? false);
  }

  /**
   * Run one reconcile and decide what the chain does next: finish, run again
   * for a trigger that arrived mid-pass, or retry. A pass fails mainly because
   * the player template is not in place yet, which resolves on its own once the
   * config component starts -- so retrying gets the world filled where a single
   * inline attempt would leave it permanently short. The retry budget keeps a
   * genuinely broken setup from retrying forever, and ends on a warning that
   * says the world is still short.
   */
  private async runChainStep(retriesLeft: number): Promise<void> {
    if (this.isTornDown()) {
      this.endChain();
      return;
    }
    const reason = this.pendingReason;
    const fill = WorldsBotFillService.get();

    // reconcile() is documented never to reject, but this chain is the only
    // thing that ever clears chainActive. An error escaping here would skip
    // every endChain() below, leaving the controller permanently "busy": each
    // later join and leave would set retriggered on a chain that no longer
    // exists, and backfill would be off for the rest of the session with
    // nothing but an unhandled rejection to say so. Report it and let the
    // ordinary retry path decide.
    let settled = false;
    try {
      settled = await fill.reconcile();
    } catch (error) {
      console.error(
        '[WorldsBotFillController] Reconcile threw instead of reporting; ' +
          'treating this pass as unsettled.',
        error,
      );
    }

    // Re-checked after the await: the entity can be destroyed while a pass is
    // suspended, and arming a retry then would outlive the component.
    if (this.isTornDown()) {
      this.endChain();
      return;
    }

    if (!settled) {
      if (retriesLeft > 0) {
        this.armChainStep(kReconcileRetryDelayMs, retriesLeft - 1);
        return;
      }
      console.warn(
        `[WorldsBotFillController] Backfill did not settle after ${reason} ` +
          `(${kMaxReconcileRetries} retries); the world is running short of ` +
          'the target. Check that a WorldsBotPlayerConfig with a player ' +
          'template is placed in this world.',
      );
      // endChain() also drops a trigger banked while this chain was failing,
      // and that is deliberate. Handing it to a fresh chain would restore a
      // full budget every time a player moved through a world that cannot
      // spawn, which is an unbounded retry loop and a warning every few
      // seconds -- exactly what the fixed budget exists to stop. Giving up
      // costs nothing that the budget had not already given up on: the next
      // join or leave after this point starts a clean chain either way.
      this.endChain();
      return;
    }

    if (this.retriggered) {
      // Something changed mid-pass. Go again promptly, with a full budget --
      // this is new work, not a retry of work that just failed.
      this.retriggered = false;
      this.armChainStep(0, kMaxReconcileRetries);
      return;
    }

    this.log(`${reason}: reconciled, bots=${fill.getBotCount()}`);
    this.endChain();
  }

  // Every handler is a broadcast; this is the single-authority gate. See the
  // AUTHORITY note above for why entity ownership cannot do this job.
  private isServer(): boolean {
    return NetworkingService.get().isServerContext();
  }

  private log(...args: unknown[]): void {
    if (this.debugLogEnabled) {
      console.log(`[WorldsBotFillController] ${this.entityName}:`, ...args);
    }
  }

  private get entityName(): string {
    return this.entity?.valid ? this.entity.name : '<destroyed>';
  }
}
