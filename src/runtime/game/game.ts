/*
 * `Game` construction, `Memory`/`require` wiring and per-tick player execution
 * (screeps/engine `src/game/game.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import lodash from 'lodash';
import * as C from '../../constants.ts';
import { isFunction, isObject } from './compat.ts';
import type { SandboxConsole } from './console.ts';
import * as constructionSites from './construction-sites.ts';
import { ConstructionSite } from './construction-sites.ts';
import * as creeps from './creeps.ts';
import { Creep } from './creeps.ts';
import * as deposits from './deposits.ts';
import { Deposit } from './deposits.ts';
import { evalCode, type EvalHost, type PlayerModule } from './eval-code.ts';
import * as flags from './flags.ts';
import { Flag } from './flags.ts';
import type { IntentRecorder } from './intents.ts';
import { makeMap, type GameMap } from './map.ts';
import * as market from './market.ts';
import { makeMarket, type GameMarket } from './market.ts';
import * as minerals from './minerals.ts';
import { Mineral } from './minerals.ts';
import * as nukes from './nukes.ts';
import { Nuke } from './nukes.ts';
import * as pathFinder from './path-finder.ts';
import * as powerCreeps from './power-creeps.ts';
import { PowerCreep } from './power-creeps.ts';
import type { RawMemory } from './raw-memory.ts';
import * as resources from './resources.ts';
import { Resource } from './resources.ts';
import type { RoomObject } from './room-object.ts';
import * as rooms from './rooms.ts';
import { Room } from './rooms.ts';
import * as ruins from './ruins.ts';
import { Ruin } from './ruins.ts';
import type { CodeModules, RawRoomObject, SandboxRuntimeData } from './runtime-data.ts';
import {
    createRoomRegister,
    Register,
    setScope,
    type ObjectRegistries,
    type RoomRegister,
    type SandboxGlobals,
} from './scope.ts';
import * as sources from './sources.ts';
import { Source } from './sources.ts';
import * as store from './store.ts';
import * as structures from './structures.ts';
import {
    OwnedStructure,
    StructureContainer,
    StructureController,
    StructureExtension,
    StructureExtractor,
    StructureFactory,
    StructureInvaderCore,
    StructureKeeperLair,
    StructureLab,
    StructureLink,
    StructureNuker,
    StructureObserver,
    StructurePortal,
    StructurePowerBank,
    StructurePowerSpawn,
    StructureRampart,
    StructureRoad,
    StructureSpawn,
    StructureStorage,
    StructureTerminal,
    StructureTower,
    StructureWall,
    type Structure,
} from './structures.ts';
import * as tombstones from './tombstones.ts';
import { Tombstone } from './tombstones.ts';

export type { RawMemory } from './raw-memory.ts';

/** `require` as installed on the player global. */
export interface RequireFunction {
    (moduleName: unknown): unknown;
    cache: Record<string, unknown>;
    timestamp: number;
    readonly initGlobals?: unknown;
}

/** V8 heap statistics as returned by `Game.cpu.getHeapStatistics()`. */
export type HeapStatistics = Record<string, number>;

export interface GameCpu {
    getUsed(): number;
    tickLimit: number;
    limit: number | undefined;
    bucket: number;
    getHeapStatistics: (() => HeapStatistics) | undefined;
    halt: (() => never) | undefined;
}

export interface GameLevel {
    level: number;
    progress: number;
    progressTotal: number;
}

export interface GameObject {
    creeps: Record<string, Creep>;
    powerCreeps: Record<string, PowerCreep>;
    spawns: Record<string, StructureSpawn>;
    structures: Record<string, Structure>;
    flags: Record<string, Flag>;
    constructionSites: Record<string, ConstructionSite>;
    rooms: Record<string, Room>;
    time: number;
    cpuLimit: number;
    cpu: GameCpu;
    map: GameMap;
    gcl: GameLevel;
    gpl: GameLevel;
    market: GameMarket;
    resources: Record<string, number>;
    getObjectById(id: unknown): RoomObject | null;
    notify(message: unknown, groupInterval?: unknown): number;
}

/** Everything `game.init` receives from the sandbox entry (driver `game.init` arguments). */
export interface GameInitOptions {
    globals: SandboxGlobals;
    codeModules: CodeModules;
    runtimeData: SandboxRuntimeData;
    intents: IntentRecorder;
    rawMemory: RawMemory;
    console: SandboxConsole;
    /** Per-script timeout base (`runtimeData.cpu`). */
    timeout: number;
    getUsedCpu: () => number;
    getHeapStatistics: () => HeapStatistics;
    cpuHalt: (() => never) | undefined;
    evalHost: Omit<EvalHost, 'globals'>;
    /** Base64 decoder for binary modules (driver `bufferFromBase64`). */
    bufferFromBase64: (data: string) => unknown;
}

interface FindFilterTarget {
    spawning?: unknown;
    my?: unknown;
    energy?: unknown;
    owner?: unknown;
}

const findCacheFn: Record<number, (i: FindFilterTarget) => boolean> = {
    [C.FIND_CREEPS]: (i) => !i.spawning,
    [C.FIND_MY_CREEPS]: (i) => !i.spawning && !!i.my,
    [C.FIND_HOSTILE_CREEPS]: (i) => !i.spawning && !i.my,
    [C.FIND_MY_POWER_CREEPS]: (i) => !!i.my,
    [C.FIND_HOSTILE_POWER_CREEPS]: (i) => !i.my,
    [C.FIND_MY_SPAWNS]: (i) => i.my === true,
    [C.FIND_HOSTILE_SPAWNS]: (i) => i.my === false,
    [C.FIND_SOURCES_ACTIVE]: (i) => typeof i.energy === 'number' && i.energy > 0,
    [C.FIND_MY_STRUCTURES]: (i) => i.my === true,
    [C.FIND_HOSTILE_STRUCTURES]: (i) => i.my === false && !!i.owner,
    [C.FIND_MY_CONSTRUCTION_SITES]: (i) => !!i.my,
    [C.FIND_HOSTILE_CONSTRUCTION_SITES]: (i) => i.my === false,
};

function addObjectToFindCache(register: Register, type: number, object: RoomObject & FindFilterTarget, roomName: string): void {
    const filter = findCacheFn[type];
    if (!filter || filter(object)) {
        const byType = (register.findCache[type] ??= {});
        (byType[roomName] ??= []).push(object);
    }
}

function roomRegister(register: Register, roomName: string): RoomRegister {
    return (register.byRoom[roomName] ??= createRoomRegister());
}

function addObjectToRegister<K extends keyof ObjectRegistries>(
    register: Register,
    type: K,
    object: ObjectRegistries[K][string],
    raw: RawRoomObject,
): void {
    register[type][raw._id] = object;
    const byRoom = roomRegister(register, raw.room);
    byRoom[type][raw._id] = object;
    const index = raw.x * 50 + raw.y;
    const spatial: Array<Array<ObjectRegistries[K][string]> | undefined> = byRoom.spatial[type];
    const list = spatial[index];
    if (list === undefined) {
        spatial[index] = [object];
    } else {
        list.push(object);
    }
}

const structureTypes: Record<string, new (id: string) => Structure> = {
    rampart: StructureRampart,
    road: StructureRoad,
    extension: StructureExtension,
    constructedWall: StructureWall,
    keeperLair: StructureKeeperLair,
    controller: StructureController,
    link: StructureLink,
    storage: StructureStorage,
    tower: StructureTower,
    observer: StructureObserver,
    powerBank: StructurePowerBank,
    powerSpawn: StructurePowerSpawn,
    lab: StructureLab,
    extractor: StructureExtractor,
    terminal: StructureTerminal,
    container: StructureContainer,
    spawn: StructureSpawn,
    nuker: StructureNuker,
    portal: StructurePortal,
    factory: StructureFactory,
    invaderCore: StructureInvaderCore,
};

function makeGameObject(options: GameInitOptions, register: Register): GameObject {
    const { runtimeData, intents, getUsedCpu, getHeapStatistics, cpuHalt, globals } = options;

    const gclLevel = Math.floor(Math.pow((runtimeData.user.gcl || 0) / C.GCL_MULTIPLY, 1 / C.GCL_POW)) + 1;
    const gclBaseProgress = Math.pow(gclLevel - 1, C.GCL_POW) * C.GCL_MULTIPLY;

    const gplLevel = Math.floor(
        Math.pow((runtimeData.user.power || 0) / C.POWER_LEVEL_MULTIPLY, 1 / C.POWER_LEVEL_POW),
    );
    const gplBaseProgress = Math.pow(gplLevel, C.POWER_LEVEL_POW) * C.POWER_LEVEL_MULTIPLY;

    const gameCreeps: Record<string, Creep> = {};
    const gamePowerCreeps: Record<string, PowerCreep> = {};
    const gameSpawns: Record<string, StructureSpawn> = {};
    const gameStructures: Record<string, Structure> = {};
    const gameFlags: Record<string, Flag> = {};
    const gameConstructionSites: Record<string, ConstructionSite> = {};

    for (const [key, object] of Object.entries(runtimeData.roomObjects)) {
        if (object.temp) {
            continue;
        }
        (register.objectsByRoom[object.room] ??= {})[key] = object;
        (register.objectsByRoomKeys[object.room] ??= []).push(key);
    }

    for (const roomName of Object.keys(runtimeData.rooms)) {
        register.byRoom[roomName] = createRoomRegister();
    }

    rooms.make();
    creeps.make();
    structures.make();
    sources.make();
    minerals.make();
    deposits.make();
    nukes.make();
    resources.make();
    flags.make();
    tombstones.make();
    constructionSites.make();
    pathFinder.make();
    powerCreeps.make();
    ruins.make();
    store.make();
    market.make();

    for (const roomName of Object.keys(runtimeData.rooms)) {
        register.rooms[roomName] = new Room(roomName);
    }

    const gameRooms: Record<string, Room> = { ...register.rooms };

    for (const id of Object.keys(runtimeData.userPowerCreeps)) {
        const powerCreep = new PowerCreep(id);
        register.powerCreeps[id] = powerCreep;
        gamePowerCreeps[powerCreep.name] = powerCreep;
    }

    for (const [i, object] of Object.entries(runtimeData.roomObjects)) {
        if (object.temp) {
            continue;
        }

        if (object.type == 'creep') {
            const creep = new Creep(i);
            register._objects[i] = creep;
            addObjectToRegister(register, 'creeps', creep, object);
            if (runtimeData.userObjects[i]) {
                if (gameCreeps[creep.name]) {
                    creep.suicide();
                } else {
                    gameCreeps[creep.name] = creep;
                }
            }
            addObjectToFindCache(register, C.FIND_CREEPS, creep, object.room);
            addObjectToFindCache(register, C.FIND_MY_CREEPS, creep, object.room);
            addObjectToFindCache(register, C.FIND_HOSTILE_CREEPS, creep, object.room);
        }
        if (object.type == 'powerCreep') {
            const powerCreep = register.powerCreeps[i] ?? new PowerCreep(i);
            register._objects[i] = powerCreep;
            addObjectToRegister(register, 'powerCreeps', powerCreep, object);
            addObjectToFindCache(register, C.FIND_POWER_CREEPS, powerCreep, object.room);
            addObjectToFindCache(register, C.FIND_MY_POWER_CREEPS, powerCreep, object.room);
            addObjectToFindCache(register, C.FIND_HOSTILE_POWER_CREEPS, powerCreep, object.room);
        }
        const StructureType = structureTypes[object.type];
        if (StructureType) {
            const structure = new StructureType(i);
            register._objects[i] = structure;
            addObjectToRegister(register, 'structures', structure, object);

            if (structure instanceof OwnedStructure) {
                if (runtimeData.userObjects[i]) {
                    gameStructures[structure.id] = structure;
                }
                addObjectToRegister(register, 'ownedStructures', structure, object);
            }

            addObjectToFindCache(register, C.FIND_STRUCTURES, structure, object.room);
            addObjectToFindCache(register, C.FIND_MY_STRUCTURES, structure, object.room);
            addObjectToFindCache(register, C.FIND_HOSTILE_STRUCTURES, structure, object.room);

            if (structure instanceof StructureSpawn) {
                addObjectToRegister(register, 'spawns', structure, object);
                if (runtimeData.userObjects[i]) {
                    gameSpawns[structure.name] = structure;
                }
                addObjectToFindCache(register, C.FIND_MY_SPAWNS, structure, object.room);
                addObjectToFindCache(register, C.FIND_HOSTILE_SPAWNS, structure, object.room);
            }
        }
        if (
            !object.off &&
            (object.type == 'extension' || object.type == 'spawn') &&
            object.user == runtimeData.user._id
        ) {
            const room = register.rooms[object.room];
            if (room) {
                room.energyAvailable += object.store?.energy ?? 0;
                room.energyCapacityAvailable += object.storeCapacityResource?.energy ?? 0;
            }
        }
        if (object.type == 'source') {
            const source = new Source(i);
            register._objects[i] = source;
            addObjectToRegister(register, 'sources', source, object);
            addObjectToFindCache(register, C.FIND_SOURCES, source, object.room);
            addObjectToFindCache(register, C.FIND_SOURCES_ACTIVE, source, object.room);
        }
        if (object.type == 'mineral') {
            const mineral = new Mineral(i);
            register._objects[i] = mineral;
            addObjectToRegister(register, 'minerals', mineral, object);
            addObjectToFindCache(register, C.FIND_MINERALS, mineral, object.room);
        }
        if (object.type == 'deposit') {
            const deposit = new Deposit(i);
            register._objects[i] = deposit;
            addObjectToRegister(register, 'deposits', deposit, object);
            addObjectToFindCache(register, C.FIND_DEPOSITS, deposit, object.room);
        }
        if (object.type == 'energy') {
            const resource = new Resource(i);
            register._objects[i] = resource;
            addObjectToRegister(register, 'energy', resource, object);
            addObjectToFindCache(register, C.FIND_DROPPED_RESOURCES, resource, object.room);
        }
        if (object.type == 'nuke') {
            const nuke = new Nuke(i);
            register._objects[i] = nuke;
            addObjectToRegister(register, 'nukes', nuke, object);
            addObjectToFindCache(register, C.FIND_NUKES, nuke, object.room);
        }
        if (object.type == 'tombstone') {
            const tombstone = new Tombstone(i);
            register._objects[i] = tombstone;
            addObjectToRegister(register, 'tombstones', tombstone, object);
            addObjectToFindCache(register, C.FIND_TOMBSTONES, tombstone, object.room);
        }
        if (object.type == 'ruin') {
            const ruin = new Ruin(i);
            register._objects[i] = ruin;
            addObjectToRegister(register, 'ruins', ruin, object);
            addObjectToFindCache(register, C.FIND_RUINS, ruin, object.room);
        }
        if (object.type == 'constructionSite') {
            const site = new ConstructionSite(i);
            register._objects[i] = site;
            const owned = runtimeData.userObjects[i];
            if (owned) {
                gameConstructionSites[site.id] = site;
                roomRegister(register, owned.room);
            }
            addObjectToRegister(register, 'constructionSites', site, object);
            if (runtimeData.rooms[object.room]) {
                addObjectToFindCache(register, C.FIND_CONSTRUCTION_SITES, site, object.room);
                addObjectToFindCache(register, C.FIND_MY_CONSTRUCTION_SITES, site, object.room);
                addObjectToFindCache(register, C.FIND_HOSTILE_CONSTRUCTION_SITES, site, object.room);
            }
        }
    }

    for (const flagRoomData of runtimeData.flags) {
        for (const flagData of flagRoomData.data.split('|')) {
            if (!flagData) {
                continue;
            }
            const info = flagData.split('~');
            const name = (info[0] ?? '').replace(/\$VLINE\$/g, '|').replace(/\$TILDE\$/g, '~');
            const id = 'flag_' + name;
            const flag = new Flag(name, info[1], info[2], flagRoomData.room, info[3], info[4]);
            register._objects[id] = flag;
            register.flags[id] = flag;
            const byRoom = register.byRoom[flagRoomData.room];
            if (byRoom) {
                byRoom.flags[id] = flag;
                const index = +(info[3] ?? NaN) * 50 + +(info[4] ?? NaN);
                const list = byRoom.spatial.flags[index];
                if (list === undefined) {
                    byRoom.spatial.flags[index] = [flag];
                } else {
                    list.push(flag);
                }
            }
            gameFlags[name] = flag;
            addObjectToFindCache(register, C.FIND_FLAGS, flag, flagRoomData.room);
        }
    }

    const gameMap = makeMap();
    register.map = gameMap;
    const gameMarket = makeMarket();
    register.market = gameMarket;

    const game: GameObject = {
        creeps: gameCreeps,
        powerCreeps: gamePowerCreeps,
        spawns: gameSpawns,
        structures: gameStructures,
        flags: gameFlags,
        constructionSites: gameConstructionSites,
        rooms: gameRooms,
        time: runtimeData.time,
        cpuLimit: runtimeData.cpu,
        cpu: {
            getUsed(): number {
                return getUsedCpu();
            },
            tickLimit: runtimeData.cpu,
            limit: runtimeData.user.cpu,
            bucket: runtimeData.cpuBucket,
            getHeapStatistics: function (): HeapStatistics {
                return getHeapStatistics();
            },
            halt: cpuHalt,
        },
        map: gameMap,
        gcl: {
            level: gclLevel,
            progress: (runtimeData.user.gcl || 0) - gclBaseProgress,
            progressTotal: Math.pow(gclLevel, C.GCL_POW) * C.GCL_MULTIPLY - gclBaseProgress,
        },
        gpl: {
            level: gplLevel,
            progress: (runtimeData.user.power || 0) - gplBaseProgress,
            progressTotal: Math.pow(gplLevel + 1, 2) * 1000 - gplBaseProgress,
        },
        market: gameMarket,
        resources: JSON.parse(JSON.stringify(runtimeData.user.resources || {})) as Record<string, number>,
        getObjectById(id: unknown): RoomObject | null {
            return register._objects[String(id)] || null;
        },
        notify(message: unknown, groupInterval?: unknown): number {
            if (intents.push('notify', { message, groupInterval }, 20)) {
                return C.OK;
            }
            return C.ERR_FULL;
        },
    };

    const constants: unknown = JSON.parse(JSON.stringify(C));
    if (isObject(constants)) {
        Object.assign(globals, constants);
    }

    return game;
}

interface RunState {
    options: GameInitOptions;
    evalHost: EvalHost;
}

let state: RunState | undefined;

function requireModule(this: RunState, moduleName: unknown): unknown {
    if (typeof moduleName !== 'string') {
        throw new TypeError('moduleName.replace is not a function');
    }
    const name = moduleName.replace(/^\.\//, '');
    const { globals, codeModules, runtimeData, timeout, bufferFromBase64 } = this.options;
    const cache = globals.require.cache;

    if (!(name in cache)) {
        const code = codeModules[name];
        if (code === undefined) {
            throw new Error(`Unknown module '${name}'`);
        }
        if (typeof code === 'object' && 'binary' in code) {
            cache[name] = bufferFromBase64(code.binary);
        } else if (typeof code === 'string') {
            cache[name] = -1;
            const moduleObject: PlayerModule = {
                exports: {},
                user: runtimeData.user._id,
                timestamp: runtimeData.userCodeTimestamp,
                name,
                code,
            };
            try {
                evalCode(this.evalHost, moduleObject, false, timeout);
            } catch (e) {
                Reflect.deleteProperty(cache, name);
                throw e;
            }
            cache[name] = moduleObject.exports;
        }
    } else if (cache[name] === -1) {
        throw new Error(`Circular reference to module '${name}'`);
    }
    return cache[name];
}

/** Prepares globals (`RawMemory`, `console`, `_`, `Memory`, `Game`, `require`) for this tick. */
export function init(options: GameInitOptions): void {
    const { globals, runtimeData, rawMemory } = options;
    const evalHost: EvalHost = { ...options.evalHost, globals };
    const runState: RunState = { options, evalHost };
    state = runState;

    const register = new Register((message) => {
        globals.console.log(message);
    });
    setScope({ runtimeData, intents: options.intents, register, globals });

    Object.assign(globals, { RawMemory: rawMemory, console: options.console });

    if (!globals._) {
        globals._ = lodash.runInContext();
    }

    Object.defineProperty(globals, 'Memory', {
        configurable: true,
        enumerable: true,
        get(): unknown {
            try {
                const parsed: unknown = JSON.parse(rawMemory.get() || '{}');
                if (parsed !== null && typeof parsed === 'object') {
                    Object.setPrototypeOf(parsed, null);
                }
                rawMemory._parsed = parsed;
            } catch {
                rawMemory._parsed = null;
            }
            Object.defineProperty(globals, 'Memory', {
                configurable: true,
                enumerable: true,
                value: rawMemory._parsed,
            });
            return rawMemory._parsed;
        },
    });

    globals.Game = makeGameObject(options, register);

    const existing: unknown = Reflect.get(globals, 'require');
    const cachedMain: unknown = isFunction(existing) ? Reflect.get(Reflect.get(existing, 'cache') ?? {}, 'main') : undefined;
    if (
        !isFunction(existing) ||
        runtimeData.userCodeTimestamp != Reflect.get(existing, 'timestamp') ||
        !isObject(cachedMain) ||
        !isFunction(Reflect.get(cachedMain, 'loop'))
    ) {
        const requireFn = Object.assign(requireModule.bind(runState), {
            cache: { lodash: globals._ } as Record<string, unknown>,
            timestamp: runtimeData.userCodeTimestamp,
        });
        globals.require = requireFn;
    }
}

/** Runs `main.loop()` and queued console commands (upstream `game.run`). */
export function run(): void {
    if (!state) {
        throw new Error('The game API is not initialized');
    }
    const { options, evalHost } = state;
    const { globals, runtimeData } = options;

    const mainExports: unknown = globals.require('main');
    if (isObject(mainExports) && isFunction(Reflect.get(mainExports, 'loop'))) {
        evalCode(
            evalHost,
            {
                exports: mainExports,
                user: runtimeData.user._id,
                timestamp: runtimeData.userCodeTimestamp,
                name: '__mainLoop',
                code: 'module.exports.loop();',
            },
            false,
            options.timeout,
        );
    }

    const commands = runtimeData.consoleCommands;
    for (let i = 0; i < commands.length; i++) {
        const command = commands[i];
        if (!command) {
            continue;
        }
        const result = evalCode(
            evalHost,
            {
                exports: {},
                user: runtimeData.user._id,
                name: '_console' + String(Date.now()) + '_' + String(i),
                code: command.expression,
            },
            true,
        );
        if (!command.hidden) {
            options.console.commandResult(result);
        }
    }
}
