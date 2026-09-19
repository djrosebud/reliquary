/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Interaction Scripts v1

/**
 * SimpleInteractablePromptComponent -- per-object highlight config and
 * default activation handler.
 *
 * Pair with the WSDK `InteractionTargetComponent` from
 * `meta/worlds`. The marker (on the interaction
 * SENSOR child) handles candidacy participation (PhysX trigger overlap,
 * ranking, LoS). This component lives on the object ROOT, holds the
 * per-object highlight config, and subscribes to the WSDK candidacy /
 * interact events to toggle the highlight and run the default activation
 * log.
 *
 * Two-entity install. The interaction sensor lives on a CHILD entity so the
 * interaction-layer collider does not interfere with the object's own
 * physical collision (an interactable door / lever / NPC still physically
 * collides with the player):
 *
 *   OBJECT ROOT (has the mesh):
 *     - the object's own physical `PhysicsBodyComponent` + collider on the
 *       world collision layer (unchanged -- this is what the player bumps
 *       into).
 *     - `HighlightPlatformComponent` (only when `enableHighlight=true`; MHS
 *       does not support runtime addComponent for it).
 *     - this component, plus any gameplay reaction components.
 *   INTERACTION SENSOR (child of the root):
 *     - `InteractionTargetComponent` (WSDK).
 *     - a `PhysicsBodyComponent` (DynamicCollider, kinematic) + collider on
 *       the world's chosen interaction layer, sized to the desired
 *       interaction reach independently of the object's physical bounds.
 *
 * The WSDK broadcasts candidacy / interact events with `payload.interactable`
 * set to the SENSOR child, but this component lives on the ROOT, so it
 * matches events by direct ancestry via `isMyInteractionTarget(
 * payload.interactable, this.entity)` rather than an exact
 * `=== this.entity` check. (A `=== this.entity` check would never match,
 * because the sensor is a different entity than the root.) The same helper
 * is how every gameplay reaction component on the root recognises events for
 * its own object.
 *
 * Highlight is applied to every entity in `highlightTargets`. When the list is
 * empty `resolveHighlightTargets` picks this component's own entity if it
 * carries `HighlightPlatformComponent`, else every descendant that carries one
 * (the Root -> {Visuals, Collider} shape). The platform
 * `HighlightPlatformComponent` outlines only the mesh on its own entity and has
 * no built-in fan-out, so a multi-mesh object lists each mesh entity in
 * `highlightTargets` and each of those entities carries its own
 * `HighlightPlatformComponent`.
 *
 * Override the WSDK `OnInteractionEvent` in your gameplay code -- the default
 * handler here just logs `activationMessage` so the install is observable
 * end-to-end.
 *
 * Naming: deliberately `SimpleInteractablePromptComponent`, NOT
 * `InteractableComponent` (reserved by a platform-shipped component in
 * `meta/worlds`). The `Simple` prefix is the verified-safe name family.
 */

import {
  CandidacyChangedPayload,
  Color,
  Component,
  component,
  type Entity,
  ExecuteOn,
  HighlightComponent,
  HighlightVisibilityMode,
  InteractionSource,
  isMyInteractionTarget,
  OnCandidacyEnterEvent,
  OnCandidacyExitEvent,
  OnEntityStartEvent,
  OnInteractionEvent,
  OnInteractionEventPayload,
  property,
  subscribe,
} from 'meta/worlds';

@component({
  description:
    'SimpleInteractablePrompt: per-object highlight config + default activation handler; subscribes to WSDK candidacy / interact events and matches by object root.',
})
export class SimpleInteractablePromptComponent extends Component {
  /**
   * Label used in logs for this object. Nothing here renders a button: the
   * on-screen interact affordance is the single `Interact` HUD button shown
   * while this object is the candidate (building-on-screen-controls, driven by
   * the InteractionControlsBridge project glue), not this label.
   */
  @property({isNetworked: false}) public label: string = 'Interact';

  /** Logged by the default OnInteractionEvent handler. */
  @property({isNetworked: false}) public activationMessage: string =
    'Player activated this object!';

  /**
   * Highlight feedback config. On candidacy enter, writes all 5 config fields
   * to each target's `HighlightComponent` and sets `enabled=true`; clears on
   * candidacy exit.
   *
   * `HighlightPlatformComponent` MUST be authored on the prefab at install
   * time. MHS does NOT support runtime `addComponent` for it. The
   * missing-component path warns once and no-ops -- this is an
   * INSTALL-INCOMPLETE alarm, not a supported runtime mode. Do NOT set
   * `enableHighlight=false` to silence the warning; fix the install.
   *
   * `outlineMode` / `fillMode` are `HighlightVisibilityMode`. At install time
   * pass as STRING names. Valid: 'None', 'Occluded', 'XRay' (no hyphen),
   * 'Overlay'.
   *
   * `HighlightComponent.enabled` is not replicated, so each client sees only
   * its own current candidate highlighted (correct UX by construction).
   */
  @property({isNetworked: false}) public enableHighlight: boolean = true;
  @property({isNetworked: false}) public outlineColor: Color = new Color(
    0.1,
    1.0,
    0.0,
    1.0,
  );
  // World units (~2cm). Keep small: >0.1 looks exaggerated, >=1 fills the
  // screen with the outline colour. NEVER set this to a large value or a
  // collision-layer number.
  @property({isNetworked: false}) public outlineWidth: number = 0.02;
  @property({isNetworked: false}) public outlineMode: HighlightVisibilityMode =
    HighlightVisibilityMode.Occluded;
  @property({isNetworked: false}) public fillColor: Color = new Color(
    0,
    0,
    0,
    0,
  );
  @property({isNetworked: false}) public fillMode: HighlightVisibilityMode =
    HighlightVisibilityMode.None;

  /**
   * Mesh entities to outline on candidacy. Leave EMPTY for the common
   * single-mesh case -- `resolveHighlightTargets` then picks this component's
   * own entity when it carries `HighlightPlatformComponent`, else every
   * descendant that carries one (the Root -> {Visuals, Collider} shape, where
   * the mesh and its highlight sit on a `Visuals` child).
   *
   * For a multi-mesh object (a door with separate handle / frame meshes, an
   * NPC with body + clothing meshes) list every mesh entity here. Each listed
   * entity MUST have its own `HighlightPlatformComponent` on the same entity
   * as its `MeshComponent` -- the platform highlight renders per mesh and has
   * no built-in fan-out. Must be `readonly` -- entity-array @property fields
   * are read-only.
   */
  @property({isNetworked: false}) public readonly highlightTargets: readonly Entity[] =
    [];

  /** Once-per-instance gate on the missing-HighlightComponent warning. */
  private highlightWarnedMissing: boolean = false;

  // The platform HighlightPlatformComponent MUST start disabled: its own
  // `enabled` default is true, so without this the object would render
  // highlighted from spawn until the first candidacy-exit. Force it off once
  // on start; candidacy enter/exit drives it thereafter.
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  private onStart(): void {
    this.applyHighlight(false);
  }

  /**
   * Resolves which entities to outline. Explicit `highlightTargets` wins (author
   * a subset for selective / multi-mesh highlighting). Otherwise: this entity if
   * it carries the HighlightComponent, else every descendant that carries its
   * own HighlightComponent -- the common case where the mesh (and its highlight)
   * lives on a child (e.g. a "Visuals" entity) rather than the object root. The
   * platform highlight has no fan-out, so each mesh entity is targeted directly.
   */
  private resolveHighlightTargets(): readonly Entity[] {
    if (this.highlightTargets.length > 0) {
      return this.highlightTargets;
    }
    if (this.entity.getComponent(HighlightComponent) != null) {
      return [this.entity];
    }
    const descendants = this.entity.getChildrenWithComponent(
      HighlightComponent,
      /*recursive*/ true,
    );
    return descendants.length > 0 ? descendants : [this.entity];
  }

  private applyHighlight(enabled: boolean): void {
    // Only the ENABLE path honours enableHighlight. Disabling must always run so
    // the spawn-time force-off (onStart) and candidacy-exit still turn the
    // platform highlight off even when enableHighlight is false (author-set or
    // zeroed by the @property boolean-default gotcha) -- otherwise the platform
    // HighlightPlatformComponent (own default enabled=true) renders forever.
    if (enabled && !this.enableHighlight) return;
    const targets = this.resolveHighlightTargets();
    for (const target of targets) {
      const highlight = target.getComponent(HighlightComponent);
      if (!highlight) {
        if (enabled && !this.highlightWarnedMissing) {
          console.warn(
            `[SimpleInteract] ${this.name}: no HighlightPlatformComponent found ` +
              `on this object or any descendant -- the outline will not render. Add ` +
              `HighlightPlatformComponent (verbatim name) to the mesh entity (the ` +
              `entity carrying the MeshComponent), or list the mesh entities in ` +
              `highlightTargets, before saving the template.`,
          );
          this.highlightWarnedMissing = true;
        }
        continue;
      }
      highlight.outlineColor = this.outlineColor;
      highlight.outlineWidth = this.outlineWidth;
      highlight.outlineMode = this.outlineMode;
      highlight.fillColor = this.fillColor;
      highlight.fillMode = this.fillMode;
      highlight.enabled = enabled;
    }
  }

  @subscribe(OnCandidacyEnterEvent, {
    execution: ExecuteOn.Everywhere,
  })
  private onEnterCandidacy(payload: CandidacyChangedPayload): void {
    if (!isMyInteractionTarget(payload.interactable, this.entity)) return;
    this.applyHighlight(true);
  }

  @subscribe(OnCandidacyExitEvent, {
    execution: ExecuteOn.Everywhere,
  })
  private onExitCandidacy(payload: CandidacyChangedPayload): void {
    if (!isMyInteractionTarget(payload.interactable, this.entity)) return;
    this.applyHighlight(false);
  }

  // OnInteractionEvent is a LocalEvent dispatched by triggerInteract ONLY in the
  // interacting client's VM (triggerInteract no-ops on the server and on
  // non-owning clients, and sendLocally adds no network traffic), so it fires
  // exactly once, on the interacting client, NEVER on the server. This
  // component lives on the interactable OBJECT, which is commonly server-owned:
  // ExecuteOn.Owner would register the subscription only on the object's owner
  // (the server), where the event never arrives, so the handler would never run
  // (fine in single-player, silently dead in multiplayer). Subscribe
  // ExecuteOn.Everywhere -- it registers on every client including the
  // interacting one, and since the event is dispatched on only that client the
  // handler still runs once (isMyInteractionTarget scopes it to this object).
  // A gameplay OVERRIDE must NOT gate on isServerContext() (always a no-op
  // here); to mutate SHARED/networked state relay to the object's owner via
  // entity.sendEventToOwner / @rpc({execution: ExecuteOn.Owner}) + a replicated
  // @property(). The candidacy handlers above are ExecuteOn.Everywhere for a
  // different reason: the highlight write is purely local (HighlightComponent.
  // enabled is not replicated), so each client toggles the outline on its OWN
  // current candidate.
  @subscribe(OnInteractionEvent, {execution: ExecuteOn.Everywhere})
  private onInteract(payload: OnInteractionEventPayload): void {
    if (!isMyInteractionTarget(payload.interactable, this.entity)) return;
    const sourceLabel =
      payload.source === InteractionSource.Touch ? 'touch' : 'button';
    console.log(
      `[SimpleInteract] activated ${this.name} (source=${sourceLabel}) -- ${this.activationMessage}`,
    );
  }
}
