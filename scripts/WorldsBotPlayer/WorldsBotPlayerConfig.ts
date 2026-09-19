/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Bot Player Scripts v1

import {
  Component,
  OnEntityStartEvent,
  TemplateAsset,
  component,
  editor,
  property,
  subscribe,
  type Maybe,
} from 'meta/worlds';
import {WorldsBotPlayerService} from './WorldsBotPlayerService';

/**
 * Editor-placeable config for {@link WorldsBotPlayerService}. Place one in the
 * world. It carries the player template (assigned at authoring time) and hands
 * it to the service, so bots spawn from the same template real players use.
 * This is the ONE place the template is set; nothing else assigns it.
 *
 * TEMPLATE SOURCE / EDITOR-TIME WIRING
 * `playerTemplate` mirrors the world's `WorldPlayerConfig.playerTemplateAsset`.
 * That native config component is NOT exposed to the `meta/worlds` TS SDK, so
 * rather than reading it at runtime we assign the SAME asset here at authoring
 * time -- by hand, or by a tool that reads WorldPlayerConfig out of the scene
 * `.hstf` and drops the asset into this slot. Assigning it as an editor
 * asset-property is also what lets the asset bundler pick the template up as a
 * dependency; a path built at runtime would never be bundled. See the
 * WorldsBotPlayerService header for the full rationale.
 *
 * EXECUTION
 * OnEntityStart is a broadcast: it fires on the server AND on every client, and
 * this component deliberately does NOT narrow that. There is one service
 * instance per context, and each one needs the template, so every context
 * configures its own. This is safe because configuring is idempotent and purely
 * local -- it spawns nothing. Deciding WHICH context actually spawns is the
 * job of whatever drives the service, which must gate itself on
 * NetworkingService.isServerContext() so peers do not each spawn a set.
 */
@component({
  description:
    'Config for the pure-TS bot player system. Carries the player template (mirror of WorldPlayerConfig) and feeds it to WorldsBotPlayerService. Place one per world.',
})
export class WorldsBotPlayerConfig extends Component {
  // The world player template bots spawn from -- assign the SAME asset the world
  // assigns in WorldPlayerConfig. Plain @property (no @editor) to match how other
  // character_template asset slots are authored (e.g. TestRunnerComponent). Leave
  // this null and spawnBotPlayer() REJECTS -- it is async, so the error arrives as
  // a rejected promise, not a synchronous throw a try/catch at the call site
  // would see.
  @property()
  playerTemplate: Maybe<TemplateAsset> = null;

  @property()
  @editor({description: 'Enable debug logging to console.'})
  debugLogEnabled: boolean = false;

  @subscribe(OnEntityStartEvent)
  onStart(): void {
    // Only supply the template when this placer actually carries one, so an empty
    // slot can't clobber a template a code caller already set -- null must never
    // win over a valid asset. Makes the wiring order-independent.
    if (this.playerTemplate != null) {
      WorldsBotPlayerService.get().setPlayerTemplate(this.playerTemplate);
      this.log('supplied the player template to WorldsBotPlayerService');
    } else {
      this.log('no player template on this placer; left the service unchanged');
    }
  }

  private log(...args: unknown[]): void {
    if (this.debugLogEnabled) {
      console.log(`[WorldsBotPlayerConfig] ${this.entityName}:`, ...args);
    }
  }

  private get entityName(): string {
    return this.entity?.valid ? this.entity.name : '<destroyed>';
  }
}
