/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v2

import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  ExecuteOn,
  property,
  editor,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import { DeathBehavior } from '../Behaviors/CoreBehaviors/DeathBehavior';
import { StaggerBehavior } from '../Behaviors/CoreBehaviors/StaggerBehavior';

/**
 * Configures death and stagger behaviors for an actor.
 *
 * Place on the same entity as ActorSdkLogicComponent and the actor's health
 * component — either ActorGASHealthComponent (what BaseActor ships) or
 * ActorHealthComponent; it wires against the ActorHealthController both
 * register, not a specific class. Automatically wires DeathBehavior (claims all
 * controllers on death) and optionally StaggerBehavior (pauses actions during
 * hit reaction).
 */
@component({
  description: 'Configures death and stagger behaviors for an actor. Works with either health component. Handles post-death cleanup and hit stagger.',
})
export class ActorHealthStarterComponent extends Component {
  @property()
  @editor({ description: 'Seconds after death before the entity is destroyed. -1 disables auto-despawn.' })
  despawnTimer: number = -1;

  @property()
  @editor({ description: 'If true, disables collision on death. Warning: entity will fall through the floor.' })
  disableCollisionOnDeath: boolean = false;

  @property()
  @editor({ description: 'Whether to add StaggerBehavior for hit reactions.' })
  enableStagger: boolean = true;

  @property()
  @editor({ description: 'Knockback impulse speed in meters per second applied to this actor when it is staggered. Delivered to the ActorStaggerController via setStaggerParams(). Useful range is roughly 0-10: ground friction decelerates the impulse at about 4.9 m/s^2, so `5` throws a character ~2.5m and `2` throws it ~0.4m. The value is NOT clamped — a negative number inverts the impulse and pulls the actor toward whatever hit it (occasionally what you want, usually a typo), and a very large one launches it across the level. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `5` (a `0` leaves the actor staggering with no knockback at all).' })
  knockbackForce: number = 5;

  @property()
  @editor({ description: 'Base priority for the death behavior.' })
  deathBehaviorPriority: number = 100;

  @property()
  @editor({ description: 'Base priority for the stagger behavior.' })
  staggerBehaviorPriority: number = 100;

  // OnEntityStartEvent can fire more than once for an entity (ownership
  // handoff, re-initialization), and addBehavior does not dedup — a second
  // pass would leave two DeathBehaviors racing over the same controllers.
  private behaviorsRegistered = false;
  // Held so onDestroy can hand the exact instances back to removeBehavior.
  private death: DeathBehavior | null = null;
  private stagger: StaggerBehavior | null = null;

  @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
  onStart() {
    if (this.behaviorsRegistered) {
      return;
    }

    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[ActorHealthStarterComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    this.behaviorsRegistered = true;

    const death = new DeathBehavior();
    death.basePriority = this.deathBehaviorPriority;
    death.despawnTimer = this.despawnTimer;
    death.disableCollisionOnDeath = this.disableCollisionOnDeath;
    actorLogic.addBehavior(death);
    this.death = death;

    if (this.enableStagger) {
      const stagger = new StaggerBehavior();
      stagger.basePriority = this.staggerBehaviorPriority;
      stagger.knockbackForce = this.knockbackForce;
      actorLogic.addBehavior(stagger);
      this.stagger = stagger;
    }
  }

  @subscribe(OnEntityDestroyEvent)
  onDestroy() {
    // Mirrors the sibling controllers' unregisterActorController(). Without
    // this, a pooled/recycled entity keeps the old behaviors on its actor logic
    // while behaviorsRegistered stays latched, so onStart never re-registers.
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (actorLogic) {
      if (this.death) {
        actorLogic.removeBehavior(this.death);
      }
      if (this.stagger) {
        actorLogic.removeBehavior(this.stagger);
      }
    }
    this.death = null;
    this.stagger = null;
    this.behaviorsRegistered = false;
  }
}
