/*
 * Runtime bundle entry evaluated inside every player sandbox (screeps/driver `lib/runtime/runtime.js`
 * and `lib/runtime/mapgrid.js`). Installs `SandboxEntry` on the sandbox global.
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as fakeConsole from '../game/console.ts';
import type { ScriptCompiler } from '../game/eval-code.ts';
import * as game from '../game/game.ts';
import type { HeapStatistics } from '../game/game.ts';
import { IntentRecorder } from '../game/intents.ts';
import { createRawMemory, type SegmentRequests } from '../game/raw-memory.ts';
import type { MapGrid, MapGridRoomExits, RuntimeData, SandboxRuntimeData } from '../game/runtime-data.ts';
import type { SandboxGlobals } from '../game/scope.ts';
import { roomNameToXY } from '../../utils/index.ts';
import { SANDBOX_ENTRY_GLOBAL, type SandboxEntry, type SandboxResultMessage, type SandboxRunMessage } from '../protocol.ts';

/** Isolate handle as seen from inside the sandbox (isolated-vm `Isolate` or the trusted adapter). */
interface SandboxIsolate extends ScriptCompiler {
    readonly cpuTime: bigint;
    getHeapStatisticsSync(): HeapStatistics;
}

interface HostBindings {
    isolate: SandboxIsolate;
    context: unknown;
    halt: (() => void) | undefined;
}

const sandboxGlobal = globalThis as unknown as SandboxGlobals;

let host: HostBindings | undefined;
const staticTerrainData: Record<string, Uint8Array> = {};
let mapGrid: MapGrid | undefined;
let mapGridSource: string | undefined;
let pendingRun: (() => SandboxResultMessage) | undefined;

function isSandboxIsolate(value: unknown): value is SandboxIsolate {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof Reflect.get(value, 'compileScriptSync') === 'function' &&
        typeof Reflect.get(value, 'getHeapStatisticsSync') === 'function'
    );
}

function bindHalt(value: unknown): (() => void) | undefined {
    if (typeof value === 'function') {
        return () => {
            Reflect.apply(value, undefined, []);
        };
    }
    if (value !== null && typeof value === 'object') {
        const applySync: unknown = Reflect.get(value, 'applySync');
        if (typeof applySync === 'function') {
            return () => {
                Reflect.apply(applySync, value, []);
            };
        }
    }
    return undefined;
}

function requireHost(): HostBindings {
    if (!host) {
        throw new Error('Sandbox host is not installed');
    }
    return host;
}

function nowCpuTime(): number {
    return Number(requireHost().isolate.cpuTime) / 1e6;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes base64 binary modules (driver `bufferFromBase64`; a `Uint8Array` instead of a Buffer). */
function bufferFromBase64(data: string): Uint8Array {
    const clean = data.replace(/[^A-Za-z0-9+/]/g, '');
    const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let length = 0;
    let buffer = 0;
    let bits = 0;
    for (const char of clean) {
        buffer = (buffer << 6) | BASE64_ALPHABET.indexOf(char);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes[length++] = (buffer >> bits) & 0xff;
        }
    }
    return bytes.subarray(0, length);
}

const GRID_DIRECTIONS: ReadonlyArray<readonly [keyof MapGridRoomExits, number, number, number, number]> = [
    ['t', 0, 0, 1, 0],
    ['r', 49, 0, 0, 1],
    ['b', 0, 49, 1, 0],
    ['l', 0, 0, 0, 1],
];

/** Exit counts per accessible room (driver `WorldMapGrid._buildGridData`). */
function buildMapGrid(accessibleRooms: readonly string[]): MapGrid {
    const gridData: Record<string, MapGridRoomExits> = {};
    for (const roomName of accessibleRooms) {
        const [x, y] = roomNameToXY(roomName);
        const terrain = staticTerrainData[roomName];
        const roomData: MapGridRoomExits = {};
        for (const [dirName, startx, starty, dx, dy] of GRID_DIRECTIONS) {
            let curx = startx;
            let cury = starty;
            let numExits = 0;
            for (let i = 0; i < 50; ++i) {
                if (terrain?.[cury * 50 + curx] == 0) {
                    numExits++;
                }
                curx += dx;
                cury += dy;
            }
            if (numExits > 0) {
                roomData[dirName] = numExits;
            }
        }
        gridData[`${String(x)},${String(y)}`] = roomData;
    }
    return { gridData };
}

function parseAccessibleRooms(source: string): string[] {
    const parsed: unknown = JSON.parse(source);
    return Array.isArray(parsed) ? parsed.filter((i): i is string => typeof i === 'string') : [];
}

function validateSegments(segments: Record<string, unknown>): Record<number, string> | string | undefined {
    const segmentKeys = Object.keys(segments);
    if (segmentKeys.length == 0) {
        return undefined;
    }
    if (segmentKeys.length > 10) {
        return 'Cannot save more than 10 memory segments on the same tick';
    }
    const result: Record<number, string> = {};
    for (const segmentKey of segmentKeys) {
        const key = parseInt(segmentKey);
        if (Number.isNaN(key) || key < 0 || key > 99) {
            return `"${segmentKey}" is not a valid memory segment ID`;
        }
        const value = segments[segmentKey];
        if (typeof value != 'string') {
            return `Memory segment #${segmentKey} is not a string`;
        }
        if (value.length > 100 * 1024) {
            return `Memory segment #${segmentKey} has exceeded 100 KB length limit`;
        }
        result[key] = '' + value;
    }
    return result;
}

function errorText(e: unknown): string {
    if (e !== null && typeof e === 'object') {
        const stack: unknown = Reflect.get(e, 'stack');
        if (stack) {
            return String(stack);
        }
    }
    return String(e);
}

function start(dataJson: string, cpu: number, cpuBucket: number): void {
    const bindings = requireHost();
    const parsed = JSON.parse(dataJson) as Omit<RuntimeData, 'cpu' | 'cpuBucket'>;
    Object.setPrototypeOf(parsed, null);

    const startDirtyTime = nowCpuTime();
    let startTime = startDirtyTime;
    const requests: SegmentRequests = {
        activeSegments: undefined,
        publicSegments: undefined,
        defaultPublicSegment: undefined,
        activeForeignSegment: undefined,
    };
    const intents = new IntentRecorder();
    const rawMemory = createRawMemory(parsed.userMemory, parsed.memorySegments, parsed.foreignMemorySegment, requests);

    if (!mapGrid || mapGridSource !== parsed.accessibleRooms) {
        mapGrid = buildMapGrid(parseAccessibleRooms(parsed.accessibleRooms));
        mapGridSource = parsed.accessibleRooms;
    }
    const data: SandboxRuntimeData = { ...parsed, cpu, cpuBucket, mapGrid, staticTerrainData };

    const getUsedCpu = (): number => nowCpuTime() + intents.cpu - startTime;
    const halt = bindings.halt;
    const cpuHalt = halt
        ? (): never => {
              halt();
              throw new Error('No one should ever see this message.');
          }
        : undefined;

    game.init({
        globals: sandboxGlobal,
        codeModules: data.userCode,
        runtimeData: data,
        intents,
        rawMemory,
        console: fakeConsole.makeConsole(),
        timeout: data.cpu,
        getUsedCpu,
        getHeapStatistics: () => bindings.isolate.getHeapStatisticsSync(),
        cpuHalt,
        evalHost: { compiler: bindings.isolate, context: bindings.context },
        bufferFromBase64,
    });

    pendingRun = (): SandboxResultMessage => {
        startTime = nowCpuTime();
        let type: SandboxRunMessage['type'];
        let error: string | undefined;
        try {
            game.run();
            type = 'done';
        } catch (e) {
            type = 'error';
            error = errorText(e);
        }

        if (rawMemory._parsed) {
            data.userMemory.data = JSON.stringify(rawMemory._parsed);
        }

        const memorySegments = validateSegments(rawMemory.segments);
        if (typeof memorySegments === 'string') {
            return { type: 'fatal', error: memorySegments };
        }

        const now = nowCpuTime();
        const outMessage: SandboxRunMessage = {
            type,
            usedTime: Math.ceil(now - startTime + intents.cpu),
            usedCleanTime: now - startTime,
            usedDirtyTime: Math.ceil(now - startDirtyTime),
            intentsList: intents.list,
            intentsCpu: intents.cpu,
            memory: data.userMemory,
            console: {
                log: fakeConsole.getMessages(),
                results: fakeConsole.getCommandResults(),
            },
        };
        if (error !== undefined) {
            outMessage.error = error;
        }
        if (memorySegments) {
            outMessage.memorySegments = memorySegments;
        }
        const visual = fakeConsole.getVisual();
        if (Object.keys(visual).length > 0) {
            outMessage.visual = visual;
        }
        if (requests.activeSegments) {
            outMessage.activeSegments = requests.activeSegments;
        }
        if (requests.activeForeignSegment !== undefined) {
            outMessage.activeForeignSegment = requests.activeForeignSegment;
        }
        if (requests.defaultPublicSegment !== undefined) {
            outMessage.defaultPublicSegment = requests.defaultPublicSegment;
        }
        if (requests.publicSegments) {
            outMessage.publicSegments = requests.publicSegments.join(',');
        }
        return outMessage;
    };
}

const entry: SandboxEntry = {
    install(): void {
        const isolate: unknown = Reflect.get(globalThis, '_isolate');
        if (!isSandboxIsolate(isolate)) {
            throw new Error('Sandbox host did not provide a script compiler');
        }
        host = {
            isolate,
            context: Reflect.get(globalThis, '_context'),
            halt: bindHalt(Reflect.get(globalThis, '_halt')),
        };
        for (const name of ['_isolate', '_context', '_halt', '_ivm']) {
            Reflect.deleteProperty(globalThis, name);
        }
        Reflect.set(globalThis, 'global', globalThis);
    },
    setStaticTerrainData(buffer: ArrayBuffer, roomOffsets: string): void {
        const offsets = JSON.parse(roomOffsets) as Record<string, number>;
        for (const [room, offset] of Object.entries(offsets)) {
            staticTerrainData[room] = new Uint8Array(buffer, offset, 2500);
        }
    },
    start,
    run(): string {
        const runFn = pendingRun;
        pendingRun = undefined;
        if (!runFn) {
            return JSON.stringify({ type: 'fatal', error: 'Player run was not started' } satisfies SandboxResultMessage);
        }
        return JSON.stringify(runFn());
    },
};

Object.defineProperty(globalThis, SANDBOX_ENTRY_GLOBAL, { value: entry, configurable: true });
