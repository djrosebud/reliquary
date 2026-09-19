/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Animation Scripts v3

/**
 * Utility functions for entity and component resolution.
 */

import {Component, type Entity, type Maybe, type AbstractClass} from 'meta/worlds';

/**
 * Resolves a component from an entity or its children.
 *
 * This utility provides a generic way to look up components that may be:
 * 1. Assigned to a specific entity via an @property (e.g., animatorEntity)
 * 2. Located on the root entity itself
 * 3. Located on a child entity in the hierarchy (searched recursively)
 *
 * This pattern is useful for components that can be wired in the Editor but
 * should also support automatic discovery via hierarchy lookup when not wired.
 *
 * @param rootEntity - The root entity to search from (typically `this.entity`)
 * @param targetEntity - Optional specific entity to check first. If null/undefined,
 *                       falls back to rootEntity. If the component is not found on
 *                       this entity, children will be searched.
 * @param componentClass - The component class to search for
 * @returns The component if found, null otherwise
 *
 * @example
 * // Resolve AnimatorComponent from assigned entity or children
 * const animator = resolveComponent(this.entity, this.animatorEntity, AnimatorComponent);
 *
 * @example
 * // Resolve an optional sibling component from the hierarchy
 * const replication = resolveComponent(this.entity, null, WorldsCharacterStateReplication);
 */
export function resolveComponent<T extends Component>(
  rootEntity: Entity,
  targetEntity: Maybe<Entity>,
  componentClass: AbstractClass<T>,
): Maybe<T> {
  // Try the target entity first (or root if target is null)
  const entityToCheck = targetEntity ?? rootEntity;
  const component = entityToCheck.getComponent(componentClass);
  if (component) {
    return component;
  }

  // Fallback: search children recursively
  const childrenWithComponent = rootEntity.getChildrenWithComponent(componentClass, true);
  if (childrenWithComponent.length > 0) {
    return childrenWithComponent[0].getComponent(componentClass);
  }

  return null;
}

/**
 * Resolves a component from an entity or its children, throwing if not found.
 *
 * Similar to {@link resolveComponent} but throws an error if the component
 * cannot be found. Use this when the component is required for the script to function.
 *
 * @param rootEntity - The root entity to search from (typically `this.entity`)
 * @param targetEntity - Optional specific entity to check first. If null/undefined,
 *                       falls back to rootEntity.
 * @param componentClass - The component class to search for
 * @returns The component (never null)
 * @throws Error if the component is not found
 *
 * @example
 * // Require AnimatorComponent from assigned entity or children
 * const animator = resolveComponentOrThrow(this.entity, this.animatorEntity, AnimatorComponent);
 */
export function resolveComponentOrThrow<T extends Component>(
  rootEntity: Entity,
  targetEntity: Maybe<Entity>,
  componentClass: AbstractClass<T>,
): T {
  const component = resolveComponent(rootEntity, targetEntity, componentClass);
  if (!component) {
    const componentName = componentClass.name || 'Component';
    throw new Error(
      `EntityUtils: ${componentName} not found on entity or its children. ` +
        `Ensure the component is assigned via property or exists in the hierarchy.`,
    );
  }
  return component;
}
