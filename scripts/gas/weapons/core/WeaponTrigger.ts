/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

/** One shot per trigger pull, or keep firing while the trigger is held. */
export type FireMode = 'semi' | 'auto';

/** Legal `fireMode` values, for warnings and editor descriptions. */
export const FIRE_MODES: readonly string[] = ['semi', 'auto'];

/**
 * Read a designer-written `fireMode`. The editor has no enum property, so an
 * unknown value warns and falls back rather than silently shipping a weapon
 * that fires the wrong way.
 *
 * 'burst' is called out by name: it is the obvious guess, burst fire IS
 * supported, and it is configured with `burstCount` rather than here — so the
 * generic "unknown value" warning would send the reader looking in the wrong
 * place.
 */
export function parseFireMode(value: string): FireMode {
  if (value === 'semi' || value === 'auto') {
    return value;
  }
  if (value === 'burst') {
    console.warn(
      "[Weapon] fireMode 'burst' is not a mode. Set burstCount to fire N rounds " +
        "per trigger pull, and keep fireMode 'semi' or 'auto'. Using 'auto'.",
    );
    return 'auto';
  }
  console.warn(
    `[Weapon] unknown fireMode '${value}'; expected ${FIRE_MODES.join(' or ')}. Using 'auto'.`,
  );
  return 'auto';
}

/**
 * Trigger state: whether it is held, and whether that means a round should go
 * out. Engine-free, so any weapon type can reuse it however the pull is driven —
 * on-screen button, game code, or an auto-aim controller.
 */
export class WeaponTrigger {
  private held: boolean = false;

  constructor(private readonly mode: FireMode) {}

  /**
   * Pull the trigger. Returns true when the pull ITSELF should fire a round —
   * semi only; an automatic weapon fires from {@link isFiring} on the next
   * update so the cooldown gates the rate.
   */
  public pull(): boolean {
    this.held = true;
    return this.mode === 'semi';
  }

  public release(): void {
    this.held = false;
  }

  /** True while an automatic weapon should keep firing. */
  public get isFiring(): boolean {
    return this.held && this.mode === 'auto';
  }

  /**
   * Drop the held state. Required whenever the trigger's driver goes away
   * (buttons unbound, ownership lost): no release will follow, so an automatic
   * weapon would otherwise fire forever.
   */
  public reset(): void {
    this.held = false;
  }
}
