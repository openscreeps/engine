/*
 * Player runtime: persistent per-user code, memory, segments and CPU bucket, executed in per-user
 * sandboxes (screeps/driver `lib/runtime/make.js`, `user-vm.js`, `data.js` and engine `runner.js`).
 *
 * Portions derived from screeps/driver and screeps/engine, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { WorldState } from '../simulation/state.ts';
import { storeIntents, type StoredUserIntents } from '../utils/index.ts';
import type { ConsoleMessage } from './game/console.ts';
import type { IntentList } from './game/intents.ts';
import type { CodeModules, ConsoleCommand, RuntimeData } from './game/runtime-data.ts';
import { getRuntimeBundle } from './host/bundle.ts';
import { createIsolatedVmSandbox } from './host/isolated-vm-sandbox.ts';
import {
    buildRuntimeData,
    buildWorldIndex,
    type ForeignSegmentSelection,
    type WorldIndex,
} from './host/runtime-data.ts';
import type { PlayerSandbox, SandboxFactory, TerrainPack } from './host/sandbox.ts';
import { createTrustedVmSandbox } from './host/trusted-vm-sandbox.ts';
import type { SandboxRunMessage } from './protocol.ts';

export type { CodeModules, ConsoleCommand } from './game/runtime-data.ts';
export type { ConsoleMessage } from './game/console.ts';

/**
 * `isolated-vm`: every player runs in its own V8 isolate with a heap limit (suitable for untrusted
 * code). `trusted-node-vm`: node:vm contexts in the host isolate — NOT a security boundary, only for
 * trusted bots (faster startup, no native dependency at run time).
 */
export type SandboxKind = 'isolated-vm' | 'trusted-node-vm';

export interface BotRuntimeOptions {
    sandbox?: SandboxKind;
    /** Heap limit per player isolate in MB (upstream 256; terrain size is added). */
    memoryLimitMb?: number;
    /** Maximum CPU per tick including bucket (upstream `config.engine.cpuMaxPerTick`, 500). */
    cpuMaxPerTick?: number;
    /** Bucket capacity (upstream `config.engine.cpuBucketSize`, 10000). */
    cpuBucketSize?: number;
    /** Hard wall-clock limit per player run before the sandbox is reset (upstream 5000 ms). */
    hardTimeoutMs?: number;
    /** Clock used for room status/openTime checks (default `Date.now`). */
    now?: () => number;
    snapshot?: RuntimeSnapshot;
}

/** Persisted per-user runtime state. */
export interface RuntimeUserSnapshot {
    modules: CodeModules;
    branch: string;
    codeTimestamp: number;
    memory: string;
    segments: Record<number, string>;
    activeSegments: number[];
    publicSegments?: string;
    defaultPublicSegment?: number | null;
    activeForeignSegment?: ForeignSegmentSelection;
    /** CPU bucket (`users.cpuAvailable`); seeded from the world user document when absent. */
    cpuAvailable?: number;
    consoleCommands: ConsoleCommand[];
}

export interface RuntimeSnapshot {
    version: 1;
    lastCodeTimestamp: number;
    users: Record<string, RuntimeUserSnapshot>;
}

export interface UserRunResult {
    userId: string;
    /** Sanitized intents for the simulation (empty when the run failed). */
    intents: StoredUserIntents;
    console: { log: ConsoleMessage[]; results: string[]; error?: string };
    /** Room visuals keyed by room name (`map` for the map visual), newline separated JSON. */
    visual: Record<string, string>;
    cpu: { used: number; limit: number; bucket: number };
    memorySize: number;
    /** Memory exceeded 2 MB and was not saved (upstream rejects the save silently). */
    memoryRejected: boolean;
    /** A new sandbox (global reset) was created for this run. */
    reset: boolean;
    /** `Game.cpu.halt()` was called. */
    halted: boolean;
}

export interface TickRunResult {
    intents: Record<string, StoredUserIntents>;
    users: Record<string, UserRunResult>;
}

const MEMORY_LIMIT = 2 * 1024 * 1024;
const FREE_INTENTS: Record<string, true> = { say: true, pull: true };

/** Driver `intentsCount`: every non-free intent (list entries counted individually). */
function intentsCount(intentsList: IntentList): number {
    let count = 0;
    for (const entity of Object.values(intentsList)) {
        if (Array.isArray(entity)) {
            continue;
        }
        for (const [name, value] of Object.entries(entity)) {
            if (!FREE_INTENTS[name]) {
                count += Array.isArray(value) ? value.length : 1;
            }
        }
    }
    return count;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? error.message;
    }
    return String(error);
}

function emptyResult(userId: string, cpuLimit: number, bucket: number, error: string, reset: boolean, halted: boolean): UserRunResult {
    return {
        userId,
        intents: { rooms: {} },
        console: { log: [], results: [], error },
        visual: {},
        cpu: { used: 0, limit: cpuLimit, bucket },
        memorySize: 0,
        memoryRejected: false,
        reset,
        halted,
    };
}

export class BotRuntime implements Disposable {
    readonly #factory: SandboxFactory;
    readonly #memoryLimitMb: number;
    readonly #cpuMaxPerTick: number;
    readonly #cpuBucketSize: number;
    readonly #hardTimeoutMs: number;
    readonly #now: () => number;
    readonly #users: Record<string, RuntimeUserSnapshot>;
    readonly #sandboxes: Record<string, PlayerSandbox> = {};
    readonly #pendingSandboxes: Record<string, Promise<PlayerSandbox>> = {};
    #lastCodeTimestamp: number;
    #terrain: TerrainPack | undefined;
    #terrainSignature = '';
    #disposed = false;

    constructor(options: BotRuntimeOptions = {}) {
        this.#factory = options.sandbox === 'trusted-node-vm' ? createTrustedVmSandbox : createIsolatedVmSandbox;
        this.#memoryLimitMb = options.memoryLimitMb ?? 256;
        this.#cpuMaxPerTick = options.cpuMaxPerTick ?? 500;
        this.#cpuBucketSize = options.cpuBucketSize ?? 10000;
        this.#hardTimeoutMs = options.hardTimeoutMs ?? 5000;
        this.#now = options.now ?? Date.now;
        const snapshot: RuntimeSnapshot | undefined = options.snapshot ? structuredClone(options.snapshot) : undefined;
        this.#users = snapshot?.users ?? {};
        this.#lastCodeTimestamp = snapshot?.lastCodeTimestamp ?? 0;
    }

    #user(userId: string): RuntimeUserSnapshot {
        return (this.#users[userId] ??= {
            modules: {},
            branch: 'default',
            codeTimestamp: 0,
            memory: '',
            segments: {},
            activeSegments: [],
            consoleCommands: [],
        });
    }

    #assertActive(): void {
        if (this.#disposed) {
            throw new Error('BotRuntime is disposed');
        }
    }

    /** Replaces the player's code; the next run starts with a fresh sandbox (global reset). */
    setCode(userId: string, modules: CodeModules, branch = 'default'): void {
        this.#assertActive();
        const user = this.#user(userId);
        user.modules = structuredClone(modules);
        user.branch = branch;
        this.#lastCodeTimestamp = Math.max(this.#now(), this.#lastCodeTimestamp + 1);
        user.codeTimestamp = this.#lastCodeTimestamp;
    }

    getCode(userId: string): { modules: CodeModules; branch: string } | undefined {
        const user = this.#users[userId];
        return user ? { modules: structuredClone(user.modules), branch: user.branch } : undefined;
    }

    getMemory(userId: string): string {
        return this.#users[userId]?.memory ?? '';
    }

    setMemory(userId: string, raw: string): void {
        this.#assertActive();
        this.#user(userId).memory = raw;
    }

    getSegment(userId: string, id: number): string | undefined {
        return this.#users[userId]?.segments[id];
    }

    setSegment(userId: string, id: number, data: string): void {
        this.#assertActive();
        if (!Number.isInteger(id) || id < 0 || id > 99) {
            throw new Error(`"${String(id)}" is not a valid segment ID`);
        }
        this.#user(userId).segments[id] = data;
    }

    /** Queues a console expression evaluated after the next main loop (`users.console`). */
    enqueueConsoleCommand(userId: string, expression: string, hidden = false): void {
        this.#assertActive();
        const command: ConsoleCommand = { expression };
        if (hidden) {
            command.hidden = true;
        }
        this.#user(userId).consoleCommands.push(command);
    }

    snapshot(): RuntimeSnapshot {
        return structuredClone({ version: 1, lastCodeTimestamp: this.#lastCodeTimestamp, users: this.#users });
    }

    #terrainPack(world: Readonly<WorldState>): TerrainPack {
        const rooms = Object.keys(world.terrain);
        const signature = rooms.join(',');
        if (this.#terrain && signature === this.#terrainSignature) {
            return this.#terrain;
        }
        const view = new Uint8Array(rooms.length * 2500);
        const offsets: Record<string, number> = {};
        rooms.forEach((room, roomIndex) => {
            const terrain = world.terrain[room] ?? '';
            const offset = roomIndex * 2500;
            for (let i = 0; i < 2500; i++) {
                view[i + offset] = Number(terrain.charAt(i));
            }
            offsets[room] = offset;
        });
        this.#terrain = {
            version: (this.#terrain?.version ?? 0) + 1,
            buffer: view.buffer,
            roomOffsets: JSON.stringify(offsets),
            byteLength: view.byteLength,
        };
        this.#terrainSignature = signature;
        return this.#terrain;
    }

    async #sandbox(userId: string, codeTimestamp: number, terrain: TerrainPack): Promise<{ sandbox: PlayerSandbox; reset: boolean }> {
        const existing = this.#sandboxes[userId];
        if (existing) {
            if (existing.disposed) {
                this.#clear(userId);
                throw new Error(
                    'Script execution has been terminated: your isolate disposed unexpectedly, restarting virtual machine',
                );
            }
            if (codeTimestamp <= existing.codeTimestamp) {
                await existing.loadTerrain(terrain);
                return { sandbox: existing, reset: false };
            }
            this.#clear(userId);
        }
        const pending = (this.#pendingSandboxes[userId] ??= getRuntimeBundle().then((bundle) =>
            this.#factory({ bundle, codeTimestamp, memoryLimitMb: this.#memoryLimitMb, terrain }),
        ));
        try {
            const sandbox = await pending;
            this.#sandboxes[userId] = sandbox;
            return { sandbox, reset: true };
        } finally {
            Reflect.deleteProperty(this.#pendingSandboxes, userId);
        }
    }

    #clear(userId: string): void {
        this.#sandboxes[userId]?.dispose();
        Reflect.deleteProperty(this.#sandboxes, userId);
    }

    #publicSegments = (userId: string): { publicSegments: string | undefined; segments: Record<number, string> } | undefined => {
        const user = this.#users[userId];
        return user ? { publicSegments: user.publicSegments, segments: user.segments } : undefined;
    };

    /** Runs one player against the current world state (upstream `driver.makeRuntime`). */
    async runUser(world: Readonly<WorldState>, userId: string, index?: WorldIndex): Promise<UserRunResult | undefined> {
        this.#assertActive();
        const state = this.#users[userId];
        const userDoc = world.users[userId];
        if (!state || !userDoc) {
            return undefined;
        }
        const worldIndex = index ?? buildWorldIndex(world, this.#now());

        // Upstream `getUserData`: bucket accounting and empty-bucket skip.
        let cpu = Infinity;
        let cpuBucket = Infinity;
        state.cpuAvailable ??= userDoc.cpuAvailable ?? 0;
        if (userDoc.cpu) {
            if (state.cpuAvailable < 0) {
                state.cpuAvailable =
                    state.cpuAvailable < -userDoc.cpu * 2 ? -userDoc.cpu * 2 : state.cpuAvailable + userDoc.cpu;
                return emptyResult(userId, 0, state.cpuAvailable, 'Script execution has been terminated: CPU bucket is empty', false, false);
            }
            cpuBucket = state.cpuAvailable;
            cpu = Math.min(cpuBucket + userDoc.cpu, this.#cpuMaxPerTick);
        }

        const data: RuntimeData | undefined = buildRuntimeData(
            world,
            worldIndex,
            userId,
            {
                modules: state.modules,
                codeTimestamp: state.codeTimestamp,
                memory: state.memory,
                consoleCommands: state.consoleCommands,
                activeSegments: state.activeSegments,
                segments: state.segments,
                activeForeignSegment: state.activeForeignSegment,
            },
            cpu,
            cpuBucket,
            this.#publicSegments,
        );
        if (!data) {
            return undefined;
        }
        state.consoleCommands = [];

        const terrain = this.#terrainPack(world);
        let reset = false;
        let sandbox: PlayerSandbox | undefined;
        let message: SandboxRunMessage;
        try {
            const acquired = await this.#sandbox(userId, state.codeTimestamp, terrain);
            sandbox = acquired.sandbox;
            reset = acquired.reset;
            // `cpu`/`cpuBucket` may be Infinity, which JSON cannot carry; they are passed separately.
            const payload = JSON.stringify({ ...data, cpu: 0, cpuBucket: 0 });
            const result = await this.#runWithHardTimeout(userId, sandbox, payload, cpu, cpuBucket);
            if (result.type === 'fatal') {
                return emptyResult(userId, cpu, cpuBucket, result.error, reset, false);
            }
            message = result;
        } catch (error) {
            const halted = sandbox?.haltRequested ?? false;
            const text = halted ? 'CPU halted' : errorMessage(error);
            if (halted || /Isolate is disposed/.test(text) || /Isolate has exhausted v8 heap space/.test(text)) {
                this.#clear(userId);
            }
            if (!halted && /Array buffer allocation failed/.test(text)) {
                this.#clear(userId);
                return emptyResult(
                    userId,
                    cpu,
                    cpuBucket,
                    'Script execution has been terminated: unable to allocate memory, restarting virtual machine',
                    reset,
                    false,
                );
            }
            return emptyResult(userId, cpu, cpuBucket, text, reset, halted);
        }

        const intents = storeIntents(message.intentsList, (objectId) => data.userObjects[objectId]?.room ?? data.roomObjects[objectId]?.room);
        const intentsCpu = 0.2 * intentsCount(message.intentsList);
        const cpuUsed = Math.ceil(message.usedCleanTime + intentsCpu);

        if (message.activeSegments) {
            state.activeSegments = message.activeSegments;
        }
        if (message.defaultPublicSegment !== undefined) {
            state.defaultPublicSegment = message.defaultPublicSegment;
        }
        if (userDoc.cpu) {
            state.cpuAvailable = Math.min(state.cpuAvailable + userDoc.cpu - cpuUsed, this.#cpuBucketSize);
        }
        if (message.activeForeignSegment !== undefined) {
            this.#applyForeignSegment(world, state, message.activeForeignSegment);
        }
        if (message.publicSegments !== undefined) {
            state.publicSegments = message.publicSegments;
        }

        const memoryRejected = message.memory.data.length > MEMORY_LIMIT;
        if (!memoryRejected) {
            state.memory = message.memory.data;
        }
        if (message.memorySegments) {
            for (const [key, value] of Object.entries(message.memorySegments)) {
                state.segments[Number(key)] = value;
            }
        }

        const result: UserRunResult = {
            userId,
            intents,
            console: { log: message.console.log, results: message.console.results },
            visual: message.visual ?? {},
            cpu: { used: message.usedTime, limit: cpu, bucket: state.cpuAvailable },
            memorySize: message.memory.data.length,
            memoryRejected,
            reset,
            halted: false,
        };
        if (message.error !== undefined) {
            result.console.error = message.error;
        }
        return result;
    }

    async #runWithHardTimeout(
        userId: string,
        sandbox: PlayerSandbox,
        data: string,
        cpu: number,
        cpuBucket: number,
    ): Promise<SandboxRunMessage | { type: 'fatal'; error: string }> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hardTimeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                this.#clear(userId);
                reject(new Error('Script execution timed out ungracefully, restarting virtual machine'));
            }, this.#hardTimeoutMs);
        });
        try {
            return await Promise.race([sandbox.run({ data, cpu, cpuBucket }, this.#hardTimeoutMs), hardTimeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    #applyForeignSegment(
        world: Readonly<WorldState>,
        state: RuntimeUserSnapshot,
        requested: { username: unknown; id: number | undefined } | null,
    ): void {
        if (requested === null) {
            delete state.activeForeignSegment;
            return;
        }
        const username = String(requested.username);
        const current = state.activeForeignSegment;
        if (current && username == current.username && requested.id) {
            current.id = requested.id;
            return;
        }
        const selection: ForeignSegmentSelection = { username };
        if (requested.id !== undefined) {
            selection.id = requested.id;
        }
        const target = Object.values(world.users).find((user) => user.username === username);
        if (target) {
            selection.userId = target._id;
            const defaultSegment = this.#users[target._id]?.defaultPublicSegment;
            if (!selection.id && defaultSegment) {
                selection.id = defaultSegment;
            }
        }
        state.activeForeignSegment = selection;
    }

    /** Runs every player that has code, in parallel sandboxes, against the same world state. */
    async runTick(world: Readonly<WorldState>): Promise<TickRunResult> {
        this.#assertActive();
        const index = buildWorldIndex(world, this.#now());
        const userIds = Object.keys(this.#users).filter((id) => Object.keys(this.#users[id]?.modules ?? {}).length > 0);
        const results = await Promise.all(userIds.map((id) => this.runUser(world, id, index)));
        const tick: TickRunResult = { intents: {}, users: {} };
        for (const result of results) {
            if (result) {
                tick.users[result.userId] = result;
                tick.intents[result.userId] = result.intents;
            }
        }
        return tick;
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        for (const userId of Object.keys(this.#sandboxes)) {
            this.#clear(userId);
        }
    }

    [Symbol.dispose](): void {
        this.dispose();
    }
}
