/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {
  Component,
  component,
  editor,
  property,
  subscribe,
  ExecuteOn,
  OnEntityStartEvent,
  OnOwnershipTransferEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  Vec3,
} from 'meta/worlds';
import {GASComponent} from '../../core/GASComponent';
import {DEFAULT_MUZZLE_OFFSET, createAimProvider} from './AimProvider';
import type {AimProvider} from './AimProvider';
import {WeaponInputComponent} from './WeaponInputComponent';
import type {TriggerSink} from './WeaponInputComponent';
import {WeaponTrigger, parseFireMode} from './WeaponTrigger';
import type {ReloadConfig, ReloadConfigProvider} from './WeaponReloadAbility';
import {HEALTH_ATTR} from './WeaponSetup';
import type {WeaponRuntime} from './WeaponSetup';

/**
 * Everything a gun is except how it delivers the shot: a magazine, a reload, a
 * trigger, an aim source, per-weapon GAS namespacing, and the per-frame polling
 * that drives sustained fire.
 *
 * Subclasses add the properties their delivery needs and implement two things —
 * {@link assemble} to grant the abilities, and their own `buildFireConfig` for
 * the fire ability's provider contract. See WeaponHitscanComponent and
 * WeaponProjectileComponent.
 *
 * The `@property` set below is inherited by subclasses and shows up in the
 * editor for each of them; only the delivery-specific fields are redeclared.
 */
@component({
  description: 'Shared weapon behaviour — magazine, reload, trigger, aim. Subclassed per delivery.',
})
export abstract class WeaponComponentBase
  extends Component
  implements ReloadConfigProvider, TriggerSink
{
  // ── Weapon stats ──────────────────────────────────────────────────

  @editor({
    description:
      'Shots per second. 1 = revolver, 5 = pistol, 10 = rifle, 15 = SMG. ' +
      'The fire cooldown is 1 / fireRate.',
  })
  @property()
  public fireRate: number = 5;

  @editor({description: 'Rounds in a full magazine, before a reload is needed.'})
  @property()
  public magazineSize: number = 30;

  @editor({
    description:
      'Deliveries per round. 1 for a normal gun; 8 to 12 for a shotgun. Pair a ' +
      'high count with spreadDeg, or every pellet takes the same line.',
  })
  @property()
  public pelletCount: number = 1;

  @editor({
    description:
      'Inaccuracy cone half-angle in degrees. 0 = perfectly accurate (sniper), ' +
      '2 to 5 = rifle, 8 to 15 = shotgun spread. Fixed — it does not grow while firing.',
  })
  @property()
  public spreadDeg: number = 0;

  @editor({
    description:
      'Rounds per trigger pull. 1 = normal. 3 = a three-round burst. Keep ' +
      '1 / fireRate larger than (burstCount - 1) x burstIntervalSec or bursts overlap.',
  })
  @property()
  public burstCount: number = 1;

  @editor({
    description:
      'Seconds between rounds within one burst, in game time. 0 = the whole ' +
      'burst leaves the muzzle on a single frame.',
  })
  @property()
  public burstIntervalSec: number = 0;

  @editor({
    description:
      'Damage subtracted per hit. Constant: there is no distance falloff and no ' +
      'headshot bonus. Each pellet of a shotgun deals this much.',
  })
  @property()
  public damage: number = 20;

  @editor({
    description:
      'Which attribute the damage drains. Leave as health unless the target ' +
      'carries a separate shield or armour attribute this weapon should hit.',
  })
  @property()
  public healthAttribute: string = HEALTH_ATTR;

  @editor({
    description:
      'Only entities carrying this GAS tag can be damaged. Empty = anything with ' +
      'a GASComponent, including teammates. Use it for factions, e.g. enemy.',
  })
  @property()
  public targetTag: string = '';

  @editor({
    description:
      'Identifies this weapon TYPE, not the instance — every copy of the same gun ' +
      'shares it. Two DIFFERENT weapons must not share an id, or neither deals damage.',
  })
  @property()
  public damageEffectId: string = 'weapon.damage';

  @editor({
    description:
      'Leave empty when the character carries one weapon. Two weapons on the same ' +
      'character MUST have different keys here, or the second one shares the ' +
      'first magazine and never fires.',
  })
  @property()
  public weaponKey: string = '';

  // ── Fire model ────────────────────────────────────────────────────

  // @editor descriptions are extracted statically, so the legal values are
  // spelled out rather than read from FIRE_MODES / AIM_SOURCES. The runtime
  // warnings are generated from those constants and stay correct either way.

  @editor({
    description:
      'semi or auto. Burst fire is NOT set here — keep this semi or auto and ' +
      'set burstCount to the rounds per trigger pull.',
  })
  @property()
  public fireMode: string = 'auto';

  @editor({
    description:
      'camera or forward. camera aims at the crosshair; forward fires out of the ' +
      'muzzle along the owner facing, for turrets and NPCs.',
  })
  @property()
  public aimSource: string = 'camera';

  @editor({
    description:
      'Where the shot leaves the body, relative to the character: x = right, ' +
      'y = up, z = forward. Used for forward aim, and keeps a projectile spawn ' +
      'clear of the owner collider.',
  })
  @property()
  public muzzleOffset: Vec3 = DEFAULT_MUZZLE_OFFSET;

  // ── Reload ────────────────────────────────────────────────────────

  @editor({
    description: 'Seconds a reload takes. Firing is blocked for the whole duration.',
  })
  @property()
  public reloadTimeSec: number = 2;

  @editor({
    description:
      'Spare rounds carried outside the magazine. 0 = infinite ammo, every reload ' +
      'refills to full. Set a number to make ammo a resource.',
  })
  @property()
  public reserveAmmo: number = 0;

  @editor({
    description:
      'Reload by itself the moment the magazine empties. Off = the player must ' +
      'press reload. Turn on for an arcade feel or for NPC weapons.',
  })
  @property()
  public autoReload: boolean = false;

  // ── Debug ─────────────────────────────────────────────────────────

  @editor({
    description:
      'TESTING ONLY. Fires continuously with no buttons wired, to check a weapon ' +
      'works. Turn this off before shipping.',
  })
  @property()
  public debugAutoFire: boolean = false;

  /**
   * Where shots are aimed. Defaulted from `aimSource` on start; a game may
   * replace it at runtime, e.g. with an auto-target provider.
   */
  public aimProvider: AimProvider | null = null;

  protected gas: GASComponent | null = null;
  protected runtime: WeaponRuntime | null = null;
  private trigger: WeaponTrigger | null = null;

  /**
   * Grant this weapon's abilities and seed its GAS state. Called once on start
   * with the sibling GASComponent; return what {@link WeaponSetup} handed back.
   */
  protected abstract assemble(gas: GASComponent): WeaponRuntime;

  /**
   * Assemble the GAS state, pick the default aim, and register with the input
   * component if the designer added one.
   */
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onEntityStart(): void {
    const gas = this.entity.getComponent(GASComponent);
    if (!gas) {
      console.error('[Weapon] entity has no GASComponent; a weapon needs one for ammo/abilities.');
      return;
    }
    this.gas = gas;
    this.trigger = new WeaponTrigger(parseFireMode(this.fireMode));
    this.runtime = this.assemble(gas);
    if (!this.aimProvider) {
      this.aimProvider = createAimProvider(this.aimSource, this.muzzleOffset);
    }
    this.entity.getComponent(WeaponInputComponent)?.bind(this);
  }

  // ── TriggerSink — the driver-agnostic firing surface ──────────────

  /** Begin firing. Semi fires one round now; auto keeps firing while held. */
  public pullTrigger(): void {
    if (this.trigger?.pull() === true) {
      this.activate(this.runtime?.fireAbilityId);
    }
  }

  /** Stop firing (auto mode). */
  public releaseTrigger(): void {
    this.trigger?.release();
  }

  /** Start a reload. No-op if already reloading, magazine full, or reserve empty. */
  public reload(): void {
    this.activate(this.runtime?.reloadAbilityId);
  }

  /**
   * Losing ownership stops the firing loop, and nothing driving the trigger will
   * send a matching release — drop the held state so regaining ownership does
   * not resume firing on its own.
   */
  @subscribe(OnOwnershipTransferEvent, {execution: ExecuteOn.Everywhere})
  onOwnershipTransfer(): void {
    if (!this.entity.isOwned()) {
      this.trigger?.reset();
    }
  }

  /**
   * Drive auto-reload and sustained fire on the authority. Polling both every
   * frame is safe: the reload is gated by `blockedByTags` and by its own
   * `canActivate`, the fire rate by the cooldown and the ammo cost.
   */
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onWorldUpdate(_payload: OnWorldUpdateEventPayload): void {
    const gas = this.gas;
    const runtime = this.runtime;
    if (!this.entity.isOwned() || !gas || !runtime) {
      return;
    }
    if (this.autoReload && gas.getAttributeValue(runtime.ammoAttr) <= 0) {
      gas.tryActivateAbility(runtime.reloadAbilityId);
    }
    if (this.trigger?.isFiring === true || this.debugAutoFire) {
      gas.tryActivateAbility(runtime.fireAbilityId);
    }
  }

  private activate(abilityId: string | undefined): void {
    if (abilityId !== undefined) {
      this.gas?.tryActivateAbility(abilityId);
    }
  }

  /** Parameters for the reload ability. Identical for every delivery. */
  public buildReloadConfig(): ReloadConfig | null {
    const runtime = this.runtime;
    if (!runtime) {
      return null;
    }
    return {
      ammoAttr: runtime.ammoAttr,
      reserveAttr: runtime.reserveAttr,
      magazineSize: this.magazineSize,
      reloadTimeSec: this.reloadTimeSec,
    };
  }

  /** The tag filter this weapon's `targetTag` implies, or undefined for "anything". */
  protected targetFilter(): {required: string[]} | undefined {
    return this.targetTag.length > 0 ? {required: [this.targetTag]} : undefined;
  }
}
