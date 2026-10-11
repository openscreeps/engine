/*
 * Per-world game constants. `default-constants.ts` holds the upstream values; server mods may give a
 * world its own copy with changed values (upstream mods mutate `config.common.constants`).
 *
 * Engine code reads constants through the live binding `C`: inside a world's processing scope it is
 * that world's constants object, otherwise the immutable defaults. Scopes are synchronous and
 * restore the previous value on exit, so worlds embedded in one process never observe each other's
 * values. Each player isolate evaluates its own copy of this module and installs its world's
 * constants once, before any other runtime module evaluates (upstream `_constants`).
 */

import * as DEFAULT_CONSTANTS from './default-constants.ts';
import type { WorldState } from './simulation/state.ts';

/** The complete constants object of a world (the shape of the upstream constants module). */
export type Constants = typeof DEFAULT_CONSTANTS;

/**
 * The upstream constants as a plain (cloneable) object; top-level values are frozen, the nested
 * tables are the default module's own objects and must not be mutated.
 */
export const defaultConstants: Constants = Object.freeze({ ...DEFAULT_CONSTANTS });

/** Constants of the world whose code is running; the defaults outside every world scope. */
export let C: Constants = defaultConstants;

/**
 * Runs `run` with `constants` as the active world constants and restores the previous value
 * afterwards. `run` must finish synchronously: a scope never spans an `await`.
 */
export function runWithConstants<T>(constants: Constants, run: () => T): T {
  const previous = C;
  C = constants;
  try {
    return run();
  } finally {
    C = previous;
  }
}

/** Permanently selects the constants of a single-world module instance (a player isolate). */
export function installConstants(constants: Constants): void {
  C = constants;
}

/**
 * A detached, mutable deep copy of the default constants for one world. Server mods change its
 * values (or add new keys) before the world's simulation and player runtime are created.
 */
export function createConstants(): Constants {
  return structuredClone(defaultConstants);
}

const TERRAIN_MASK = /^TERRAIN_MASK_/;

/**
 * Rejects changes the engine deliberately does not reinterpret: string identifiers (structure,
 * resource, body part, look and order types, account resources) name persisted documents and key
 * static tables, and the terrain mask bits encode stored terrain. Changing them would silently
 * reinterpret existing world data, so they are fixed; every other value may change.
 */
export function assertSupportedConstants(constants: Constants): void {
  if (constants === defaultConstants) {
    return;
  }
  const values: Readonly<Record<string, unknown>> = constants;
  for (const [key, value] of Object.entries(DEFAULT_CONSTANTS)) {
    if ((typeof value === 'string' || TERRAIN_MASK.test(key)) && values[key] !== value) {
      throw new TypeError(
        `Constant ${key} is a persisted identifier and cannot be changed (default ${JSON.stringify(value)}, got ${JSON.stringify(values[key])})`,
      );
    }
  }
}

/** Constants bound to world states (`Simulation` binds its world; hosts bind worlds they create). */
const constantsByWorld = new WeakMap<Readonly<WorldState>, Constants>();

/**
 * Associates a world state object with its constants, so host-side operations on that world (game
 * maintenance, backend actions) read the same values as its simulation. Validates the constants.
 */
export function bindWorldConstants(world: Readonly<WorldState>, constants: Constants): void {
  assertSupportedConstants(constants);
  constantsByWorld.set(world, constants);
}

/** The constants bound to `world`, or the defaults for a world that was never bound. */
export function worldConstants(world: Readonly<WorldState>): Constants {
  return constantsByWorld.get(world) ?? defaultConstants;
}
