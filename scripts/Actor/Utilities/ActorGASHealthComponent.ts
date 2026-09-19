/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v1

import {
  component,
  editor,
  property,
  subscribe,
  ExecuteOn,
  NetworkingService,
  OnEntityCreateEvent,
  OnEntityDestroyEvent,
  Service,
  ActorSdkBlackboardManager,
  ActorSdkLogicComponent,
  ActorHealthControllerData,
  ActorHealthControllerTypeId,
  BlackboardScope,
  type ActorHealthController,
} from 'meta/worlds';
import {CombatBlackboard} from '../Core/Blackboard/Implementations/CombatBlackboard';
import {CharacterGASComponent} from '../../gas/CharacterGASComponent';
import {HEALTH_ATTR} from '../../gas/weapons/core/WeaponSetup';

/**
 * NPC health: {@link CharacterGASComponent} plus the Actor Framework adapters —
 * `ActorHealthController` registration, blackboard death reporting, the `isHit`
 * window and combat telemetry. Health itself is inherited unchanged.
 */
@component({
  description:
    'NPC health. Inherits the shared GAS health component and adds the Actor Framework health controller, blackboard death reporting, hit window and combat telemetry.',
})
export class ActorGASHealthComponent
  extends CharacterGASComponent
  implements ActorHealthController
{
  @editor({
    description:
      'Blackboard group ID for faction-based combat target tracking. Leave empty to skip blackboard updates.',
  })
  @property()
  public blackboardGroupId: string = '';

  @editor({
    description: 'Seconds the hit flag stays raised after damage, for behaviors that poll it.',
  })
  @property()
  public hitDuration: number = 0.5;

  /** Damage applications this actor has survived-or-died to, counted per life. */
  public hitCount: number = 0;

  /** Raised for {@link hitDuration} after a survivable hit; read via getHealthData. */
  public isHit: boolean = false;

  protected blackboardManager = Service.inject(ActorSdkBlackboardManager);
  private actorLogicComponent: ActorSdkLogicComponent | null = null;
  private hitResetTimeoutId: ReturnType<typeof setTimeout> | null = null;

  @subscribe(OnEntityCreateEvent, {execution: ExecuteOn.Everywhere})
  onActorHealthCreate(): void {
    this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
    // Reset for pooled reuse.
    this.hitCount = 0;
    this.isHit = false;
    if (this.entity.isOwned()) {
      this.registerActorController();
    }
  }

  @subscribe(OnEntityDestroyEvent)
  onActorHealthDestroy(): void {
    if (this.hitResetTimeoutId != null) {
      clearTimeout(this.hitResetTimeoutId);
      this.hitResetTimeoutId = null;
    }
    this.unregisterActorController();
  }

  // --- ActorHealthController -------------------------------------------------

  getHealthData(): ActorHealthControllerData {
    return Object.assign(new ActorHealthControllerData(), {
      maxHealth: this.maxHealth,
      currentHealth: this.health,
      isDead: this.isDead,
      isHit: this.isHit,
    });
  }

  /** Writes land on the GAS attribute, not a local copy. */
  setHealthData(data: ActorHealthControllerData): void {
    this.maxHealth = data.maxHealth;
    this.setAttributeBase(HEALTH_ATTR, data.currentHealth);
    this.isHit = data.isHit;
  }

  registerActorController(): void {
    this.actorLogicComponent?.registerController(ActorHealthControllerTypeId, this);
  }

  unregisterActorController(): void {
    this.actorLogicComponent?.unregisterController(this);
  }

  // --- damage and death ------------------------------------------------------

  /** Damage only; the base promotes the attacker and plays the flinch. */
  protected override onDamaged(amount: number, remainingHealth: number): void {
    super.onDamaged(amount, remainingHealth);

    this.hitCount += 1;
    this.emitCombatTelemetry('hit', amount, remainingHealth);
    if (remainingHealth <= 0) {
      this.emitCombatTelemetry('death', amount, 0);
      return;
    }
    if (!this.entity.isOwned()) {
      return;
    }
    this.isHit = true;
    if (this.hitResetTimeoutId != null) {
      clearTimeout(this.hitResetTimeoutId);
    }
    // Gameplay window only; the animation exits on the graph's own gate.
    this.hitResetTimeoutId = setTimeout(() => {
      this.isHit = false;
      this.hitResetTimeoutId = null;
    }, this.hitDuration * 1000);
  }

  protected override applyDeath(): void {
    super.applyDeath();
    if (!this.blackboardGroupId) {
      return;
    }
    const combatBlackboard = this.blackboardManager.getBlackboard(
      CombatBlackboard,
      /* actorId */ undefined,
      this.blackboardGroupId,
      BlackboardScope.Group,
    );
    combatBlackboard?.updateTarget(this.entity, {isDead: true}, false);
  }

  /** Server-only, so a landed hit is one line rather than one per client. */
  private emitCombatTelemetry(event: 'hit' | 'death', amount: number, health: number): void {
    if (!NetworkingService.get().isServerContext()) {
      return;
    }
    const name = this.entity?.valid ? this.entity.name : '<destroyed>';
    console.log(
      `[ActorCombatTelemetry] event=${event} target=${name} damage=${amount} hits=${this.hitCount} health=${health}`,
    );
  }
}
