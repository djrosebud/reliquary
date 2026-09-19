/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Bot Player Scripts v1

import {
  type Entity,
  NetworkMode,
  Quaternion,
  Service,
  TemplateAsset,
  Vec3,
  WorldService,
  service,
  type Maybe,
} from 'meta/worlds';
import {pickPlayerSpawnPoint} from './WorldsSpawnPointPicker';

/**
 * Pure-TypeScript bot-player spawn primitive. Zero C++ and zero WSDK: it spawns
 * the world's player template with `WorldService.spawnTemplate(..., Networked)`
 * and lets the engine's reactive player-registration path do the rest.
 *
 * WHAT A BOT PLAYER IS FOR -- AND WHAT IT IS NOT
 * A bot player stands in for a HUMAN, not for a character in the fiction. Its
 * purpose is to give multiplayer code other participants to run against, so one
 * client plus the server can exercise join and leave handling, player counts,
 * team assignment, spawn slots, replication and any participant-listing UI
 * without gathering several people on several devices. The same mechanism is
 * what keeps a world playable before real players arrive.
 *
 * This is NOT an NPC. An NPC is authored content with a part to play; a bot
 * player is an empty seat that happens to be occupied. The difference decides
 * which system owns the entity: anything whose point is its BEHAVIOUR -- an
 * enemy, a companion, wildlife, a quest character -- belongs to the Actor
 * Framework and should not be built on this service.
 *
 * A bot spawns as a plain idle player and does nothing on its own. It is the
 * player template with no input attached, so it stands where it spawned for as
 * long as it lives, and that inertness is the intended product: presence in the
 * player count is the whole feature. Behaviour is strictly additive on top --
 * attaching an actor brain to the spawned entity makes the same bot move -- and
 * is a separate, deliberate step, never a side effect of spawning one.
 *
 * WHY THIS WORKS WITHOUT NATIVE CODE
 * The MHE PlayerManager installs a Flecs prefab monitor (`remotePlayerMonitor_`)
 * on the player-template prefab. Any entity that is an instance of that prefab
 * -- including one we spawn here -- is auto-registered as a player
 * (createRemotePlayer -> createPlayer): it enters the player registry, gets a
 * validated PlayerInfoComponent, and fires PlayerCreatedEvent. We never call a
 * native spawn API; spawning the template is enough.
 *
 * REMOTE, NOT LOCAL -- AND THAT IS CORRECT
 * The bot registers as a REMOTE player (isLocal=false). `isLocalPlayer()`/
 * `getLocalPlayer()` will never return it, and they SHOULD NOT: "local player"
 * means "the human sitting at THIS client," and a bot is never that. Trying to
 * force isLocal=true would hijack a real human's camera/input/UI. So a bot is a
 * networked participant that everyone sees -- exactly a backfill bot.
 *
 * OWNERSHIP IS THE CALLER'S CALL
 * This service cannot see who is calling it -- it is a context-global singleton,
 * not an entity -- so it cannot infer the caller's ownership. Ownership is
 * therefore an explicit argument: `spawnBotPlayer(serverOwned)`, defaulting to
 * true. Every caller should pass it deliberately rather than inherit the default
 * by accident. Server-owned is the right answer for backfill (the bot outlives
 * any one client), so that is the default; pass false when the calling client
 * should own and drive the bot itself.
 *
 * Whoever ends up owning the bot is responsible for removing it (e.g. on its own
 * disconnect); every other peer sees it as a proxy. Authority/dedup policy --
 * deciding WHICH context spawns so peers don't each spawn a set -- is also the
 * caller's job, not this primitive's: callers driven by lifecycle events must
 * gate themselves on NetworkingService.isServerContext(), because those events
 * are broadcasts that fire on the server AND on every client.
 *
 * >>> GUIDANCE FOR GAME CONTENT:
 * >>> To branch "does the player run locally or remotely?", use the ENTITY's
 * >>> ownership -- `entity.isOwned()` -- NOT `PlayerService.isLocalPlayer()`.
 * >>> isLocalPlayer answers "is this the one human at this screen" and silently
 * >>> excludes bots; isOwned() answers "do I have authority to drive this
 * >>> entity," which is true on the bot's owning client and correctly extends to
 * >>> human players too (a human owns their own player). Reserve isLocalPlayer
 * >>> ONLY for genuinely human-peripheral things: binding controller/headset
 * >>> input, attaching the local camera, and personal UI (pause/warning/ban).
 *
 * SPAWN POINTS
 * Bots start where humans start. The engine only applies SpawnPoint placement
 * on its local-player creation path, never on template spawning, so a bot would
 * otherwise land on the template's authored transform (usually the world
 * origin). This service therefore resolves a SpawnPoint itself when the caller
 * does not supply a position -- see WorldsSpawnPointPicker. An explicit position
 * always wins, so callers that want a specific placement are unaffected.
 *
 * TEMPLATE SOURCE
 * Ideally we would read the player template straight off the scene's
 * WorldPlayerConfig, but that component is NOT exposed to the `meta/worlds` TS
 * SDK today (it only exists in the native `.hwit`), and surfacing it would mean
 * touching C++/codegen -- out of scope for the pure-TS path. So the template is
 * supplied via `setPlayerTemplate()` (e.g. from an editor-assigned `@property`
 * on a placer component). There is no runtime API to assemble a template
 * procedurally, so if no template has been supplied, `spawnBotPlayer()` throws.
 *
 * Callers use `WorldsBotPlayerService.get()`; do not cache the handle (it does
 * not survive hot-reload). The bot roster IS auto-preserved across hot-reload.
 */
@service()
export class WorldsBotPlayerService extends Service {
  // The player template every bot is spawned from. Supplied via
  // setPlayerTemplate() because WorldPlayerConfig is not TS-readable (see class
  // doc). Null until a caller provides it.
  private playerTemplate: Maybe<TemplateAsset> = null;

  // Live bots this service spawned. Entities, not ids -- the whole point of the
  // pure-TS path is that spawnTemplate hands back a resolved Entity, and callers
  // want Maybe<Entity> anyway.
  //
  // Keying a Set on the handle is safe: the SDK interns entity handles in one
  // registry per entity id, so the handle from spawnTemplate is the SAME object
  // an event payload or an EntityService query later hands back, and reference
  // equality holds for the entity's whole lifetime.
  private bots: Set<Entity> = new Set();

  // Bumped every time the roster is emptied wholesale. spawnBotPlayer() samples
  // it before its await and re-checks after: a bot spawned across a
  // removeAllBots() is not in the roster at the moment the roster is cleared, so
  // without this it would survive the clear and then be added back to a roster
  // the caller believes it just emptied -- a networked player entity nobody owns.
  private rosterGeneration: number = 0;

  /**
   * Supply the player template used for every subsequent spawn. Pass the same
   * asset the world assigns to its players (an editor `@property()
   * playerTemplate: Maybe<TemplateAsset>` on a placer component is the usual
   * source). Passing null clears it and makes spawnBotPlayer() throw again.
   */
  public setPlayerTemplate(template: Maybe<TemplateAsset>): void {
    this.playerTemplate = template;
  }

  /** The template currently configured, or null if none has been supplied. */
  public getPlayerTemplate(): Maybe<TemplateAsset> {
    return this.playerTemplate;
  }

  /**
   * Spawn one bot as a networked player from the configured player template, add
   * it to the roster, and return the resolved entity. Mirrors the native RFC's
   * `spawnBotClient()`, but pure-TS and returning `Maybe<Entity>`.
   *
   * Resolves to the bot entity, or null if the spawn resolved to no entity or
   * was cancelled by a removeAllBots() that landed while it was in flight.
   *
   * @param serverOwned - who owns the bot. True (the default) hands it to the
   * server, so it outlives any one client -- the right choice for backfill. Pass
   * false to keep it on the calling client. Pass this explicitly: the service
   * cannot see who is calling it, so it cannot infer the answer (see class doc).
   * @param position - spawn position. Omit (or pass null) to place the bot at a
   * world SpawnPoint, the way a human player is placed.
   * @param rotation - spawn rotation. Omit (or pass null) to take the rotation
   * of the chosen SpawnPoint.
   * @param spawnPointTag - restrict SpawnPoint selection to points carrying this
   * tag. Ignored when both a position and a rotation are given, since no
   * SpawnPoint is consulted then.
   *
   * REJECTS (not throws -- this is async, so the error arrives as a rejected
   * promise, never synchronously at the call site) with an Error if no player
   * template has been supplied. There is no way to build one procedurally, so
   * that is unrecoverable rather than a silent no-op. Await this call or attach
   * a .catch(); calling it fire-and-forget turns a missing template into an
   * unhandled rejection. Callers that would rather branch than catch can check
   * getPlayerTemplate() first.
   */
  public async spawnBotPlayer(
    serverOwned: boolean = true,
    position?: Maybe<Vec3>,
    rotation?: Maybe<Quaternion>,
    spawnPointTag?: Maybe<string>,
  ): Promise<Maybe<Entity>> {
    if (this.playerTemplate == null) {
      throw new Error(
        '[WorldsBotPlayerService] No player template configured. Call ' +
          'setPlayerTemplate() with the world player template before spawning; ' +
          'a template cannot be assembled procedurally at runtime.',
      );
    }

    // Resolve a SpawnPoint whenever the caller left EITHER half of the
    // placement open, and fill in only the half they omitted -- supplying a
    // position must not silently cost you the spawn point's rotation. If there
    // are no usable spawn points, both halves fall through to the template's
    // authored transform, same as before.
    const placement =
      position == null || rotation == null
        ? pickPlayerSpawnPoint(spawnPointTag)
        : null;

    // Sampled before the await; compared after. See rosterGeneration.
    const generation = this.rosterGeneration;

    const bot = await WorldService.get().spawnTemplate({
      templateAsset: this.playerTemplate,
      networkMode: NetworkMode.Networked,
      position: position ?? placement?.position ?? undefined,
      rotation: rotation ?? placement?.rotation ?? undefined,
      // Only affects client-spawned objects: a server spawn is server-owned
      // regardless, and true here transfers a client spawn to the server.
      serverOwned,
    });

    if (bot == null) {
      console.warn(
        '[WorldsBotPlayerService] spawnTemplate resolved with no entity; no bot added.',
      );
      return null;
    }

    if (generation !== this.rosterGeneration) {
      // The roster was emptied while this spawn was in flight. Adding the bot
      // now would resurrect a population the caller asked to be rid of, so
      // honour the clear: destroy it and report no bot.
      if (!bot.isDestroyed()) {
        bot.destroy();
      }
      return null;
    }

    this.bots.add(bot);
    return bot;
  }

  /**
   * Remove one specific bot this service spawned and drop it from the roster.
   * Mirrors the native RFC's `removeBotClient(id)`. Safe to call with a null or
   * already-destroyed entity (no-op). Only removes bots in this roster, so it
   * can never destroy a human player.
   */
  public removeBotPlayer(bot: Maybe<Entity>): void {
    if (bot == null || !this.bots.has(bot)) {
      return;
    }
    // Drop from the roster BEFORE destroying so a re-entrant call can never
    // observe a half-removed bot or re-drive a destroyed entity.
    this.bots.delete(bot);
    if (!bot.isDestroyed()) {
      bot.destroy();
    }
  }

  /**
   * Drop a bot from the roster WITHOUT destroying it. Use when the bot entity was
   * already torn down by some other path (world teardown, owner disconnect, an
   * external destroy()), so the roster does not keep a stale handle. Safe with
   * null or an entity not in the roster (no-op).
   */
  public forgetBot(bot: Maybe<Entity>): void {
    if (bot == null) {
      return;
    }
    this.bots.delete(bot);
  }

  /** Number of live bots in the roster (destroyed handles are swept first). */
  public getBotCount(): number {
    this.pruneDestroyed();
    return this.bots.size;
  }

  /**
   * Remove every bot this service spawned and empty the roster. Also cancels
   * any spawn still in flight: that bot is destroyed on arrival rather than
   * joining a roster the caller just emptied.
   */
  public removeAllBots(): void {
    this.rosterGeneration++;
    // Snapshot first: removeBotPlayer() mutates the Set as it goes.
    for (const bot of Array.from(this.bots)) {
      this.removeBotPlayer(bot);
    }
  }

  // Drop any handles whose entity was destroyed outside removeBotPlayer(), so the
  // roster (and getBotCount) never over-reports. Snapshot first: we mutate the Set.
  private pruneDestroyed(): void {
    for (const bot of Array.from(this.bots)) {
      if (bot.isDestroyed()) {
        this.bots.delete(bot);
      }
    }
  }
}
