/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v1

import {
  component,
  property,
  editor,
  type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {SimpleFetchBehavior} from './SimpleFetchBehavior';
import {BehaviorStarterComponent} from './BehaviorStarterComponent';
import {PickupItemSlot} from 'meta/worlds';

/**
 * Automatically starts a simple fetch behavior for a given Actor.
 * The Actor will walk to the item, pick it up, and deliver it to the drop-off point.
 */
@component()
export class StartSimpleFetchBehaviorComponent extends BehaviorStarterComponent {
  @property()
  itemToPickUp: Entity | null = null;

  @property()
  itemDropOffPoint: Entity | null = null;

  @property()
  itemPickupRange: number = 1.0;

  @property()
  moveSpeed: number = 5.0;

  /**
   * Typed `number` rather than `PickupItemSlot` on purpose. An enum-typed
   * `@property` reflects as `NativeTypeId::Enum`, which no `.hstf` in the repo
   * serialises and the live-property codec does not handle, so a scene-authored
   * value never reaches this field and the slot stays `None` — which
   * `ActorPickupItemComponent.pickupItem` rejects outright. A plain number
   * reflects as `Flt64`. Same workaround as `CameraManager.cameraMode`.
   */
  @property()
  @editor({
    description:
      `Which hand to use for pickup: ${PickupItemSlot.RightHand} RightHand, ` +
      `${PickupItemSlot.LeftHand} LeftHand. 🚨 Template gotcha: stored as ` +
      `${PickupItemSlot.None} (None) on a template instance, which pickupItem ` +
      `rejects — set explicitly to ${PickupItemSlot.RightHand}.`,
  })
  pickupHand: number = PickupItemSlot.RightHand;

  @property()
  basePriority: number = 20;

  @property()
  @editor({description: 'Seconds to wait before starting the fetch cycle. Prevents instant completion during scene loading.'})
  startDelay: number = 2.0;

  protected override locomotionStarterName(): string {
    return 'StartSimpleFetchBehaviorComponent';
  }

  override startBehavior(): SimpleFetchBehavior | void {
    if (!this.controlledActor) {
      console.error('StartSimpleFetchBehaviorComponent: Controlled Actor not set!');
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('StartSimpleFetchBehaviorComponent: No ActorSdkLogicComponent on controlled Actor!');
      return;
    }

    const fetchBehavior = new SimpleFetchBehavior();
    fetchBehavior.itemToPickUp = this.itemToPickUp;
    fetchBehavior.itemDropOffPoint = this.itemDropOffPoint;
    fetchBehavior.itemPickupRange = this.itemPickupRange;
    fetchBehavior.moveSpeed = this.moveSpeed;
    fetchBehavior.pickupSlot = this.resolveHandSlot(
      this.pickupHand,
      'StartSimpleFetchBehaviorComponent',
    );
    fetchBehavior.basePriority = this.basePriority;
    fetchBehavior.startDelay = this.startDelay;

    actorLogic.addBehavior(fetchBehavior, this.removeDuplicates);
    return fetchBehavior;
  }
}
