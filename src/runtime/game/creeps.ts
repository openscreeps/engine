/*
 * Creep game object (screeps/engine `src/game/creeps.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import type { BodyPart } from '../../simulation/state.ts';
import {
    calcNeededGcl,
    calcResources,
    capacityForResource,
    deserializePath,
    fetchXYArguments,
    serializePath,
} from '../../utils/index.ts';
import type { SerializablePathStep } from '../../utils/index.ts';
import { clone, cloneDeep, contains, isArray, isBoolean, isObject, isString, isUndefined } from './compat.ts';
import { ConstructionSite } from './construction-sites.ts';
import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import { Deposit } from './deposits.ts';
import { Mineral } from './minerals.ts';
import { PowerCreep } from './power-creeps.ts';
import { Resource } from './resources.ts';
import { RoomObject } from './room-object.ts';
import { RoomPosition } from './room-position.ts';
import type { Room } from './rooms.ts';
import { Ruin } from './ruins.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { memoryRoot, scope, username } from './scope.ts';
import { Source } from './sources.ts';
import { Store } from './store.ts';
import {
    Structure,
    StructureController,
    StructureExtractor,
    StructureRampart,
    StructureSpawn,
} from './structures.ts';
import { Tombstone } from './tombstones.ts';

let controllersClaimedInTick = 0;
let exposed = false;

function _getActiveBodyparts(body: readonly BodyPart[], type: unknown): number {
    let count = 0;
    for (let i = body.length - 1; i >= 0; i--) {
        const part = body[i];
        if (!part || part.hits <= 0) {
            break;
        }
        if (part.type === type) {
            count++;
        }
    }
    return count;
}

function _hasActiveBodypart(body: readonly BodyPart[] | undefined, type: string): boolean {
    if (!body) {
        return true;
    }
    for (let i = body.length - 1; i >= 0; i--) {
        const part = body[i];
        if (!part || part.hits <= 0) {
            break;
        }
        if (part.type === type) {
            return true;
        }
    }
    return false;
}

function data(id: unknown): RawRoomObject {
    if (!id) {
        throw new Error("This creep doesn't exist yet");
    }
    const object = scope().runtimeData.roomObjects[String(id)];
    if (!object) {
        throw new Error('Could not find an object with ID ' + String(id));
    }
    return object;
}

/** Loose JS property read (`value.key`) on an untrusted value; throws like JS on null/undefined. */
function prop(value: unknown, key: string): unknown {
    if (value === null || value === undefined) {
        throw new TypeError(`Cannot read properties of ${String(value)} (reading '${key}')`);
    }
    const holder = Object(value) as object;
    const result: unknown = Reflect.get(holder, key);
    return result;
}

/** Sloppy-mode JS assignment (`value.key = v`): ignored on primitives, throws on null/undefined. */
function setProp(value: unknown, key: string, item: unknown): void {
    if (value === null || value === undefined) {
        throw new TypeError(`Cannot set properties of ${String(value)} (setting '${key}')`);
    }
    if (isObject(value)) {
        Reflect.set(value, key, item);
    }
}

/** Sloppy-mode `delete value.key`. */
function deleteProp(value: unknown, key: string): void {
    if (value === null || value === undefined) {
        throw new TypeError(`Cannot convert undefined or null to object`);
    }
    if (isObject(value)) {
        Reflect.deleteProperty(value, key);
    }
}

/** Numeric value of the JS expression `a + b` where `b` is a number. */
function jsAdd(a: unknown, b: number): number {
    if (a === null || a === undefined || typeof a === 'number' || typeof a === 'boolean') {
        return Number(a) + b;
    }
    return Number(String(a) + String(b));
}

function idOf(target: unknown): unknown {
    return target ? prop(target, 'id') : undefined;
}

function posOf(target: unknown): RoomPosition {
    const pos = prop(target, 'pos');
    if (pos instanceof RoomPosition) {
        return pos;
    }
    if (pos === null || pos === undefined) {
        throw new TypeError(`Cannot read properties of ${String(pos)} (reading 'isNearTo')`);
    }
    throw new TypeError('target.pos.isNearTo is not a function');
}

function roomOf(creep: Creep, key: string): Room {
    const room = creep.room;
    if (!room) {
        throw new TypeError(`Cannot read properties of undefined (reading '${key}')`);
    }
    return room;
}

function controllerOf(creep: Creep): StructureController | undefined {
    return roomOf(creep, 'controller').controller;
}

/** `this.room.controller && !this.room.controller.my && this.room.controller.safeMode` */
function hostileSafeMode(creep: Creep): boolean {
    const controller = controllerOf(creep);
    return !!(controller && !controller.my && controller.safeMode);
}

/** `raw.store[resourceType]` without a store guard (throws like JS when the store is missing). */
function storeAmount(raw: RawRoomObject, resourceType: string): number | undefined {
    const store = raw.store;
    if (!store) {
        throw new TypeError(`Cannot read properties of undefined (reading '${resourceType}')`);
    }
    return store[resourceType];
}

/** `_.find(effects, fn)` on a value read from an untrusted target. */
function findEffect(effects: unknown, predicate: (effect: unknown) => boolean): unknown {
    if (!isArray(effects)) {
        return undefined;
    }
    return effects.find(predicate);
}

function blockingEffect(effect: unknown): boolean {
    return (
        (prop(effect, 'power') == C.PWR_FORTIFY || prop(effect, 'effect') == C.EFFECT_INVULNERABILITY) &&
        Number(prop(effect, 'ticksRemaining')) > 0
    );
}

export class Creep extends RoomObject {
    declare id: string;
    declare readonly name: string;
    declare readonly body: BodyPart[];
    declare readonly my: boolean;
    declare readonly owner: { username: string };
    declare readonly spawning: RawRoomObject['spawning'];
    declare readonly ticksToLive: number | undefined;
    declare readonly carryCapacity: number | null | undefined;
    declare readonly carry: Store;
    declare readonly store: Store;
    declare readonly fatigue: number | undefined;
    declare readonly hits: number | undefined;
    declare readonly hitsMax: number | undefined;
    declare readonly saying: string | undefined;
    declare memory: unknown;

    constructor(id?: string) {
        if (id) {
            const o = data(id);
            super(o.x, o.y, o.room, o.effects);
            this.id = id;
        } else {
            super();
        }
    }

    override toString(): string {
        return `[creep ${this.name}]`;
    }

    move(target: unknown): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }

        if (target && target instanceof Creep) {
            if (!target.pos.isNearTo(this.pos)) {
                return C.ERR_NOT_IN_RANGE;
            }

            scope().intents.set(this.id, 'move', { id: target.id });
            return C.OK;
        }

        if ((data(this.id).fatigue ?? 0) > 0) {
            return C.ERR_TIRED;
        }
        if (!_hasActiveBodypart(this.body, C.MOVE)) {
            return C.ERR_NO_BODYPART;
        }
        const direction = Number(target);
        if (!direction || direction < 1 || direction > 8) {
            return C.ERR_INVALID_ARGS;
        }
        scope().intents.set(this.id, 'move', { direction });
        return C.OK;
    }

    moveTo(firstArg: unknown, secondArg?: unknown, optsArg?: unknown): number {
        const { runtimeData } = scope();
        let visualized = false;
        let opts: unknown = optsArg;

        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (isObject(firstArg)) {
            opts = clone(secondArg);
        }
        opts = opts || {};

        if ((data(this.id).fatigue ?? 0) > 0 && (!opts || !prop(opts, 'visualizePathStyle'))) {
            return C.ERR_TIRED;
        }
        if (!_hasActiveBodypart(this.body, C.MOVE)) {
            return C.ERR_NO_BODYPART;
        }

        const xyr = fetchXYArguments(firstArg, secondArg, RoomPosition);
        const x = xyr[0];
        const y = xyr[1];
        const roomName = xyr[2] || this.pos.roomName;
        if (isUndefined(x) || isUndefined(y)) {
            scope().register.assertTargetObject(firstArg);
            return C.ERR_INVALID_TARGET;
        }

        const targetPos = new RoomPosition(x, y, roomName);

        if (isUndefined(prop(opts, 'reusePath'))) {
            setProp(opts, 'reusePath', 5);
        }
        if (isUndefined(prop(opts, 'serializeMemory'))) {
            setProp(opts, 'serializeMemory', true);
        }

        const style = prop(opts, 'visualizePathStyle');
        if (style) {
            const defaults: Record<string, unknown> = {
                fill: 'transparent',
                stroke: '#fff',
                lineStyle: 'dashed',
                strokeWidth: 0.15,
                opacity: 0.1,
            };
            if (isObject(style)) {
                for (const [key, value] of Object.entries(defaults)) {
                    if (Reflect.get(style, key) === undefined) {
                        Reflect.set(style, key, value);
                    }
                }
            }
        }

        if (x == this.pos.x && y == this.pos.y && roomName == this.pos.roomName) {
            return C.OK;
        }

        if (prop(opts, 'reusePath') && this.memory && isObject(this.memory) && prop(this.memory, '_move')) {
            const _move = prop(this.memory, '_move');

            if (
                runtimeData.time > jsAdd(prop(_move, 'time'), parseInt(String(prop(opts, 'reusePath')))) ||
                prop(_move, 'room') != this.pos.roomName
            ) {
                deleteProp(this.memory, '_move');
            } else if (
                prop(prop(_move, 'dest'), 'room') == roomName &&
                prop(prop(_move, 'dest'), 'x') == x &&
                prop(prop(_move, 'dest'), 'y') == y
            ) {
                const storedPath = prop(_move, 'path');
                const path: unknown = isString(storedPath) ? deserializePath(storedPath) : storedPath;

                const posX = this.pos.x;
                const posY = this.pos.y;
                const idx = isArray(path)
                    ? path.findIndex(
                          (i) => i !== null && i !== undefined && prop(i, 'x') === posX && prop(i, 'y') === posY,
                      )
                    : -1;
                if (idx != -1 && isArray(path)) {
                    const oldMove = cloneDeep(_move);
                    path.splice(0, idx + 1);
                    try {
                        // Boundary: steps stored in Memory are serialized as-is, exactly like upstream.
                        setProp(
                            _move,
                            'path',
                            prop(opts, 'serializeMemory') ? serializePath(path as SerializablePathStep[]) : path,
                        );
                    } catch (e) {
                        scope().globals.console.log(
                            '$ERR',
                            this.pos,
                            x,
                            y,
                            roomName,
                            JSON.stringify(path),
                            '-----',
                            JSON.stringify(oldMove),
                        );
                        throw e;
                    }
                }
                if (prop(path, 'length') == 0) {
                    return this.pos.isNearTo(targetPos) ? C.OK : C.ERR_NO_PATH;
                }
                const pathStyle = prop(opts, 'visualizePathStyle');
                if (pathStyle) {
                    roomOf(this, 'visual').visual.poly(path, pathStyle);
                    visualized = true;
                }
                const result = this.moveByPath(path);

                if (result == C.OK) {
                    return C.OK;
                }
            }
        }

        if (prop(opts, 'noPathFinding')) {
            return C.ERR_NOT_FOUND;
        }

        const path = this.pos.findPathTo(targetPos, opts);

        if (prop(opts, 'reusePath') && this.memory && isObject(this.memory)) {
            setProp(this.memory, '_move', {
                dest: { x, y, room: roomName },
                time: runtimeData.time,
                path: prop(opts, 'serializeMemory')
                    ? serializePath(isString(path) ? throwNotArray() : path)
                    : clone(path),
                room: this.pos.roomName,
            });
        }

        if (path.length == 0) {
            return C.ERR_NO_PATH;
        }

        const pathStyle = prop(opts, 'visualizePathStyle');
        if (pathStyle && !visualized) {
            roomOf(this, 'visual').visual.poly(path, pathStyle);
        }

        return this.move(prop(path[0], 'direction'));
    }

    moveByPath(pathArg: unknown): number {
        let path: unknown = pathArg;
        if (isArray(path) && path.length > 0 && path[0] instanceof RoomPosition) {
            const firstStep = path[0];
            let idx = path.findIndex((i) => {
                if (!(i instanceof RoomPosition)) {
                    throw new TypeError('i.isEqualTo is not a function');
                }
                return i.isEqualTo(this.pos);
            });
            if (idx === -1) {
                if (!firstStep.isNearTo(this.pos)) {
                    return C.ERR_NOT_FOUND;
                }
            }
            idx++;
            if (idx >= path.length) {
                return C.ERR_NOT_FOUND;
            }

            return this.move(this.pos.getDirectionTo(path[idx]));
        }

        if (isString(path)) {
            path = deserializePath(path);
        }
        if (!isArray(path)) {
            return C.ERR_INVALID_ARGS;
        }
        const posX = this.pos.x;
        const posY = this.pos.y;
        const cur: unknown = path.find(
            (i) =>
                Number(prop(i, 'x')) - Number(prop(i, 'dx')) == posX &&
                Number(prop(i, 'y')) - Number(prop(i, 'dy')) == posY,
        );
        if (!cur) {
            return C.ERR_NOT_FOUND;
        }

        return this.move(prop(cur, 'direction'));
    }

    harvest(target: unknown): number {
        const { register, runtimeData, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.WORK)) {
            return C.ERR_NO_BODYPART;
        }
        const id = idOf(target);
        if (!target || !id) {
            return C.ERR_INVALID_TARGET;
        }
        const key = String(id);

        if (register.sources[key] && target instanceof Source) {
            if (!target.energy) {
                return C.ERR_NOT_ENOUGH_RESOURCES;
            }
            if (!target.pos.isNearTo(this.pos)) {
                return C.ERR_NOT_IN_RANGE;
            }
            const controller = controllerOf(this);
            if (
                controller &&
                ((controller.owner && controller.owner.username != runtimeData.user.username) ||
                    (controller.reservation && controller.reservation.username != runtimeData.user.username))
            ) {
                return C.ERR_NOT_OWNER;
            }
        } else if (register.minerals[key] && target instanceof Mineral) {
            if (!target.mineralAmount) {
                return C.ERR_NOT_ENOUGH_RESOURCES;
            }
            if (!target.pos.isNearTo(this.pos)) {
                return C.ERR_NOT_IN_RANGE;
            }
            const lookResult = target.pos.lookFor('structure');
            const found: readonly unknown[] = isArray(lookResult) ? lookResult : [];
            const extractor = found.find(
                (i): i is StructureExtractor =>
                    i instanceof StructureExtractor && i.structureType === C.STRUCTURE_EXTRACTOR,
            );
            if (!extractor) {
                return C.ERR_NOT_FOUND;
            }
            if (extractor.owner && !extractor.my) {
                return C.ERR_NOT_OWNER;
            }
            if (!extractor.isActive()) {
                return C.ERR_RCL_NOT_ENOUGH;
            }
            if (extractor.cooldown) {
                return C.ERR_TIRED;
            }
        } else if (register.deposits[key] && target instanceof Deposit) {
            if (!target.pos.isNearTo(this.pos)) {
                return C.ERR_NOT_IN_RANGE;
            }
            if (target.cooldown) {
                return C.ERR_TIRED;
            }
        } else {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }

        intents.set(this.id, 'harvest', { id: target.id });
        return C.OK;
    }

    drop(resourceType: unknown, amountArg?: unknown): number {
        let amount = amountArg;
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!contains(C.RESOURCES_ALL, resourceType) || !isString(resourceType)) {
            return C.ERR_INVALID_ARGS;
        }
        const own = data(this.id);
        if (!own.store || !own.store[resourceType]) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        if (!amount) {
            amount = own.store[resourceType];
        }
        if ((own.store[resourceType] ?? 0) < Number(amount)) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }

        scope().intents.set(this.id, 'drop', { amount, resourceType });
        return C.OK;
    }

    transfer(target: unknown, resourceType: unknown, amountArg?: unknown): number {
        const { register, intents } = scope();
        let amount = amountArg;
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (Number(amount) < 0) {
            return C.ERR_INVALID_ARGS;
        }
        if (!contains(C.RESOURCES_ALL, resourceType) || !isString(resourceType)) {
            return C.ERR_INVALID_ARGS;
        }
        const id = idOf(target);
        const key = String(id);
        if (
            !target ||
            !id ||
            (!register.spawns[key] &&
                !register.powerCreeps[key] &&
                !register.creeps[key] &&
                !register.structures[key] &&
                !register.customObjects[key]) ||
            (!data(id).store && structureTypeOf(register.structures[key]) != 'controller') ||
            (target instanceof Creep && target.spawning) ||
            (!(target instanceof StructureSpawn) &&
                !(target instanceof Structure) &&
                !(target instanceof Creep) &&
                !(target instanceof PowerCreep) &&
                !register.customObjects[key])
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }

        const structure = register.structures[key];
        if (resourceType == C.RESOURCE_ENERGY && structure && structure.structureType == 'controller') {
            return this.upgradeController(target);
        }

        if (!capacityForResource(data(id), resourceType)) {
            return C.ERR_INVALID_TARGET;
        }

        if (!posOf(target).isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        const own = data(this.id);
        if (!own.store || !own.store[resourceType]) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        const ownAmount = own.store[resourceType] ?? 0;

        const targetData = data(id);
        const storedAmount = targetData.storeCapacityResource
            ? storeAmount(targetData, resourceType) || 0
            : calcResources(Object(target) as object);
        const targetCapacity = capacityForResource(data(id), resourceType);

        if (!data(id).store || storedAmount >= targetCapacity) {
            return C.ERR_FULL;
        }

        if (!amount) {
            amount = Math.min(ownAmount, targetCapacity - storedAmount);
        }

        if (ownAmount < Number(amount)) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }

        if (jsAdd(amount, storedAmount) > targetCapacity) {
            return C.ERR_FULL;
        }

        intents.set(this.id, 'transfer', { id, amount, resourceType });
        return C.OK;
    }

    withdraw(target: unknown, resourceType: unknown, amountArg?: unknown): number {
        const { register, intents } = scope();
        let amount = amountArg;
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (Number(amount) < 0) {
            return C.ERR_INVALID_ARGS;
        }
        if (!contains(C.RESOURCES_ALL, resourceType) || !isString(resourceType)) {
            return C.ERR_INVALID_ARGS;
        }

        const id = idOf(target);
        const key = String(id);
        if (
            !target ||
            !id ||
            !data(id).store ||
            ((!register.structures[key] || !(target instanceof Structure)) &&
                !(target instanceof Tombstone) &&
                !(target instanceof Ruin) &&
                !register.customObjects[key])
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }

        if (prop(target, 'structureType') == 'terminal') {
            const effect = findEffect(prop(target, 'effects'), (e) => prop(e, 'power') === C.PWR_DISRUPT_TERMINAL);
            if (effect && Number(prop(effect, 'ticksRemaining')) > 0) {
                return C.ERR_INVALID_TARGET;
            }
        }

        if (prop(target, 'my') === false) {
            const lookResult = posOf(target).lookFor('structure');
            const found: readonly unknown[] = isArray(lookResult) ? lookResult : [];
            if (
                found.some(
                    (i) =>
                        i instanceof StructureRampart &&
                        i.structureType == C.STRUCTURE_RAMPART &&
                        !i.my &&
                        !i.isPublic,
                )
            ) {
                return C.ERR_NOT_OWNER;
            }
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NOT_OWNER;
        }

        const structure = register.structures[key];
        if (
            structure &&
            (structure.structureType == C.STRUCTURE_NUKER || structure.structureType == C.STRUCTURE_POWER_BANK)
        ) {
            return C.ERR_INVALID_TARGET;
        }

        if (
            !capacityForResource(data(id), resourceType) &&
            !storeAmount(data(id), resourceType) &&
            !(target instanceof Tombstone)
        ) {
            return C.ERR_INVALID_TARGET;
        }

        if (!posOf(target).isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }

        const own = data(this.id);
        const emptySpace = Number(own.storeCapacity) - calcResources(own);

        if (emptySpace <= 0) {
            return C.ERR_FULL;
        }

        if (!amount) {
            amount = Math.min(emptySpace, Number(storeAmount(data(id), resourceType)));
        }

        if (Number(amount) > emptySpace) {
            return C.ERR_FULL;
        }

        if (!amount || (storeAmount(data(id), resourceType) || 0) < Number(amount)) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }

        intents.set(this.id, 'withdraw', { id, amount, resourceType });
        return C.OK;
    }

    pickup(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        const id = idOf(target);
        if (!target || !id || !register.energy[String(id)] || !(target instanceof Resource)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        const own = data(this.id);
        if (calcResources(own) >= Number(own.storeCapacity)) {
            return C.ERR_FULL;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }

        intents.set(this.id, 'pickup', { id: target.id });
        return C.OK;
    }

    getActiveBodyparts(type: unknown): number {
        return _getActiveBodyparts(this.body, type);
    }

    attack(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.ATTACK)) {
            return C.ERR_NO_BODYPART;
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NO_BODYPART;
        }
        const id = idOf(target);
        const key = String(id);
        if (
            !target ||
            !id ||
            (!register.creeps[key] && !register.powerCreeps[key] && !register.structures[key]) ||
            (!(target instanceof Creep) &&
                !(target instanceof PowerCreep) &&
                !(target instanceof StructureSpawn) &&
                !(target instanceof Structure))
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }

        if (findEffect(target.effects, blockingEffect)) {
            return C.ERR_INVALID_TARGET;
        }

        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }

        intents.set(this.id, 'attack', { id: target.id, x: target.pos.x, y: target.pos.y });
        return C.OK;
    }

    rangedAttack(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.RANGED_ATTACK)) {
            return C.ERR_NO_BODYPART;
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NO_BODYPART;
        }
        const id = idOf(target);
        const key = String(id);
        if (
            !target ||
            !id ||
            (!register.creeps[key] && !register.powerCreeps[key] && !register.structures[key]) ||
            (!(target instanceof Creep) &&
                !(target instanceof PowerCreep) &&
                !(target instanceof StructureSpawn) &&
                !(target instanceof Structure))
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!this.pos.inRangeTo(target, 3)) {
            return C.ERR_NOT_IN_RANGE;
        }

        if (findEffect(target.effects, blockingEffect)) {
            return C.ERR_INVALID_TARGET;
        }

        intents.set(this.id, 'rangedAttack', { id: target.id });
        return C.OK;
    }

    rangedMassAttack(): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.RANGED_ATTACK)) {
            return C.ERR_NO_BODYPART;
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NO_BODYPART;
        }

        scope().intents.set(this.id, 'rangedMassAttack', {});
        return C.OK;
    }

    heal(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.HEAL)) {
            return C.ERR_NO_BODYPART;
        }
        const id = idOf(target);
        const key = String(id);
        if (
            !target ||
            !id ||
            (!register.creeps[key] && !register.powerCreeps[key]) ||
            (!(target instanceof Creep) && !(target instanceof PowerCreep))
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NO_BODYPART;
        }

        intents.set(this.id, 'heal', { id: target.id, x: target.pos.x, y: target.pos.y });
        return C.OK;
    }

    rangedHeal(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.HEAL)) {
            return C.ERR_NO_BODYPART;
        }
        const id = idOf(target);
        const key = String(id);
        if (
            !target ||
            !id ||
            (!register.creeps[key] && !register.powerCreeps[key]) ||
            (!(target instanceof Creep) && !(target instanceof PowerCreep))
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NO_BODYPART;
        }
        if (!this.pos.inRangeTo(target, 3)) {
            return C.ERR_NOT_IN_RANGE;
        }

        intents.set(this.id, 'rangedHeal', { id: target.id });
        return C.OK;
    }

    repair(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.WORK)) {
            return C.ERR_NO_BODYPART;
        }
        if (!prop(this.carry, C.RESOURCE_ENERGY)) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        const id = idOf(target);
        if (
            !target ||
            !id ||
            !register.structures[String(id)] ||
            (!(target instanceof Structure) && !(target instanceof StructureSpawn))
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!this.pos.inRangeTo(target, 3)) {
            return C.ERR_NOT_IN_RANGE;
        }

        intents.set(this.id, 'repair', { id: target.id, x: target.pos.x, y: target.pos.y });
        return C.OK;
    }

    build(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.WORK)) {
            return C.ERR_NO_BODYPART;
        }
        if (!prop(this.carry, C.RESOURCE_ENERGY)) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        const id = idOf(target);
        if (!target || !id || !register.constructionSites[String(id)] || !(target instanceof ConstructionSite)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!this.pos.inRangeTo(target, 3)) {
            return C.ERR_NOT_IN_RANGE;
        }

        const own = data(this.id);
        const objects = register.objectsByRoom[own.room];
        const objectsInTile: RawRoomObject[] = [];
        const creepsInTile: RawRoomObject[] = [];
        const myCreepsInTile: RawRoomObject[] = [];
        const userId = own.user;
        if (objects) {
            for (const obj of Object.values(objects)) {
                if (
                    obj.x == target.pos.x &&
                    obj.y == target.pos.y &&
                    contains(C.OBSTACLE_OBJECT_TYPES, obj.type)
                ) {
                    if (obj.type == 'creep') {
                        creepsInTile.push(obj);
                        if (obj.user == userId) {
                            myCreepsInTile.push(obj);
                        }
                    } else {
                        objectsInTile.push(obj);
                    }
                }
            }
        }
        if (contains(C.OBSTACLE_OBJECT_TYPES, target.structureType)) {
            if (objectsInTile.length > 0) {
                return C.ERR_INVALID_TARGET;
            }
            const controller = controllerOf(this);
            const blockingCreeps =
                controller && controller.my && controller.safeMode ? myCreepsInTile : creepsInTile;
            if (blockingCreeps.length > 0) {
                return C.ERR_INVALID_TARGET;
            }
        }

        intents.set(this.id, 'build', { id: target.id, x: target.pos.x, y: target.pos.y });
        return C.OK;
    }

    suicide(): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }

        scope().intents.set(this.id, 'suicide', {});
        return C.OK;
    }

    say(message: unknown, isPublic?: unknown): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }

        scope().intents.set(this.id, 'say', { message: String(message), isPublic });
        return C.OK;
    }

    claimController(target: unknown): number {
        const { register, runtimeData, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }

        const controllersClaimed = runtimeData.user.rooms.length + controllersClaimedInTick;
        if (
            controllersClaimed &&
            (!runtimeData.user.gcl || runtimeData.user.gcl < calcNeededGcl(controllersClaimed + 1))
        ) {
            return C.ERR_GCL_NOT_ENOUGH;
        }
        if (
            controllersClaimed >= C.GCL_NOVICE &&
            Number(prop(runtimeData.rooms[data(this.id).room], 'novice')) > Date.now()
        ) {
            return C.ERR_FULL;
        }
        const id = idOf(target);
        if (!target || !id || !register.structures[String(id)] || !(target instanceof Structure)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!_hasActiveBodypart(this.body, C.CLAIM)) {
            return C.ERR_NO_BODYPART;
        }
        if (runtimeData.user.shardAccess === false) {
            return C.ERR_ACCESS_DENIED;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        if (target.structureType != 'controller') {
            return C.ERR_INVALID_TARGET;
        }
        if (Number(prop(target, 'level')) > 0) {
            return C.ERR_INVALID_TARGET;
        }
        const reservation = prop(target, 'reservation');
        if (reservation && prop(reservation, 'username') != runtimeData.user.username) {
            return C.ERR_INVALID_TARGET;
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NO_BODYPART;
        }

        controllersClaimedInTick++;

        intents.set(this.id, 'claimController', { id: target.id });
        return C.OK;
    }

    attackController(target: unknown): number {
        const { register, runtimeData, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        const id = idOf(target);
        if (!target || !id || !register.structures[String(id)] || !(target instanceof StructureController)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!_getActiveBodyparts(this.body, C.CLAIM)) {
            return C.ERR_NO_BODYPART;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        if (!target.owner && !target.reservation) {
            return C.ERR_INVALID_TARGET;
        }
        if (Number(data(target.id).upgradeBlocked) > runtimeData.time) {
            return C.ERR_TIRED;
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NO_BODYPART;
        }
        if (
            isArray(target.effects) &&
            target.effects.some((e) => e.effect == C.EFFECT_INVULNERABILITY && e.ticksRemaining > 0)
        ) {
            return C.ERR_INVALID_TARGET;
        }

        intents.set(this.id, 'attackController', { id: target.id });
        return C.OK;
    }

    upgradeController(target: unknown): number {
        const { register, runtimeData, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.WORK)) {
            return C.ERR_NO_BODYPART;
        }
        if (runtimeData.user.shardAccess === false) {
            return C.ERR_ACCESS_DENIED;
        }
        if (!prop(this.carry, C.RESOURCE_ENERGY)) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        const id = idOf(target);
        if (!target || !id || !register.structures[String(id)] || !(target instanceof StructureController)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (target.upgradeBlocked && target.upgradeBlocked > 0) {
            return C.ERR_INVALID_TARGET;
        }
        if (!target.pos.inRangeTo(this.pos, 3)) {
            return C.ERR_NOT_IN_RANGE;
        }
        if (!target.my) {
            return C.ERR_NOT_OWNER;
        }
        if (!target.level || !target.owner) {
            return C.ERR_INVALID_TARGET;
        }

        intents.set(this.id, 'upgradeController', { id: target.id });
        return C.OK;
    }

    reserveController(target: unknown): number {
        const { register, runtimeData, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        const id = idOf(target);
        if (!target || !id || !register.structures[String(id)] || !(target instanceof Structure)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        if (target.structureType != 'controller') {
            return C.ERR_INVALID_TARGET;
        }
        if (prop(target, 'owner')) {
            return C.ERR_INVALID_TARGET;
        }
        const reservation = prop(target, 'reservation');
        if (reservation && prop(reservation, 'username') != runtimeData.user.username) {
            return C.ERR_INVALID_TARGET;
        }
        if (!_hasActiveBodypart(this.body, C.CLAIM)) {
            return C.ERR_NO_BODYPART;
        }
        if (runtimeData.user.shardAccess === false) {
            return C.ERR_ACCESS_DENIED;
        }

        intents.set(this.id, 'reserveController', { id: target.id });
        return C.OK;
    }

    notifyWhenAttacked(enabled: unknown): number {
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!isBoolean(enabled)) {
            return C.ERR_INVALID_ARGS;
        }

        if (enabled != data(this.id).notifyWhenAttacked) {
            scope().intents.set(this.id, 'notifyWhenAttacked', { enabled });
        }

        return C.OK;
    }

    cancelOrder(name: unknown): number {
        if (scope().intents.remove(this.id, String(name))) {
            return C.OK;
        }
        return C.ERR_NOT_FOUND;
    }

    dismantle(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        if (!_hasActiveBodypart(this.body, C.WORK)) {
            return C.ERR_NO_BODYPART;
        }
        const id = idOf(target);
        if (
            !target ||
            !id ||
            !register.structures[String(id)] ||
            (!(target instanceof Structure) && !(target instanceof StructureSpawn)) ||
            !(Reflect.get(C.CONSTRUCTION_COST, target.structureType) as unknown)
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        if (hostileSafeMode(this)) {
            return C.ERR_NO_BODYPART;
        }

        if (findEffect(target.effects, blockingEffect)) {
            return C.ERR_INVALID_TARGET;
        }

        intents.set(this.id, 'dismantle', { id: target.id });
        return C.OK;
    }

    generateSafeMode(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }
        if (this.spawning) {
            return C.ERR_BUSY;
        }
        const own = data(this.id);
        if (!own.store || !((own.store[C.RESOURCE_GHODIUM] ?? NaN) >= C.SAFE_MODE_COST)) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        const id = idOf(target);
        if (!target || !id || !register.structures[String(id)] || !(target instanceof StructureController)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }

        intents.set(this.id, 'generateSafeMode', { id: target.id });
        return C.OK;
    }

    signController(target: unknown, sign: unknown): number {
        const { register, intents } = scope();
        if (this.spawning) {
            return C.ERR_BUSY;
        }

        const id = idOf(target);
        if (!target || !id || !register.structures[String(id)] || !(target instanceof Structure)) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }
        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }
        if (target.structureType != 'controller') {
            return C.ERR_INVALID_TARGET;
        }

        intents.set(this.id, 'signController', { id: target.id, sign: String(sign) });
        return C.OK;
    }

    pull(target: unknown): number {
        const { register, intents } = scope();
        if (!this.my) {
            return C.ERR_NOT_OWNER;
        }

        if (this.spawning) {
            return C.ERR_BUSY;
        }

        const id = idOf(target);
        if (
            !target ||
            !id ||
            !register.creeps[String(id)] ||
            !(target instanceof Creep) ||
            target.spawning ||
            target.id == this.id
        ) {
            register.assertTargetObject(target);
            return C.ERR_INVALID_TARGET;
        }

        if (!target.pos.isNearTo(this.pos)) {
            return C.ERR_NOT_IN_RANGE;
        }

        intents.set(this.id, 'pull', { id: target.id });
        return C.OK;
    }
}

/** `serializePath` on a serialized (string) path, as upstream reaches it with `opts.serialize`. */
function throwNotArray(): never {
    throw new Error('path is not an array');
}

/** `register.structures[id].structureType` (throws like JS when the structure is not registered). */
function structureTypeOf(structure: Structure | undefined): unknown {
    if (!structure) {
        throw new TypeError(`Cannot read properties of undefined (reading 'structureType')`);
    }
    return structure.structureType;
}

finalizeClass(Creep);

defineGameObjectProperties(Creep.prototype, data, {
    // Boundary: creep documents always carry `name` and `body`; returned verbatim like upstream.
    name: (o) => o.name as string,
    body: (o) => o.body as BodyPart[],
    my: (o) => o.user == scope().runtimeData.user._id,
    owner: (o) => ({ username: username(String(o.user)) }),
    spawning: (o) => o.spawning,
    ticksToLive: (o) => (o.ageTime ? o.ageTime - scope().runtimeData.time : undefined),
    carryCapacity: (o) => o.storeCapacity,
    carry: (o) => new Store(o),
    store: (o) => new Store(o),
    fatigue: (o) => o.fatigue,
    hits: (o) => o.hits,
    hitsMax: (o) => o.hitsMax,
    saying: (o) => {
        const say = o.actionLog?.say;
        if (!o.actionLog || !say) {
            return undefined;
        }
        if (o.user == scope().runtimeData.user._id) {
            return say.message;
        }
        return say.isPublic ? say.message : undefined;
    },
});

function creepsMemory(): Record<string, unknown> {
    const memory = memoryRoot();
    if (isUndefined(memory.creeps) || memory.creeps === 'undefined') {
        memory.creeps = {};
    }
    const creeps = memory.creeps;
    return isObject(creeps) ? (creeps as Record<string, unknown>) : NOT_OBJECT;
}

/** Sentinel for a non-object `Memory.creeps`. */
const NOT_OBJECT: Record<string, unknown> = Object.freeze({});

Object.defineProperty(Creep.prototype, 'memory', {
    get(this: Creep): unknown {
        if (this.id && !this.my) {
            return undefined;
        }
        const creeps = creepsMemory();
        if (creeps === NOT_OBJECT) {
            return undefined;
        }
        const name = String(this.name);
        return (creeps[name] = creeps[name] || {});
    },
    set(this: Creep, value: unknown): void {
        if (this.id && !this.my) {
            throw new Error("Could not set other player's creep memory");
        }
        const creeps = creepsMemory();
        if (creeps === NOT_OBJECT) {
            throw new Error('Could not set creep memory');
        }
        creeps[String(this.name)] = value;
    },
});

export function make(): void {
    controllersClaimedInTick = 0;
    if (exposed) {
        return;
    }
    exposed = true;
    exposeGlobal('Creep', Creep);
}
