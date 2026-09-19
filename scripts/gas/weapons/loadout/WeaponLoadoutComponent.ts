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
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnOwnershipTransferEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  PlayerInputService,
  PlayerInputAction,
  PlayerInputState,
  PlayerInputActionCallbackPayload,
  PlayerInputSubscription,
  InputVisualConfigAsset,
  Vec3,
  type Entity,
  type Maybe,
  type TemplateAsset,
} from 'meta/worlds';
import {GASComponent} from '../../core/GASComponent';
import {DEFAULT_MUZZLE_OFFSET, MuzzleAimProvider} from '../core/AimProvider';
import type {Aim, AimProvider} from '../core/AimProvider';
import {WeaponInputComponent, parsePlayerInputAction} from '../core/WeaponInputComponent';
import type {TriggerSink} from '../core/WeaponInputComponent';
import {WeaponTrigger} from '../core/WeaponTrigger';
import {HEALTH_ATTR, setupWeapon} from '../core/WeaponSetup';
import type {WeaponRuntime} from '../core/WeaponSetup';
import type {ReloadConfig, ReloadConfigProvider} from '../core/WeaponReloadAbility';
import {PROJECTILE_ABILITIES} from '../projectile/WeaponProjectileFireAbility';
import type {
  ProjectileWeaponConfigProvider,
  ProjectileWeaponFireConfig,
} from '../projectile/WeaponProjectileFireAbility';
import type {WeaponStats} from './WeaponCatalog';

/**
 * One weapon's GAS state plus the two config callbacks its abilities read.
 *
 * A slot per weapon rather than one shared provider on the component: each
 * weapon's abilities hold a reference to their own slot, so an ability can only
 * ever be handed its own weapon's numbers, whichever one is equipped.
 */
class WeaponSlot implements ProjectileWeaponConfigProvider, ReloadConfigProvider {
  public runtime: WeaponRuntime | null = null;

  constructor(
    public readonly stats: WeaponStats,
    private readonly owner: WeaponLoadoutComponent,
  ) {}

  public buildFireConfig(): ProjectileWeaponFireConfig | null {
    const runtime = this.runtime;
    const template = this.owner.projectileTemplate;
    const aim = this.owner.getAim();
    if (!runtime || !template || !aim) {
      return null;
    }
    const damageEffect = runtime.damageEffect;
    return {
      template,
      speed: this.stats.speed,
      lifetimeSec: this.stats.lifetimeSec,
      origin: aim.origin,
      direction: aim.direction,
      pelletCount: this.stats.pelletCount,
      spreadDeg: this.stats.spreadDeg,
      targetFilter: this.owner.targetFilter(),
      refreshAim: (): Aim | null => this.owner.getAim(),
      onHit: (target: Entity): void => this.owner.applyDamage(target, damageEffect),
    };
  }

  public buildReloadConfig(): ReloadConfig | null {
    const runtime = this.runtime;
    if (!runtime) {
      return null;
    }
    return {
      ammoAttr: runtime.ammoAttr,
      reserveAttr: runtime.reserveAttr,
      magazineSize: this.stats.magazineSize,
      reloadTimeSec: this.stats.reloadTimeSec,
    };
  }
}

/**
 * Carries several projectile weapons on one character and switches between them
 * with a button. Abstract: a subclass supplies the loadout. See
 * DemoWeaponLoadout.
 *
 * The weapons come from a {@link WeaponStats} array in code rather than from
 * `@property` blocks, which is what lets one component hold a whole loadout:
 * properties cannot be iterated, so an editor-authored loadout needs one
 * component instance per weapon. See WeaponProjectileComponent for that shape —
 * it remains the right one for a single weapon, a turret, or an NPC.
 *
 * Every weapon registers its own magazine and abilities on start under its own
 * `key`, so switching away and back preserves each weapon's ammo. Only the
 * equipped one is driven.
 */
@component({
  description: 'Carries several projectile weapons and switches between them with a button.',
})
export abstract class WeaponLoadoutComponent extends Component implements TriggerSink {
  /**
   * The weapons this loadout carries, in switch order. A getter rather than a
   * field so the data cannot be a default that callers have no working moment
   * to replace — component start order is not guaranteed, so anything assigned
   * from another component may or may not land before {@link onEntityStart}.
   */
  protected abstract get weapons(): readonly WeaponStats[];

  @editor({
    description:
      'The bullet template, shared by every weapon in the loadout. Must carry a ' +
      'GASProjectile, a collider, and a PhysicsBody of type Trigger.',
  })
  @property()
  public projectileTemplate: Maybe<TemplateAsset> = null;

  // The @editor description is extracted statically, so the legal action names
  // are spelled out rather than read from the input map. The runtime warning in
  // parsePlayerInputAction is generated from that map and stays correct.

  @editor({
    description:
      'Action that cycles to the next weapon. PrimaryLeft, PrimaryRight, SecondaryLeft, ' +
      'SecondaryRight, TertiaryLeft, TertiaryRight, or ExtraActionOne through ExtraActionFour. ' +
      'Must differ from the fire and reload actions on WeaponInputComponent.',
  })
  @property()
  public switchAction: string = 'ExtraActionOne';

  @editor({
    description:
      'The .inputconfig asset for the switch button. Leave empty and no button ' +
      'appears — switching then only works from script.',
  })
  @property()
  public switchButtonConfig: Maybe<InputVisualConfigAsset> = null;

  @editor({
    description:
      'Where shots leave the body, relative to the character: x = right, y = up, ' +
      'z = forward. Aim direction always follows the camera; this is the origin only.',
  })
  @property()
  public muzzleOffset: Vec3 = DEFAULT_MUZZLE_OFFSET;

  @editor({
    description:
      'Only entities carrying this GAS tag can be damaged. Empty = anything with ' +
      'a GASComponent, including teammates.',
  })
  @property()
  public targetTag: string = '';

  private readonly slots: WeaponSlot[] = [];
  private activeIndex: number = 0;
  private gas: GASComponent | null = null;
  private trigger: WeaponTrigger | null = null;
  private aimProvider: AimProvider | null = null;
  private switchSub: PlayerInputSubscription | null = null;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onEntityStart(): void {
    const gas = this.entity.getComponent(GASComponent);
    if (!gas) {
      console.error('[WeaponLoadout] entity has no GASComponent; a weapon needs one.');
      return;
    }
    this.gas = gas;
    this.aimProvider = new MuzzleAimProvider(this.muzzleOffset);

    for (const stats of this.weapons) {
      const slot = new WeaponSlot(stats, this);
      slot.runtime = setupWeapon(
        {
          gas,
          provider: slot,
          weaponKey: stats.key,
          magazineSize: stats.magazineSize,
          // Infinite. A reserve is a resource a game has to let the player
          // replenish, and a loadout has no pickup model; 0 means every reload
          // refills, so ammo stays a pacing device rather than a dead end.
          reserveAmmo: 0,
          fireRate: stats.fireRate,
          damage: stats.damage,
          // Derived, not authored. Two weapons sharing one effect id is a
          // conflict the registry resolves by disabling BOTH, and a hand-filled
          // id is exactly the field a designer forgets to make unique.
          damageEffectId: `weapon.loadout.${stats.key}`,
          healthAttribute: HEALTH_ATTR,
        },
        PROJECTILE_ABILITIES,
      );
      this.slots.push(slot);
    }

    this.equip(0);
    this.entity.getComponent(WeaponInputComponent)?.bind(this);
    this.refreshSwitchBinding();
  }

  /** Cycle to the next weapon. Wired to the switch button; also callable from script. */
  public nextWeapon(): void {
    this.equip(this.activeIndex + 1);
  }

  /**
   * Equip by index, wrapping. Rebuilds the trigger because fire mode is
   * per-weapon, and that drops any held state — switching mid-burst must not
   * leave an automatic weapon firing with nothing driving its release.
   */
  public equip(index: number): void {
    const count = this.slots.length;
    if (count === 0) {
      return;
    }
    this.trigger?.reset();
    this.activeIndex = ((index % count) + count) % count;
    const stats = this.slots[this.activeIndex].stats;
    this.trigger = new WeaponTrigger(stats.fireMode);
    console.log(`[WeaponLoadout] equipped ${stats.displayName}`);
  }

  // ── TriggerSink ───────────────────────────────────────────────────

  public pullTrigger(): void {
    if (this.trigger?.pull() === true) {
      this.activate(this.active?.runtime?.fireAbilityId);
    }
  }

  public releaseTrigger(): void {
    this.trigger?.release();
  }

  public reload(): void {
    this.activate(this.active?.runtime?.reloadAbilityId);
  }

  // ── Shared by every slot ──────────────────────────────────────────

  /** Current muzzle and aim direction, or null before start. */
  public getAim(): Aim | null {
    return this.aimProvider?.getAim(this.entity) ?? null;
  }

  /** The tag filter `targetTag` implies, or undefined for "anything with GAS". */
  public targetFilter(): {required: string[]} | undefined {
    return this.targetTag.length > 0 ? {required: [this.targetTag]} : undefined;
  }

  /**
   * Apply one weapon's damage to what its projectile hit. A projectile lands
   * frames after the shot, so the shooter may already be gone — damage is
   * attributed to this character's GAS, and there is nothing to attribute it to
   * once that is destroyed.
   */
  public applyDamage(target: Entity, damageEffect: WeaponRuntime['damageEffect']): void {
    if (this.entity.isDestroyed()) {
      return;
    }
    const targetGas = target.getComponent(GASComponent);
    if (targetGas) {
      this.gas?.applyEffectToTarget(targetGas, damageEffect);
    }
  }

  // ── Driving the equipped weapon ───────────────────────────────────

  /**
   * Sustained fire and auto-reload for the equipped weapon only. Reload is
   * automatic because the demo binds no reload button; both calls are gated by
   * their abilities' own `canActivate`, so polling every frame is cheap.
   */
  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onWorldUpdate(_payload: OnWorldUpdateEventPayload): void {
    const gas = this.gas;
    const runtime = this.active?.runtime;
    if (!this.entity.isOwned() || !gas || !runtime) {
      return;
    }
    if (gas.getAttributeValue(runtime.ammoAttr) <= 0) {
      gas.tryActivateAbility(runtime.reloadAbilityId);
    }
    if (this.trigger?.isFiring === true) {
      gas.tryActivateAbility(runtime.fireAbilityId);
    }
  }

  /**
   * Ownership can arrive after start, and losing it strands a held trigger with
   * no release to follow.
   */
  @subscribe(OnOwnershipTransferEvent, {execution: ExecuteOn.Everywhere})
  onOwnershipTransfer(): void {
    if (!this.entity.isOwned()) {
      this.trigger?.reset();
    }
    this.refreshSwitchBinding();
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onEntityDestroy(): void {
    this.switchSub?.disconnect();
    this.switchSub = null;
  }

  private get active(): WeaponSlot | null {
    return this.slots[this.activeIndex] ?? null;
  }

  private activate(abilityId: string | undefined): void {
    if (abilityId !== undefined) {
      this.gas?.tryActivateAbility(abilityId);
    }
  }

  /** Input is client-local, so the switch button exists only while this client owns us. */
  private refreshSwitchBinding(): void {
    if (!this.entity.isOwned() || !this.switchButtonConfig) {
      this.switchSub?.disconnect();
      this.switchSub = null;
      return;
    }
    if (this.switchSub) {
      return;
    }
    this.switchSub = PlayerInputService.get().subscribePlayerInputAction(
      this,
      parsePlayerInputAction(this.switchAction, PlayerInputAction.ExtraActionOne),
      (payload: PlayerInputActionCallbackPayload) => {
        if (payload.inputState === PlayerInputState.Pressed) {
          this.nextWeapon();
        }
      },
      this.switchButtonConfig,
    );
  }
}
