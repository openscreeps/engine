/*
 * PowerCreep (screeps/engine `src/game/power-creeps.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import type { PowerCreepPowerInfo } from '../../simulation/state.ts';
import { checkStructureAgainstController } from '../../utils/index.ts';
import { isArray, isBoolean, isObject, isString, isUndefined } from './compat.ts';
import { Creep } from './creeps.ts';
import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import { RoomObject } from './room-object.ts';
import type { RoomObjectEffect } from './room-object.ts';
import type { PowerCreepDoc, RawRoomObject } from './runtime-data.ts';
import { memoryRoot, rawObject, scope, username } from './scope.ts';
import { Store } from './store.ts';
import { Structure, StructurePowerBank, StructurePowerSpawn } from './structures.ts';

/** Upstream `Object.assign({}, userPowerCreeps[id], roomObjects[id])`. */
export type PowerCreepData = Partial<RawRoomObject> & Partial<PowerCreepDoc>;

interface PowerInfoEntry {
    readonly className: string;
    readonly level: readonly number[];
    readonly range?: number;
    readonly ops?: number | readonly number[];
}

const powerInfoTable: Readonly<Record<string, PowerInfoEntry>> = C.POWER_INFO;

function powerInfoOf(power: unknown): PowerInfoEntry | undefined {
    if (typeof power === 'symbol') {
        return undefined;
    }
    const key = String(power);
    return Object.prototype.hasOwnProperty.call(powerInfoTable, key) ? powerInfoTable[key] : undefined;
}

/** Upstream `data(id).powers[power]` (throws when the data has no powers). */
function ownedPower(id: string | undefined, power: unknown): PowerCreepPowerInfo | undefined {
    const powers = data(id).powers;
    if (!powers) {
        throw new TypeError(`Cannot read properties of undefined (reading '${String(power)}')`);
    }
    if (typeof power === 'symbol') {
        return undefined;
    }
    const key = String(power);
    return Object.prototype.hasOwnProperty.call(powers, key) ? powers[key] : undefined;
}

function calcFreePowerLevels(): number {
    const { runtimeData } = scope();
    const level = Math.floor(Math.pow((runtimeData.user.power || 0) / C.POWER_LEVEL_MULTIPLY, 1 / C.POWER_LEVEL_POW));
    const creeps = Object.values(runtimeData.userPowerCreeps);
    const used = creeps.length + creeps.reduce((result, creep) => result + creep.level, 0);
    return level - used;
}

function data(id: string | undefined): PowerCreepData {
    const { runtimeData } = scope();
    return Object.assign(
        {},
        id === undefined ? undefined : runtimeData.userPowerCreeps[id],
        id === undefined ? undefined : runtimeData.roomObjects[id],
    );
}

/** Upstream `data(structure.id)` for room objects: a shallow copy of the raw object. */
function structureData(id: string): RawRoomObject {
    return { ...rawObject(id) };
}

/** Upstream `checkStructureAgainstController(data(s.id), objectsByRoom[data(s.id).room], data(s.room.controller.id))`. */
function structureActive(structure: Structure): boolean {
    const object = structureData(structure.id);
    const room = structure.room;
    if (!room) {
        throw new TypeError("Cannot read properties of undefined (reading 'controller')");
    }
    const controller = room.controller;
    if (!controller) {
        throw new TypeError("Cannot read properties of undefined (reading 'id')");
    }
    return checkStructureAgainstController(
        object,
        scope().register.objectsByRoom[object.room] ?? {},
        structureData(controller.id),
    );
}

/** The power creep as the receiver of a borrowed `Creep.prototype` method. */
function asCreep(powerCreep: PowerCreep): Creep {
    // Boundary: upstream invokes Creep methods with a PowerCreep receiver (`.call(this, …)`).
    return powerCreep as unknown as Creep;
}

function targetId(target: unknown): unknown {
    return isObject(target) ? Reflect.get(target, 'id') : undefined;
}

function ensurePowerCreepsMemory(memory: Record<string, unknown>): void {
    if (isUndefined(memory.powerCreeps) || memory.powerCreeps === 'undefined') {
        memory.powerCreeps = {};
    }
}

export class PowerCreep extends RoomObject {
    declare id: string;
    declare readonly name: string;
    declare readonly my: boolean;
    declare readonly owner: { username: string };
    declare readonly level: number;
    declare readonly className: string;
    declare readonly hitsMax: number;
    declare readonly hits: number | undefined;
    declare readonly shard: string | undefined;
    declare readonly spawnCooldownTime: number | undefined;
    declare readonly deleteTime: number | undefined;
    declare readonly powers: Record<string, { level: number; cooldown: number }>;
    declare readonly saying: string | undefined;
    declare readonly carry: Store;
    declare readonly store: Store;
    declare readonly carryCapacity: number | null | undefined;
    declare readonly ticksToLive: number;
    declare memory: unknown;

    constructor(id?: string) {
        const creepData = data(id);
        if (creepData.room) {
            super(creepData.x, creepData.y, creepData.room);
        } else {
            super();
        }
        // upstream always assigns the own `id` property, even when undefined
        Reflect.set(this, 'id', id);
    }

    toString(): string {
        return `[powerCreep ${this.name}]`;
    }

    // Creep.prototype methods are applied to the power creep exactly like upstream `.call(this, â€¦)`;
    // the Creep implementations only read members PowerCreep provides.
    move(target: unknown): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        return Creep.prototype.move.call(asCreep(this), target);
    }

    moveTo(
        firstArg: unknown,
        secondArg?: unknown,
        opts?: unknown,
    ): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        return Creep.prototype.moveTo.call(asCreep(this), firstArg, secondArg, opts);
    }

    moveByPath(path: unknown): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        return Creep.prototype.moveByPath.call(asCreep(this), path);
    }

    transfer(
        target: unknown,
        resourceType: unknown,
        amount?: unknown,
    ): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        return Creep.prototype.transfer.call(asCreep(this), target, resourceType, amount);
    }

    withdraw(
        target: unknown,
        resourceType: unknown,
        amount?: unknown,
    ): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        return Creep.prototype.withdraw.call(asCreep(this), target, resourceType, amount);
    }

    drop(
        resourceType: unknown,
        amount?: unknown,
    ): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        return Creep.prototype.drop.call(asCreep(this), resourceType, amount);
    }

    pickup(target: unknown): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        return Creep.prototype.pickup.call(asCreep(this), target);
    }

    say(message: unknown, isPublic?: unknown): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        return Creep.prototype.say.call(asCreep(this), message, isPublic);
    }

    spawn(powerSpawn: unknown): number {
        if (this.room) {
            return C.ERR_BUSY;
        }
        if (!(powerSpawn instanceof StructurePowerSpawn)) {
            return C.ERR_INVALID_TARGET;
        }
        if (!this.my || !powerSpawn.my) {
            return C.ERR_NOT_OWNER;
        }
        if (!structureActive(powerSpawn)) {
            return C.ERR_RCL_NOT_ENOUGH;
        }

        if (this.spawnCooldownTime) {
            return C.ERR_TIRED;
        }

        const memory = memoryRoot();
        if (isUndefined(memory.powerCreeps)) {
            memory.powerCreeps = {};
        }
        const powerCreepsMemory = memory.powerCreeps;
        if (isObject(powerCreepsMemory) && isUndefined(Reflect.get(powerCreepsMemory, this.name))) {
            Reflect.set(powerCreepsMemory, this.name, {});
        }

        scope().intents.pushByName('global', 'spawnPowerCreep', { id: powerSpawn.id, name: this.name }, 50);
        return C.OK;
    }

    suicide(): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }

        scope().intents.pushByName('global', 'suicidePowerCreep', { id: this.id }, 50);
        return C.OK;
    }

    delete(cancel?: unknown): number {
        if (this.room) {
            return C.ERR_BUSY;
        }
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }

        scope().intents.pushByName('global', 'deletePowerCreep', { id: this.id, cancel }, 50);
        return C.OK;
    }

    upgrade(power: unknown): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (calcFreePowerLevels() <= 0) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        if (this.level >= C.POWER_CREEP_MAX_LEVEL) {
            return C.ERR_FULL;
        }
        const powerInfo = powerInfoOf(power);
        if (!powerInfo || powerInfo.className !== this.className) {
            return C.ERR_INVALID_ARGS;
        }
        const powerData = ownedPower(this.id, power);
        const powerLevel = powerData ? powerData.level : 0;
        if (powerLevel == 5) {
            return C.ERR_FULL;
        }

        // upstream compares against `undefined` (false) for out-of-table levels
        const required = powerInfo.level[powerLevel];
        if (required !== undefined && this.level < required) {
            return C.ERR_FULL;
        }

        scope().intents.pushByName('global', 'upgradePowerCreep', { id: this.id, power }, 50);
        return C.OK;
    }

    usePower(power: unknown, target?: unknown): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (!this.room) {
            return C.ERR_BUSY;
        }
        const controller = this.room.controller;
        if (controller) {
            if (!controller.isPowerEnabled) {
                return C.ERR_INVALID_ARGS;
            }
            if (!controller.my && controller.safeMode) {
                return C.ERR_INVALID_ARGS;
            }
        }

        const powerData = ownedPower(this.id, power);
        const powerInfo = powerInfoOf(power);
        if (!powerData || !powerData.level || !powerInfo) {
            return C.ERR_NO_BODYPART;
        }
        const { runtimeData, intents } = scope();
        // upstream `undefined > time` is false
        if (powerData.cooldownTime !== undefined && powerData.cooldownTime > runtimeData.time) {
            return C.ERR_TIRED;
        }
        const opsInfo = powerInfo.ops || 0;
        // upstream indexes past the table end as `undefined`, which never exceeds the stored ops
        const ops = isArray(opsInfo) ? opsInfo[powerData.level - 1] : opsInfo;
        const store = data(this.id).store;
        if (!store) {
            throw new TypeError("Cannot read properties of undefined (reading 'ops')");
        }
        if (ops !== undefined && (store.ops || 0) < ops) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        if (powerInfo.range) {
            if (!target) {
                return C.ERR_INVALID_TARGET;
            }
            if (!this.pos.inRangeTo(target, powerInfo.range)) {
                return C.ERR_NOT_IN_RANGE;
            }
            const effects: unknown = isObject(target) ? Reflect.get(target, 'effects') : undefined;
            const currentEffect = isArray(effects)
                ? effects.find((i): i is RoomObjectEffect => isObject(i) && Reflect.get(i, 'power') == power)
                : undefined;
            if (
                currentEffect &&
                currentEffect.level !== undefined &&
                currentEffect.level > powerData.level &&
                currentEffect.ticksRemaining > 0
            ) {
                return C.ERR_FULL;
            }
        }

        intents.set(this.id, 'usePower', { power, id: target ? targetId(target) : undefined });
        return C.OK;
    }

    enableRoom(target: unknown): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (!this.room) {
            return C.ERR_BUSY;
        }

        const { register, intents } = scope();
        const id = targetId(target);
        if (!target || !id || !register.structures[String(id)] || !(target instanceof Structure)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        if (target.structureType != 'controller' || (Reflect.get(target, 'safeMode') && !Reflect.get(target, 'my'))) {
            return C.ERR_INVALID_TARGET;
        }

        intents.set(this.id, 'enableRoom', { id: target.id });
        return C.OK;
    }

    renew(target: unknown): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (!this.room) {
            return C.ERR_BUSY;
        }

        const { register, intents } = scope();
        const id = targetId(target);
        if (
            !target ||
            !id ||
            !register.structures[String(id)] ||
            (!(target instanceof StructurePowerBank) && !(target instanceof StructurePowerSpawn))
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (target instanceof StructurePowerSpawn && !structureActive(target)) {
            return C.ERR_RCL_NOT_ENOUGH;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        intents.set(this.id, 'renew', { id: target.id });
        return C.OK;
    }

    cancelOrder(name: unknown): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (scope().intents.remove(this.id, String(name))) {
            return C.OK;
        }
        return C.ERR_NOT_FOUND;
    }

    rename(name: unknown): number {
        if (this.room) {
            return C.ERR_BUSY;
        }
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (!name || !isString(name) || name.length > 100) {
            return C.ERR_INVALID_ARGS;
        }
        const { runtimeData, intents } = scope();
        if (Object.values(runtimeData.userPowerCreeps).some((i) => i.name === name)) {
            return C.ERR_NAME_EXISTS;
        }

        intents.pushByName('global', 'renamePowerCreep', { id: this.id, name }, 50);
        return C.OK;
    }

    notifyWhenAttacked(enabled: unknown): number {
        if (!this.room) {
            return C.ERR_BUSY;
        }
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (!isBoolean(enabled)) {
            return C.ERR_INVALID_ARGS;
        }

        if (enabled != data(this.id).notifyWhenAttacked) {
            scope().intents.set(this.id, 'notifyWhenAttacked', { enabled });
        }

        return C.OK;
    }

    static create(name: unknown, className: unknown): number {
        if (!name || !isString(name) || name.length > 100) {
            return C.ERR_INVALID_ARGS;
        }
        if (calcFreePowerLevels() <= 0) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        const { runtimeData, intents } = scope();
        if (Object.values(runtimeData.userPowerCreeps).some((i) => i.name === name)) {
            return C.ERR_NAME_EXISTS;
        }
        if (!(Object.values(C.POWER_CLASS) as unknown[]).includes(className)) {
            return C.ERR_INVALID_ARGS;
        }
        intents.pushByName('global', 'createPowerCreep', { name, className }, 50);
        return C.OK;
    }
}

finalizeClass(PowerCreep);

defineGameObjectProperties<PowerCreep, PowerCreepData>(PowerCreep.prototype, data, {
    // power creep documents always carry these fields; the raw values are returned like upstream
    name: (o) => o.name as string,
    my: (o) => o.user == scope().runtimeData.user._id,
    owner: (o) => ({ username: username(String(o.user)) }),
    level: (o) => o.level as number,
    className: (o) => o.className as string,
    hitsMax: (o) => o.hitsMax as number,
    hits: (o) => o.hits,
    shard: (o) => o.shard || undefined,
    spawnCooldownTime: (o) =>
        o.spawnCooldownTime !== null && o.spawnCooldownTime !== undefined && o.spawnCooldownTime > Date.now()
            ? o.spawnCooldownTime
            : undefined,
    deleteTime: (o) => o.deleteTime || undefined,
    powers: (o) => {
        const { runtimeData } = scope();
        const result: Record<string, { level: number; cooldown: number }> = {};
        for (const [key, i] of Object.entries(o.powers ?? {})) {
            result[key] = { level: i.level, cooldown: Math.max(0, (i.cooldownTime || 0) - runtimeData.time) };
        }
        return result;
    },
    saying: (o) => {
        const say = o.actionLog?.say;
        if (!say) {
            return undefined;
        }
        if (o.user == scope().runtimeData.user._id) {
            return say.message;
        }
        return say.isPublic ? say.message : undefined;
    },
    carry: (o) => new Store(o),
    store: (o) => new Store(o),
    carryCapacity: (o) => o.storeCapacity,
    // upstream `undefined - time` is NaN for power creeps that are not spawned
    ticksToLive: (o) => (o.ageTime ?? NaN) - scope().runtimeData.time,
});

Object.defineProperty(PowerCreep.prototype, 'memory', {
    get(this: PowerCreep): unknown {
        if (this.id && !this.my) {
            return undefined;
        }
        const memory = memoryRoot();
        ensurePowerCreepsMemory(memory);
        const powerCreeps = memory.powerCreeps;
        if (!isObject(powerCreeps)) {
            return undefined;
        }
        const value: unknown = Reflect.get(powerCreeps, this.name) || {};
        Reflect.set(powerCreeps, this.name, value);
        return value;
    },
    set(this: PowerCreep, value: unknown): void {
        if (this.id && !this.my) {
            throw new Error("Could not set other player's creep memory");
        }
        const memory = memoryRoot();
        ensurePowerCreepsMemory(memory);
        const powerCreeps = memory.powerCreeps;
        if (!isObject(powerCreeps)) {
            throw new Error('Could not set creep memory');
        }
        Reflect.set(powerCreeps, this.name, value);
    },
});

export function make(): void {
    if (scope().globals.PowerCreep) {
        return;
    }
    exposeGlobal('PowerCreep', PowerCreep);
}
