/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import {
  Component,
  component,
  ExecuteOn,
  property,
  rpc,
  subscribe,
  subscribePropertyChange,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
} from 'meta/worlds';
import type {Entity, Maybe} from 'meta/worlds';
import {GASAbility} from '../abilities/GASAbility';
import type {AbilityConstructor} from '../abilities/GASAbility';
import type {GASAbilityData} from '../abilities/GASAbilityData';
import {GASAbilityManager} from '../abilities/GASAbilityManager';
import {GASAttribute} from '../attributes/GASAttribute';
import type {GASAttributeData} from '../attributes/GASAttributeData';
import {GASAttributeSet} from '../attributes/GASAttributeSet';
import {AttributeSnapshot} from '../attributes/AttributeSnapshot';
import {GameplayCueContext} from '../cues/GameplayCueContext';
import {GameplayCueManager} from '../cues/GameplayCueManager';
import {CuePayload} from '../cues/CuePayload';
import {Effect} from '../effects/Effect';
import type {GASEffectData} from '../effects/GASEffectData';
import {GASEffectManager} from '../effects/GASEffectManager';
import {GASTagContainer} from '../tags/GASTagContainer';
import {TagSnapshot} from '../tags/TagSnapshot';
import type {EffectContext} from './EffectContext';
import type {EffectActor} from './EffectContext';
import type {ModifierOperator} from './Enums';

/**
 * The single public-facing entry point (Facade). Game code talks only to this component.
 *
 * Internally, GASComponent owns five sub-managers (AttributeSet / TagContainer /
 * EffectManager / AbilityManager / CueManager), which are created automatically at
 * startup. Game-side extension is done by subclassing GASComponent and overriding
 * the Pre/Post hooks for damage routing.
 */

type TagListener = (tag: string) => void;
type AttributeChangedListener = (
  attributeName: string,
  oldValue: number,
  newValue: number,
) => void;
type AttributeBaseChangedListener = (
  attributeName: string,
  oldBase: number,
  newBase: number,
) => void;
type EffectAppliedListener = (data: GASEffectData) => void;
type EffectRemovedListener = (data: GASEffectData) => void;
type EffectStackedListener = (data: GASEffectData, newStackCount: number) => void;
type EffectUnstackedListener = (data: GASEffectData, newStackCount: number) => void;
type AbilityIdListener = (id: string) => void;

@component({
  description: 'Gameplay Ability System facade — single entry point for game code.',
})
export class GASComponent extends Component {
  @property()
  public initialTags: string = '';

  @property()
  public useHierarchicalMatcher: boolean = true;

  // Networked mirror of attribute runtime values. Written only on the authority
  // (owner) in onWorldUpdate; on proxies it is replicated in and applied to the
  // local attributeSet via onReplicatedAttributesChanged. Attribute definitions
  // are NOT replicated — they come from code (getInitialAttributes) identically
  // on every client, so only base/current values ride the wire.
  @property()
  public replicatedAttributes: readonly AttributeSnapshot[] = [];

  // Set whenever a local attribute value changes; the authority republishes the
  // snapshot array on the next tick. Harmless on proxies (they never publish).
  private attributesDirty: boolean = false;

  // Networked mirror of the owned tag set. Written only on the authority in
  // onWorldUpdate; on proxies it is replicated in and reconciled into the local
  // tagContainer via onReplicatedTagsChanged.
  @property()
  public replicatedTags: readonly TagSnapshot[] = [];

  // Set whenever a local tag stack changes; the authority republishes the tag
  // snapshot array on the next tick. Harmless on proxies (they never publish).
  private tagsDirty: boolean = false;

  public tagContainer: GASTagContainer = new GASTagContainer();
  public attributeSet: GASAttributeSet = new GASAttributeSet({owner: this});
  // Sub-managers below receive `this` as their structural owner.
  public effectManager: GASEffectManager = new GASEffectManager({
    owner: this,
    attributeSet: this.attributeSet,
    tagContainer: this.tagContainer,
  });
  public abilityManager: GASAbilityManager = new GASAbilityManager({owner: this});
  public cueManager: GameplayCueManager = new GameplayCueManager();

  private readonly tagAddedListeners: Set<TagListener> = new Set<TagListener>();
  private readonly tagRemovedListeners: Set<TagListener> = new Set<TagListener>();
  private readonly attributeChangedListeners: Set<AttributeChangedListener> =
    new Set<AttributeChangedListener>();
  private readonly attributeBaseChangedListeners: Set<AttributeBaseChangedListener> =
    new Set<AttributeBaseChangedListener>();
  private readonly effectAppliedListeners: Set<EffectAppliedListener> =
    new Set<EffectAppliedListener>();
  private readonly effectRemovedListeners: Set<EffectRemovedListener> =
    new Set<EffectRemovedListener>();
  private readonly effectStackedListeners: Set<EffectStackedListener> =
    new Set<EffectStackedListener>();
  private readonly effectUnstackedListeners: Set<EffectUnstackedListener> =
    new Set<EffectUnstackedListener>();
  private readonly abilityGrantedListeners: Set<AbilityIdListener> =
    new Set<AbilityIdListener>();
  private readonly abilityActivatedListeners: Set<AbilityIdListener> =
    new Set<AbilityIdListener>();
  private readonly abilityEndedListeners: Set<AbilityIdListener> =
    new Set<AbilityIdListener>();

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onEntityStart(): void {
    this.tagContainer = new GASTagContainer({
      initialTags: this.parseInitialTags(),
      useHierarchicalMatcher: this.useHierarchicalMatcher,
    });

    this.attributeSet = new GASAttributeSet({
      owner: this,
      attributes: this.getInitialAttributes(),
    });

    this.effectManager = new GASEffectManager({
      owner: this,
      attributeSet: this.attributeSet,
      tagContainer: this.tagContainer,
    });

    this.abilityManager = new GASAbilityManager({
      owner: this,
    });

    this.tagContainer.onTagAdded((tag: string): void => {
      this.emitTagAdded(tag);
    });
    this.tagContainer.onTagRemoved((tag: string): void => {
      this.emitTagRemoved(tag);
    });
    this.tagContainer.onChanged((): void => {
      this.tagsDirty = true;
    });

    this.attributeSet.onAttributeChanged(
      (name: string, oldValue: number, newValue: number): void => {
        this.attributesDirty = true;
        this.emitAttributeChanged(name, oldValue, newValue);
      },
    );
    this.attributeSet.onAttributeBaseChanged(
      (name: string, oldBase: number, newBase: number): void => {
        this.attributesDirty = true;
        this.emitAttributeBaseChanged(name, oldBase, newBase);
      },
    );

    this.effectManager.onEffectApplied((data: GASEffectData): void => {
      this.emitEffectApplied(data);
    });
    this.effectManager.onEffectRemoved((data: GASEffectData): void => {
      this.emitEffectRemoved(data);
    });
    this.effectManager.onEffectStacked((data: GASEffectData, n: number): void => {
      this.emitEffectStacked(data, n);
    });
    this.effectManager.onEffectUnstacked((data: GASEffectData, n: number): void => {
      this.emitEffectUnstacked(data, n);
    });

    this.abilityManager.onAbilityGranted((id: string): void => {
      this.emitAbilityGranted(id);
    });
    this.abilityManager.onAbilityActivated((id: string): void => {
      this.emitAbilityActivated(id);
    });
    this.abilityManager.onAbilityEnded((id: string): void => {
      this.emitAbilityEnded(id);
    });

    // Publish the initial attribute baseline on the authority's first tick.
    this.attributesDirty = true;
    // Publish the initial tag baseline (including parsed initialTags) too.
    this.tagsDirty = true;
  }

  @subscribe(OnWorldUpdateEvent)
  onWorldUpdate(payload: OnWorldUpdateEventPayload): void {
    // Authority-only simulation. On proxies the GAS state is driven purely by
    // replicated properties, so ticking here would fight replication (and any
    // @property write below would throw). Local-only entities are always owned,
    // so single-player behavior is unchanged.
    if (!this.entity.isOwned()) {
      return;
    }
    this.effectManager.tick(payload.deltaTime);
    this.abilityManager.tick(payload.deltaTime);
    this.publishAttributesIfDirty();
    this.publishTagsIfDirty();
  }

  // Proxy side: replicated attribute values arrived — mirror them into the local
  // attributeSet so getAttributeValue / UI listeners see authoritative values.
  @subscribePropertyChange('replicatedAttributes')
  onReplicatedAttributesChanged(): void {
    if (this.entity.isOwned()) {
      return; // authority is the source of truth; nothing to apply back
    }
    for (const snapshot of this.replicatedAttributes) {
      this.attributeSet.applyReplicatedSnapshot(
        snapshot.name,
        snapshot.baseValue,
        snapshot.currentValue,
      );
    }
  }

  private publishAttributesIfDirty(): void {
    if (!this.attributesDirty) {
      return;
    }
    this.attributesDirty = false;
    this.replicatedAttributes = this.buildAttributeSnapshots();
  }

  private buildAttributeSnapshots(): AttributeSnapshot[] {
    const snapshots: AttributeSnapshot[] = [];
    for (const def of this.attributeSet.attributes) {
      const name = def.attributeName;
      snapshots.push(
        new AttributeSnapshot(
          name,
          this.attributeSet.getBase(name),
          this.attributeSet.getValue(name),
        ),
      );
    }
    return snapshots;
  }

  // Proxy side: replicated tag set arrived — reconcile it into the local
  // tagContainer so hasTag / UI listeners see authoritative state.
  @subscribePropertyChange('replicatedTags')
  onReplicatedTagsChanged(): void {
    if (this.entity.isOwned()) {
      return; // authority is the source of truth; nothing to apply back
    }
    const desired = new Map<string, number>();
    for (const snapshot of this.replicatedTags) {
      desired.set(snapshot.name, snapshot.stackCount);
    }
    this.tagContainer.applyReplicatedTags(desired);
  }

  private publishTagsIfDirty(): void {
    if (!this.tagsDirty) {
      return;
    }
    this.tagsDirty = false;
    this.replicatedTags = this.buildTagSnapshots();
  }

  private buildTagSnapshots(): TagSnapshot[] {
    const snapshots: TagSnapshot[] = [];
    for (const tag of this.tagContainer.getAllTags()) {
      snapshots.push(new TagSnapshot(tag, this.tagContainer.getStackCount(tag)));
    }
    return snapshots;
  }

  // Override in a subclass to seed initial attributes.
  protected getInitialAttributes(): ReadonlyArray<GASAttributeData> {
    return [];
  }

  private parseInitialTags(): ReadonlyArray<string> {
    if (!this.initialTags) {
      return [];
    }
    return this.initialTags
      .split(',')
      .map((tag: string): string => tag.trim())
      .filter((tag: string): boolean => tag.length > 0);
  }

  // Subclass extension hooks. Override to clamp values or route Meta Attributes.

  protected preAttributeChange(_attributeName: string, newValue: number): number {
    return newValue;
  }

  protected preAttributeBaseChange(_attributeName: string, newValue: number): number {
    return newValue;
  }

  protected postGameplayEffectExecute(
    _ctx: EffectContext,
    _attribute: GASAttribute,
    _magnitudeDelta: number,
  ): void {
    // Default no-op.
  }

  // Bridge methods called by the AttributeSet / EffectManager.

  public invokePreAttributeChange(attributeName: string, newValue: number): number {
    return this.preAttributeChange(attributeName, newValue);
  }

  public invokePreAttributeBaseChange(attributeName: string, newValue: number): number {
    return this.preAttributeBaseChange(attributeName, newValue);
  }

  public invokePostGameplayEffectExecute(
    ctx: EffectContext,
    attribute: GASAttribute,
    magnitudeDelta: number,
  ): void {
    this.postGameplayEffectExecute(ctx, attribute, magnitudeDelta);
  }

  // Attributes
  public getAttributeValue(name: string): number {
    return this.attributeSet.getValue(name);
  }

  public getAttributeBase(name: string): number {
    return this.attributeSet.getBase(name);
  }

  public setAttributeBase(name: string, value: number): void {
    if (!this.entity.isOwned()) {
      return; // only the authority mutates attributes; proxies get replicated values
    }
    this.attributeSet.setBase(name, value);
  }

  public applyInstantModifier(name: string, op: ModifierOperator, magnitude: number): void {
    if (!this.entity.isOwned()) {
      return; // only the authority mutates attributes; proxies get replicated values
    }
    this.attributeSet.applyInstantModifier(name, op, magnitude);
  }

  public hasAttribute(name: string): boolean {
    return this.attributeSet.hasAttribute(name);
  }

  public tryAddAttribute(data: GASAttributeData): boolean {
    return this.attributeSet.tryAddAttribute(data);
  }

  // Shared effect catalog for cross-network application. Effects are referenced
  // over the wire by id (see RpcApplyEffectById); each machine resolves the id
  // to its own local GASEffectData (whose custom calculators / attribute refs
  // are non-serializable and therefore never cross the wire). Register once at
  // startup, e.g. in world/init code: `GASComponent.registerEffect(burnData)`.
  private static readonly effectRegistry: Map<string, GASEffectData> =
    new Map<string, GASEffectData>();

  // Ids that two distinct definitions have both claimed. Such an id is dropped
  // from the registry and never served again — see registerEffect.
  private static readonly conflictedEffectIds: Set<string> = new Set<string>();

  public static registerEffect(data: GASEffectData): void {
    if (data.effectId.length === 0) {
      console.warn('[GAS] registerEffect: effect has no effectId; not registered.');
      return;
    }
    if (GASComponent.conflictedEffectIds.has(data.effectId)) {
      console.error(
        `[GAS] registerEffect: effectId '${data.effectId}' is in conflict; not registered.`,
      );
      return;
    }
    const existing = GASComponent.effectRegistry.get(data.effectId);
    if (existing != null && existing !== data) {
      // Two distinct definitions claim one id. Serving either would make the
      // winner depend on registration order, which is not guaranteed to match
      // across machines, so the id would mean different things on different
      // clients. Drop it instead: an id resolves to exactly one definition or
      // to nothing — never to two.
      console.error(
        `[GAS] registerEffect: effectId '${data.effectId}' is claimed by two different effects. ` +
          'Neither is registered. Give each distinct effect its own id.',
      );
      GASComponent.effectRegistry.delete(data.effectId);
      GASComponent.conflictedEffectIds.add(data.effectId);
      return;
    }
    GASComponent.effectRegistry.set(data.effectId, data);
  }

  public static getRegisteredEffect(effectId: string): GASEffectData | undefined {
    return GASComponent.effectRegistry.get(effectId);
  }

  // Single resolution point for effectId -> definition, used by BOTH the local
  // and the cross-network application paths. Resolving in only one of them is
  // what would let an id mean one thing locally and another remotely: the local
  // path holds the caller's object reference, the remote path can only carry the
  // id. Returns null when the effect must not be applied at all.
  private static resolveForApply(data: GASEffectData): GASEffectData | null {
    if (data.effectId.length === 0) {
      return data;
    }
    if (GASComponent.conflictedEffectIds.has(data.effectId)) {
      console.error(
        `[GAS] effectId '${data.effectId}' is claimed by two different effects; refusing to apply.`,
      );
      return null;
    }
    return GASComponent.getRegisteredEffect(data.effectId) ?? data;
  }

  // Effects
  //
  // Effect application always executes on the TARGET's authority. When the
  // target is owned locally (or the entity is not networked / single-player) we
  // apply directly and return the Effect handle. When the target is a remote
  // proxy we route to its owner via an Owner RPC, carrying the effect id (the
  // owner resolves the real GASEffectData from the shared registry) — this is
  // fire-and-forget, so it returns null (no handle crosses the wire).
  public applyEffectToSelf(
    data: GASEffectData,
    source: EffectActor | null = null,
    level: number = 1,
  ): Effect | null {
    return this.applyEffectRouted(this, data, source, level);
  }

  public applyEffectToTarget(
    target: GASComponent,
    data: GASEffectData,
    level: number = 1,
  ): Effect | null {
    // The caster (this) is the source of a target-applied effect.
    return this.applyEffectRouted(target, data, this, level);
  }

  private applyEffectRouted(
    target: GASComponent,
    data: GASEffectData,
    source: EffectActor | null,
    level: number,
  ): Effect | null {
    const resolved = GASComponent.resolveForApply(data);
    if (resolved == null) {
      return null;
    }
    // Local authority (owned target) or single-player: apply directly.
    if (!target.entity.networked || target.entity.isOwned()) {
      return target.effectManager.applyEffectToSelf(resolved, source, level);
    }
    // Target is a remote proxy: route to its authority by id.
    if (resolved.effectId.length === 0) {
      console.warn(
        '[GAS] Cannot apply an effect to a remote target without an effectId. ' +
          'Register it via GASComponent.registerEffect and set effectId on the data.',
      );
      return null;
    }
    target.RpcApplyEffectById(resolved.effectId, level, this.entityOf(source));
    return null;
  }

  // Runs on the target's authority. Resolves the effect definition from the
  // shared registry (id-only crosses the wire; the data itself — including
  // non-serializable custom calculators — lives in local code on every machine)
  // and applies it with the reconstructed source.
  @rpc({execution: ExecuteOn.Owner})
  RpcApplyEffectById(effectId: string, level: number, sourceEntity: Maybe<Entity>): void {
    const data = GASComponent.getRegisteredEffect(effectId);
    if (!data) {
      console.warn(`[GAS] RpcApplyEffectById: no effect registered for id '${effectId}'.`);
      return;
    }
    const source = sourceEntity?.getComponent(GASComponent) ?? null;
    this.effectManager.applyEffectToSelf(data, source, level);
  }

  public removeEffect(effect: Effect): void {
    if (!this.entity.isOwned()) {
      return; // effects live only on the authority; proxies hold no Effect objects
    }
    this.effectManager.removeEffect(effect);
  }

  public removeEffectStack(effect: Effect, count: number = 1): void {
    if (!this.entity.isOwned()) {
      return; // effects live only on the authority; proxies hold no Effect objects
    }
    this.effectManager.removeEffectStack(effect, count);
  }

  public getEffectStackCount(data: GASEffectData): number {
    return this.effectManager.getStackCount(data);
  }

  public getActiveEffects(): ReadonlyArray<Effect> {
    return this.effectManager.getActiveEffects();
  }

  // Abilities
  public grantAbility(
    data: GASAbilityData,
    abilityClass: AbilityConstructor = GASAbility,
  ): void {
    this.abilityManager.grantAbility(data, abilityClass);
  }

  public removeAbility(id: string): void {
    this.abilityManager.removeAbility(id);
  }

  public tryActivateAbility(id: string, userData: unknown = null): boolean {
    return this.abilityManager.tryActivateAbility(id, userData);
  }

  public canActivateAbility(id: string): boolean {
    return this.abilityManager.canActivateAbility(id);
  }

  public endAbility(id: string): void {
    this.abilityManager.endAbility(id);
  }

  public isAbilityGranted(id: string): boolean {
    return this.abilityManager.isAbilityGranted(id);
  }

  public isAbilityOnCooldown(id: string): boolean {
    return this.abilityManager.isOnCooldown(id);
  }

  public getAbilityCooldownRemaining(id: string): number {
    return this.abilityManager.getCooldownRemaining(id);
  }

  public isAbilityActive(id: string): boolean {
    return this.abilityManager.isAbilityActive(id);
  }

  public getAbility(id: string): GASAbility | null {
    return this.abilityManager.getAbility(id);
  }

  // Cues
  public executeCue(tag: string, ctx: GameplayCueContext): void {
    this.broadcastCue(tag, ctx);
  }

  // Single choke point for cue emission (facade + effect / ability managers).
  // Cues are cosmetic and must play on every client. On a networked entity the
  // authority broadcasts via an Everywhere RPC so all machines (including the
  // authority) play the cue locally; on a local-only entity we play immediately
  // and synchronously, preserving single-player behavior. Cue triggers only
  // originate on the authority (effect / ability sim is authority-gated), so the
  // non-owner branch is just a safety guard.
  public broadcastCue(tag: string, ctx: GameplayCueContext): void {
    if (!this.entity.networked) {
      this.cueManager.executeCue(tag, ctx);
      return;
    }
    if (!this.entity.isOwned()) {
      return;
    }
    this.RpcAllExecuteCue(
      new CuePayload(
        tag,
        ctx.magnitude,
        ctx.location,
        ctx.normal,
        this.entityOf(ctx.source),
        this.entityOf(ctx.target),
      ),
    );
  }

  @rpc({execution: ExecuteOn.Everywhere})
  RpcAllExecuteCue(payload: CuePayload): void {
    this.cueManager.executeCue(
      payload.tag,
      new GameplayCueContext({
        target: payload.targetEntity?.getComponent(GASComponent) ?? null,
        source: payload.sourceEntity?.getComponent(GASComponent) ?? null,
        location: payload.location,
        normal: payload.normal,
        magnitude: payload.magnitude,
      }),
    );
  }

  // Extract the backing entity from a cue actor for wire transport. Runtime cue
  // actors are always GASComponents; the null fallback covers stubs / detached
  // actors (e.g. tests).
  private entityOf(actor: EffectActor | null): Maybe<Entity> {
    return actor instanceof GASComponent ? actor.entity : null;
  }

  // Tags
  public hasTag(tag: string | null): boolean {
    return this.tagContainer.hasTag(tag);
  }

  public hasAllTags(tags: Iterable<string>): boolean {
    return this.tagContainer.hasAllTags(tags);
  }

  public hasAnyTag(tags: Iterable<string>): boolean {
    return this.tagContainer.hasAnyTag(tags);
  }

  public hasNoneOfTags(tags: Iterable<string>): boolean {
    return this.tagContainer.hasNoneOfTags(tags);
  }

  public getTagStackCount(tag: string): number {
    return this.tagContainer.getStackCount(tag);
  }

  public addLooseTag(tag: string, stacks: number = 1): void {
    if (!this.entity.isOwned()) {
      return; // only the authority mutates tags; proxies get replicated tags
    }
    this.tagContainer.addTag(tag, stacks);
  }

  public removeLooseTag(tag: string, stacks: number = 1): void {
    if (!this.entity.isOwned()) {
      return; // only the authority mutates tags; proxies get replicated tags
    }
    this.tagContainer.removeTag(tag, stacks);
  }

  // Listener forwarding — facade level.

  public onTagAdded(listener: TagListener): () => void {
    this.tagAddedListeners.add(listener);
    return (): void => {
      this.tagAddedListeners.delete(listener);
    };
  }

  public onTagRemoved(listener: TagListener): () => void {
    this.tagRemovedListeners.add(listener);
    return (): void => {
      this.tagRemovedListeners.delete(listener);
    };
  }

  public onAttributeChanged(listener: AttributeChangedListener): () => void {
    this.attributeChangedListeners.add(listener);
    return (): void => {
      this.attributeChangedListeners.delete(listener);
    };
  }

  public onAttributeBaseChanged(listener: AttributeBaseChangedListener): () => void {
    this.attributeBaseChangedListeners.add(listener);
    return (): void => {
      this.attributeBaseChangedListeners.delete(listener);
    };
  }

  public onEffectApplied(listener: EffectAppliedListener): () => void {
    this.effectAppliedListeners.add(listener);
    return (): void => {
      this.effectAppliedListeners.delete(listener);
    };
  }

  public onEffectRemoved(listener: EffectRemovedListener): () => void {
    this.effectRemovedListeners.add(listener);
    return (): void => {
      this.effectRemovedListeners.delete(listener);
    };
  }

  public onEffectStacked(listener: EffectStackedListener): () => void {
    this.effectStackedListeners.add(listener);
    return (): void => {
      this.effectStackedListeners.delete(listener);
    };
  }

  public onEffectUnstacked(listener: EffectUnstackedListener): () => void {
    this.effectUnstackedListeners.add(listener);
    return (): void => {
      this.effectUnstackedListeners.delete(listener);
    };
  }

  public onAbilityGranted(listener: AbilityIdListener): () => void {
    this.abilityGrantedListeners.add(listener);
    return (): void => {
      this.abilityGrantedListeners.delete(listener);
    };
  }

  public onAbilityActivated(listener: AbilityIdListener): () => void {
    this.abilityActivatedListeners.add(listener);
    return (): void => {
      this.abilityActivatedListeners.delete(listener);
    };
  }

  public onAbilityEnded(listener: AbilityIdListener): () => void {
    this.abilityEndedListeners.add(listener);
    return (): void => {
      this.abilityEndedListeners.delete(listener);
    };
  }

  private emitTagAdded(tag: string): void {
    for (const listener of this.tagAddedListeners) {
      listener(tag);
    }
  }

  private emitTagRemoved(tag: string): void {
    for (const listener of this.tagRemovedListeners) {
      listener(tag);
    }
  }

  private emitAttributeChanged(name: string, oldValue: number, newValue: number): void {
    for (const listener of this.attributeChangedListeners) {
      listener(name, oldValue, newValue);
    }
  }

  private emitAttributeBaseChanged(name: string, oldBase: number, newBase: number): void {
    for (const listener of this.attributeBaseChangedListeners) {
      listener(name, oldBase, newBase);
    }
  }

  private emitEffectApplied(data: GASEffectData): void {
    for (const listener of this.effectAppliedListeners) {
      listener(data);
    }
  }

  private emitEffectRemoved(data: GASEffectData): void {
    for (const listener of this.effectRemovedListeners) {
      listener(data);
    }
  }

  private emitEffectStacked(data: GASEffectData, newStackCount: number): void {
    for (const listener of this.effectStackedListeners) {
      listener(data, newStackCount);
    }
  }

  private emitEffectUnstacked(data: GASEffectData, newStackCount: number): void {
    for (const listener of this.effectUnstackedListeners) {
      listener(data, newStackCount);
    }
  }

  private emitAbilityGranted(id: string): void {
    for (const listener of this.abilityGrantedListeners) {
      listener(id);
    }
  }

  private emitAbilityActivated(id: string): void {
    for (const listener of this.abilityActivatedListeners) {
      listener(id);
    }
  }

  private emitAbilityEnded(id: string): void {
    for (const listener of this.abilityEndedListeners) {
      listener(id);
    }
  }
}
