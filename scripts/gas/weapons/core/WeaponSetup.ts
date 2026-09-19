/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

import {GASAbilityData} from '../../abilities/GASAbilityData';
import type {AbilityConstructor} from '../../abilities/GASAbility';
import {GASAttributeData} from '../../attributes/GASAttributeData';
import {GASComponent} from '../../core/GASComponent';
import {DurationPolicy, MagnitudeMode, ModifierOperator} from '../../core/Enums';
import {GASEffectData} from '../../effects/GASEffectData';
import {GASEffectModifier} from '../../effects/GASEffectModifier';
import {WeaponFireAbilityBase} from './WeaponFireAbilityBase';
import type {WeaponConfigProvider, WeaponFireConfigBase} from './WeaponFireAbilityBase';
import {WeaponReloadAbility} from './WeaponReloadAbility';
import type {ReloadConfigProvider} from './WeaponReloadAbility';

/**
 * Start-up wiring shared by every weapon type: seed the magazine, build the
 * damage effect, build the per-shot ammo cost. Free functions rather than a base
 * component, because weapon types differ in which pieces they use.
 */

/** Default attribute the damage effect subtracts from. */
export const HEALTH_ATTR = 'health';

// Base attribute names; `weaponKey` namespaces them per weapon instance.
const AMMO_ATTR = 'ammo';
const RESERVE_ATTR = 'ammoReserve';

/**
 * Owner state tag, deliberately global (unprefixed) and shared by every weapon
 * family: reloading should block firing from any source, and an external stun
 * or disarm effect must be able to set the same tag without knowing what is
 * equipped.
 */
export const RELOADING_TAG = 'State.Reloading';

/** Names and objects a weapon needs afterwards to reach its own GAS state. */
export interface WeaponRuntime {
  ammoAttr: string;
  fireAbilityId: string;
  reloadAbilityId: string;
  damageEffect: GASEffectData;

  /** undefined when no reserve was seeded — the reload ability reads that as infinite. */
  reserveAttr: string | undefined;
}

/** Which ability class delivers the shot, and what to name the granted pair. */
export interface WeaponAbilitySpec {
  fireAbility: AbilityConstructor;
  /** Unprefixed fire ability id, e.g. 'weapon.hitscan.fire'. */
  fireAbilityName: string;
  /** Unprefixed reload ability id, e.g. 'weapon.hitscan.reload'. */
  reloadAbilityName: string;
}

export interface WeaponSetupOptions<TConfig extends WeaponFireConfigBase> {
  gas: GASComponent;
  magazineSize: number;
  fireRate: number;
  damage: number;
  damageEffectId: string;

  /** Receives both ability config callbacks; in practice the weapon component. */
  provider: WeaponConfigProvider<TConfig> & ReloadConfigProvider;

  /** Namespaces this weapon's attributes and ability ids. '' for a single weapon. */
  weaponKey: string;

  /** 0 = infinite reserve; no reserve attribute is seeded at all. */
  reserveAmmo: number;

  /** The attribute damage drains — health, or a shield / armour pool. */
  healthAttribute: string;
}

/**
 * Seed the magazine, register the damage effect, and grant the fire + reload
 * abilities for one weapon. Delivery-agnostic: `spec` decides which fire
 * ability is granted, everything else is identical across weapon families.
 *
 * The fire ability is blocked by {@link RELOADING_TAG}; re-entry during a shot
 * is refused by the ability itself rather than by another tag.
 */
export function setupWeapon<TConfig extends WeaponFireConfigBase>(
  options: WeaponSetupOptions<TConfig>,
  spec: WeaponAbilitySpec,
): WeaponRuntime {
  const {gas, provider, weaponKey} = options;

  const ammoAttr = prefixed(weaponKey, AMMO_ATTR);
  const reserveAttr = prefixed(weaponKey, RESERVE_ATTR);
  const fireAbilityId = prefixed(weaponKey, spec.fireAbilityName);
  const reloadAbilityId = prefixed(weaponKey, spec.reloadAbilityName);

  const ammoData = seedAmmoAttribute(gas, ammoAttr, options.magazineSize);
  const hasReserve = options.reserveAmmo > 0;
  if (hasReserve) {
    seedReserveAttribute(gas, reserveAttr, options.reserveAmmo);
  }

  const damageEffect = createDamageEffect(
    options.damageEffectId,
    options.damage,
    options.healthAttribute,
  );

  gas.grantAbility(
    new GASAbilityData({
      abilityId: fireAbilityId,
      cooldown: options.fireRate > 0 ? 1 / options.fireRate : 0,
      costEffect: createAmmoCostEffect(ammoData),
      blockedByTags: [RELOADING_TAG],
    }),
    spec.fireAbility,
  );
  const fireAbility = gas.getAbility(fireAbilityId);
  if (fireAbility instanceof WeaponFireAbilityBase) {
    fireAbility.configProvider = provider;
  }

  gas.grantAbility(
    new GASAbilityData({
      abilityId: reloadAbilityId,
      tagsAppliedToOwner: [RELOADING_TAG],
      blockedByTags: [RELOADING_TAG],
    }),
    WeaponReloadAbility,
  );
  const reloadAbility = gas.getAbility(reloadAbilityId);
  if (reloadAbility instanceof WeaponReloadAbility) {
    reloadAbility.configProvider = provider;
  }

  return {
    ammoAttr,
    reserveAttr: hasReserve ? reserveAttr : undefined,
    fireAbilityId,
    reloadAbilityId,
    damageEffect,
  };
}

/**
 * Namespace one weapon's attribute and ability names. Two weapons on the same
 * avatar MUST use different prefixes: a second registration under an existing
 * key is silently ignored, so they would share one magazine and one ability.
 */
export function prefixed(prefix: string, name: string): string {
  return prefix.length > 0 ? `${prefix}.${name}` : name;
}

/**
 * Seed the magazine full. Returns the attribute data so the caller can pass the
 * very same instance to {@link createAmmoCostEffect}.
 */
export function seedAmmoAttribute(
  gas: GASComponent,
  attributeName: string,
  magazineSize: number,
): GASAttributeData {
  const ammo = new GASAttributeData({
    attributeName,
    defaultValue: magazineSize,
    minValue: 0,
    maxValue: magazineSize,
  });
  gas.tryAddAttribute(ammo);
  return ammo;
}

/**
 * Seed the spare-rounds attribute full. Omit the call entirely for an infinite
 * reserve — the reload ability reads a missing attribute as "always refill",
 * so seeding 0 would mean the opposite.
 */
export function seedReserveAttribute(
  gas: GASComponent,
  attributeName: string,
  reserveAmmo: number,
): void {
  gas.tryAddAttribute(
    new GASAttributeData({
      attributeName,
      defaultValue: reserveAmmo,
      minValue: 0,
      maxValue: reserveAmmo,
    }),
  );
}

/**
 * Definitions already built here, keyed by effect id. Every weapon INSTANCE runs
 * setup, so N players carrying one weapon type would otherwise build N distinct
 * GASEffectData under one id — and `registerEffect` compares by object identity,
 * so it would treat them as a conflict, drop the id and blacklist it, leaving
 * every one of those weapons unable to deal damage.
 */
const damageEffects = new Map<string, {effect: GASEffectData; damage: number; attribute: string}>();

/**
 * Flat -damage on `attributeName` (health, or a shield / armour pool), registered
 * by id so a remote target's authority resolves the same effect from its own
 * registry. For per-shot dynamic damage build a SetByCaller effect instead.
 *
 * Instances of the same weapon type share one definition. Two DIFFERENT weapons
 * under one id still fall through to `registerEffect`, which rejects the
 * conflict — one id must mean one thing on every machine.
 */
export function createDamageEffect(
  effectId: string,
  damage: number,
  attributeName: string = HEALTH_ATTR,
): GASEffectData {
  const cached = damageEffects.get(effectId);
  if (cached && cached.damage === damage && cached.attribute === attributeName) {
    return cached.effect;
  }
  const effect = new GASEffectData({
    effectId,
    durationPolicy: DurationPolicy.Instant,
  });
  effect.modifiers.push(
    new GASEffectModifier({
      attribute: new GASAttributeData({attributeName}),
      operator: ModifierOperator.Add,
      mode: MagnitudeMode.Scalar,
      scalarValue: -damage,
    }),
  );
  GASComponent.registerEffect(effect);

  // Cache only what actually registered: an empty id is never stored, and a
  // rejected conflict must not be handed to the next instance.
  if (GASComponent.getRegisteredEffect(effectId) === effect) {
    damageEffects.set(effectId, {effect, damage, attribute: attributeName});
  }
  return effect;
}

/**
 * -1 ammo per activation, as an ability cost effect. Pass the instance returned
 * by {@link seedAmmoAttribute}: `canPayCost` reads `minValue` off it, so a fresh
 * GASAttributeData would let the magazine go negative. Left unregistered — cost
 * effects apply to self on the activating machine and never cross the wire.
 */
export function createAmmoCostEffect(ammo: GASAttributeData): GASEffectData {
  const cost = new GASEffectData({durationPolicy: DurationPolicy.Instant});
  cost.modifiers.push(
    new GASEffectModifier({
      attribute: ammo,
      operator: ModifierOperator.Add,
      mode: MagnitudeMode.Scalar,
      scalarValue: -1,
    }),
  );
  return cost;
}
