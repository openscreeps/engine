/*
 * Ported from @screeps/engine src/utils.js (`getDiff`, identical in @screeps/common index.js).
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

import { collectionValues, isEqual, isObject, size } from './lodash.ts';
import { readProp } from './tables.ts';

/** Any persisted document keyed by `_id`. */
export interface IdentifiedDocument {
  readonly _id: string;
}

/**
 * Per-id change set: `null` for removed documents, the full document for added ones, otherwise a
 * partial object of changed top-level keys (`null` for removed keys, nested one-level partials for objects).
 */
export type DocumentDiff<T extends IdentifiedDocument = IdentifiedDocument> = Record<
  string,
  T | Record<string, unknown> | null
>;

/** Computes the incremental diff between two snapshots of a document collection. */
export function getDiff<T extends IdentifiedDocument>(
  oldData: Readonly<Record<string, T>> | readonly T[],
  newData: Readonly<Record<string, T>> | readonly T[],
): DocumentDiff<T> {
  const oldList = collectionValues(oldData);
  const newList = collectionValues(newData);
  const oldIndex: Record<string, T> = {};
  for (const obj of oldList) oldIndex[obj._id] = obj;
  const newIndex: Record<string, T> = {};
  for (const obj of newList) newIndex[obj._id] = obj;

  const result: DocumentDiff<T> = {};

  for (const obj of oldList) {
    const newObj = Object.hasOwn(newIndex, obj._id) ? newIndex[obj._id] : undefined;
    if (!newObj) {
      result[obj._id] = null;
      continue;
    }
    const objDiff: Record<string, unknown> = {};
    result[obj._id] = objDiff;
    for (const key of Object.keys(obj)) {
      if (key === '_id') {
        continue;
      }
      const oldValue = readProp(obj, key);
      const newValue = readProp(newObj, key);
      if (newValue === undefined) {
        objDiff[key] = null;
      } else if (typeof oldValue !== typeof newValue || (oldValue && !newValue)) {
        objDiff[key] = newValue;
      } else if (isObject(oldValue) && isObject(newValue)) {
        // Same `typeof` and both truthy here, so `newValue` is an object as well.
        const subDiff: Record<string, unknown> = {};
        objDiff[key] = subDiff;
        for (const subkey of Object.keys(oldValue)) {
          if (!isEqual(readProp(oldValue, subkey), readProp(newValue, subkey))) {
            subDiff[subkey] = readProp(newValue, subkey);
          }
        }
        for (const subkey of Object.keys(newValue)) {
          if (readProp(oldValue, subkey) === undefined) {
            subDiff[subkey] = readProp(newValue, subkey);
          }
        }
        if (!size(subDiff)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- mirrors upstream key removal
          delete objDiff[key];
        }
      } else if (!isEqual(oldValue, newValue)) {
        objDiff[key] = newValue;
      }
    }
    for (const key of Object.keys(newObj)) {
      if (readProp(obj, key) === undefined) {
        objDiff[key] = readProp(newObj, key);
      }
    }
    if (!size(objDiff)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- mirrors upstream key removal
      delete result[obj._id];
    }
  }

  for (const obj of newList) {
    if (!Object.hasOwn(oldIndex, obj._id)) {
      result[obj._id] = obj;
    }
  }

  return result;
}
