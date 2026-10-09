/*
 * Intent recorder used by the game API inside the sandbox (driver `lib/runtime/runtime.js`).
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

/** Intents of one object (or the special `room` key) keyed by intent name. */
export type ObjectIntentList = Record<string, unknown>;

/**
 * Raw per-tick intent list: object id → intents, or list name (e.g. `notify`) → pushed entries.
 * Created with a `null` prototype like upstream.
 */
export type IntentList = Record<string, ObjectIntentList | unknown[]>;

/** CPU charged per intent by the official driver; `say` and `pull` are free. */
export const INTENT_CPU = 0.2;
const FREE_METHODS: Record<string, true> = { say: true, pull: true };

export class IntentRecorder {
    readonly list: IntentList = Object.create(null) as IntentList;
    cpu = 0;

    #objectEntry(id: string): ObjectIntentList {
        const existing = this.list[id];
        if (existing && !Array.isArray(existing)) {
            return existing;
        }
        const created = Object.create(null) as ObjectIntentList;
        this.list[id] = created;
        return created;
    }

    set(id: string, name: string, data: unknown): void {
        const entry = this.#objectEntry(id);
        if (!FREE_METHODS[name] && !entry[name]) {
            this.cpu += INTENT_CPU;
        }
        entry[name] = data;
    }

    push(name: string, data: unknown, maxLen?: number): boolean {
        const existing = this.list[name];
        const list = Array.isArray(existing) ? existing : [];
        this.list[name] = list;
        if (maxLen && list.length >= maxLen) {
            return false;
        }
        list.push(data);
        this.cpu += INTENT_CPU;
        return true;
    }

    pushByName(id: string, name: string, data: unknown, maxLen?: number): boolean {
        const entry = this.#objectEntry(id);
        const existing = entry[name];
        const list: unknown[] = Array.isArray(existing) ? existing : [];
        entry[name] = list;
        if (maxLen && list.length >= maxLen) {
            return false;
        }
        list.push(data);
        this.cpu += INTENT_CPU;
        return true;
    }

    remove(id: string, name: string): boolean {
        const entry = this.list[id];
        if (entry && !Array.isArray(entry) && entry[name]) {
            delete entry[name];
            this.cpu -= INTENT_CPU;
            return true;
        }
        return false;
    }
}
