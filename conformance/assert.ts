import assert from 'node:assert/strict';

/** Checks fixture prerequisites without treating valid zero/false values as absent. */
export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, 'Missing conformance fixture prerequisite');
  return value;
}
