/**
 * Shared engine utilities (port of @screeps/engine `utils.js`, @screeps/common helpers, strongholds,
 * intent sanitization and the native path finder). Everything here is pure and bundle-safe: no Node
 * built-ins, no process-global state; world-specific data is always passed explicitly.
 */

export * from './calc.ts';
export * from './diff.ts';
export * from './geometry.ts';
export * from './js.ts';
export * from './notifications.ts';
export * from './path-utils.ts';
export * from './pathfinder.ts';
export * from './rooms.ts';
export * from './structures.ts';
export * from './system.ts';
export * from './terrain.ts';
export * as strongholds from './strongholds.ts';
export * as lodash from './lodash.ts';
export { getProp, ownValue } from './tables.ts';
