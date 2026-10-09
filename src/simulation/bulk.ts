/*
 * Bulk writer replicating @screeps/driver `lib/bulk.js` and the document update semantics of
 * @screeps/storage `lib/db.js`, applied to an in-memory collection of the world state.
 *
 * Portions derived from screeps/driver and screeps/storage, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import {
  cloneDeep,
  isObject,
  isObjectLike,
  jsonClone,
  merge,
  type PlainRecord,
} from './support.ts';

/** Deep partial patch accepted by `Bulk.update`. Nested objects are merged like lodash 3 `_.merge`. */
export type BulkPatch<T> = {
  [K in keyof T]?: BulkPatchValue<NonNullable<T[K]>> | null | undefined;
};

type BulkPatchValue<V> = V extends readonly unknown[] ? V : V extends object ? BulkPatch<V> | V : V;

/** Numeric keys of a document type usable with `Bulk.inc`. */
export type NumericKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends number ? K : never;
}[keyof T] &
  string;

/** Keys whose value is a numeric map (e.g. `UserDoc.resources`), addressable as `key.subkey`. */
type NumericRecordKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends readonly unknown[]
    ? never
    : NonNullable<T[K]> extends Readonly<Record<string, number>>
      ? K
      : never;
}[keyof T] &
  string;

/** Key accepted by `Bulk.inc`: a numeric field or a Mongo-style dotted path into a numeric map. */
export type IncKey<T> = NumericKeys<T> | `${NumericRecordKeys<T>}.${string}`;

/** Array keys of a document type usable with `Bulk.addToSet` / `Bulk.pull`. */
export type ArrayKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends readonly unknown[] ? K : never;
}[keyof T] &
  string;

export interface BulkDoc {
  _id: string;
}

type Update =
  | { $set: PlainRecord }
  | { $inc: { key: string; amount: number } }
  | { $addToSet: { key: string; value: unknown } }
  | { $pull: { key: string; value: unknown } };

type Op =
  | { op: 'update'; id: string; update: Update }
  | { op: 'remove'; id: string }
  | { op: 'insert'; data: PlainRecord };

function removeHidden(obj: unknown): void {
  if (!isObjectLike(obj)) {
    return;
  }
  const record = obj as PlainRecord;
  for (const key of Object.keys(record)) {
    if (key.startsWith('_')) {
      Reflect.deleteProperty(record, key);
      continue;
    }
    const value = record[key];
    if (Array.isArray(value)) {
      value.forEach(removeHidden);
      continue;
    }
    if (isObject(value)) {
      removeHidden(value);
    }
  }
}

export type IdGenerator = () => string;

/**
 * Accumulates writes for one collection and applies them on `execute()`.
 *
 * In-memory objects passed by reference are patched immediately (like upstream), while the
 * persisted documents only change on `execute()`, after a serialization round trip.
 */
export class Bulk<T extends BulkDoc> {
  private readonly ops: Op[] = [];
  private opsCnt = 0;
  private readonly updates = new Map<string, PlainRecord>();
  private readonly inserts = new Map<string, PlainRecord>();
  private insertCnt = 0;

  private readonly collection: Record<string, T>;
  private readonly genId: IdGenerator;

  constructor(collection: Record<string, T>, genId: IdGenerator) {
    this.collection = collection;
    this.genId = genId;
  }

  update(target: T | string | null | undefined, patch: BulkPatch<T>): void {
    if (!target) {
      return;
    }
    this.opsCnt++;
    const data = cloneDeep(patch) as PlainRecord;
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (isObject(value)) {
        if (typeof target === 'string') {
          throw new Error(
            `can not update an object diff property '${key}' without object reference`,
          );
        }
        const live = (target as unknown as PlainRecord)[key];
        const originalValue: unknown = live || {};
        if (isObject(originalValue)) {
          merge(originalValue, value);
        }
        data[key] = originalValue;
      }
    }
    let id: string;
    if (typeof target === 'string') {
      id = target;
    } else {
      merge(target, data);
      id = target._id;
    }

    removeHidden(data);

    const pendingInsert = this.inserts.get(id);
    if (pendingInsert) {
      Object.assign(pendingInsert, data);
    } else {
      let pending = this.updates.get(id);
      if (!pending) {
        pending = {};
        this.updates.set(id, pending);
      }
      Object.assign(pending, data);
    }
  }

  /** Queues an insert and returns the temporary insert key, exactly like upstream. */
  insert(doc: Omit<T, '_id'> & { _id?: string | undefined }, id?: string): number {
    const data = cloneDeep(doc) as PlainRecord;
    removeHidden(data);
    if (id) {
      data._id = id;
    }
    this.opsCnt++;
    this.insertCnt++;
    this.inserts.set(String(this.insertCnt), data);
    return this.insertCnt;
  }

  remove(id: string | null | undefined): void {
    if (!id) {
      return;
    }
    this.opsCnt++;
    if (this.inserts.has(id)) {
      this.inserts.delete(id);
      this.insertCnt--;
      return;
    }
    this.ops.push({ op: 'remove', id });
  }

  /**
   * Upstream increments the live object under the literal key (a dotted key becomes a top-level
   * property of the in-memory copy), while the persisted document is incremented along the dotted
   * path like the MongoDB `$inc` the driver issues.
   */
  inc(target: T | string | null | undefined, key: IncKey<T>, amount: number): void {
    if (!target) {
      return;
    }
    let id: string;
    if (typeof target === 'string') {
      id = target;
    } else {
      const record = target as unknown as PlainRecord;
      const current = record[key];
      record[key] = (typeof current === 'number' ? current : 0) + amount;
      id = target._id;
    }
    this.opsCnt++;
    this.ops.push({ op: 'update', id, update: { $inc: { key, amount } } });
  }

  addToSet(target: T | string | null | undefined, key: ArrayKeys<T>, value: unknown): void {
    if (!target) {
      return;
    }
    const id = typeof target === 'string' ? target : target._id;
    this.opsCnt++;
    this.ops.push({ op: 'update', id, update: { $addToSet: { key, value } } });
  }

  pull(target: T | string | null | undefined, key: ArrayKeys<T>, value: unknown): void {
    if (!target) {
      return;
    }
    const id = typeof target === 'string' ? target : target._id;
    this.opsCnt++;
    this.ops.push({ op: 'update', id, update: { $pull: { key, value } } });
  }

  /** Applies all accumulated writes to the collection. Returns ids of inserted documents. */
  execute(): string[] {
    if (!this.opsCnt) {
      return [];
    }
    const ops: Op[] = this.ops.slice();
    for (const [id, set] of this.updates) {
      ops.push({ op: 'update', id, update: { $set: set } });
    }
    for (const data of this.inserts.values()) {
      ops.push({ op: 'insert', data });
    }
    // The upstream bulk crosses a process boundary (storage RPC) and is serialized here.
    const serialized = jsonClone(ops);
    const inserted: string[] = [];
    const collection = this.collection as Record<string, PlainRecord>;
    for (const op of serialized) {
      switch (op.op) {
        case 'update': {
          const doc = Object.prototype.hasOwnProperty.call(collection, op.id)
            ? collection[op.id]
            : undefined;
          if (doc) {
            updateDocument(doc, op.update);
          }
          break;
        }
        case 'insert': {
          const data = op.data;
          if (typeof data._id !== 'string' || !data._id) {
            data._id = this.genId();
          }
          const id = data._id as string;
          collection[id] = data;
          inserted.push(id);
          break;
        }
        case 'remove': {
          Reflect.deleteProperty(collection, op.id);
          break;
        }
      }
    }
    return inserted;
  }
}

function updateDocument(doc: PlainRecord, update: Update): void {
  if ('$set' in update) {
    Object.assign(doc, update.$set);
  }
  if ('$inc' in update) {
    const { key, amount } = update.$inc;
    const path = key.split('.');
    const last = path.pop() as string;
    let parent = doc;
    for (const segment of path) {
      const next = parent[segment];
      if (isObjectLike(next)) {
        parent = next as PlainRecord;
      } else {
        const created: PlainRecord = {};
        parent[segment] = created;
        parent = created;
      }
    }
    const current = parent[last];
    parent[last] = ((current as number | null | undefined) || 0) + amount;
  }
  if ('$addToSet' in update) {
    const { key, value } = update.$addToSet;
    let list = doc[key];
    if (!Array.isArray(list)) {
      list = [];
      doc[key] = list;
    }
    const array = list as unknown[];
    if (array.indexOf(value) === -1) {
      array.push(value);
    }
  }
  if ('$pull' in update) {
    const { key, value } = update.$pull;
    const list = doc[key];
    if (Array.isArray(list)) {
      const idx = list.indexOf(value);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    }
  }
}
