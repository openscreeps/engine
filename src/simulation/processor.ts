/*
 * Room processing pass: port of the `processRoom` function of screeps/engine `processor.js`.
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import { calcSpawns } from './intents/calc-spawns.ts';
import { tickConstructedWall } from './intents/constructed-walls/tick.ts';
import { tickConstructionSite } from './intents/construction-sites/tick.ts';
import { tickContainer } from './intents/containers/tick.ts';
import { activateSafeMode } from './intents/controllers/activate-safe-mode.ts';
import { tickController } from './intents/controllers/tick.ts';
import { unclaimController } from './intents/controllers/unclaim.ts';
import { processCreepIntents } from './intents/creeps/intents.ts';
import { invaderPretick } from './intents/creeps/invaders/pretick.ts';
import { keeperPretick } from './intents/creeps/keepers/pretick.ts';
import { tickCreep } from './intents/creeps/tick.ts';
import { tickDeposit } from './intents/deposits/tick.ts';
import { tickEnergy } from './intents/energy/tick.ts';
import { tickExtension } from './intents/extensions/tick.ts';
import { tickExtractor } from './intents/extractors/tick.ts';
import { factoryProduce } from './intents/factories/produce.ts';
import { tickFactory } from './intents/factories/tick.ts';
import { processInvaderCoreIntents } from './intents/invader-core/intents.ts';
import { invaderCorePretick } from './intents/invader-core/pretick.ts';
import { tickInvaderCore } from './intents/invader-core/tick.ts';
import { tickKeeperLair } from './intents/keeper-lairs/tick.ts';
import { processLabIntents } from './intents/labs/intents.ts';
import { tickLab } from './intents/labs/tick.ts';
import { processLinkIntents } from './intents/links/intents.ts';
import { tickLink } from './intents/links/tick.ts';
import { tickMineral } from './intents/minerals/tick.ts';
import { launchNuke } from './intents/nukers/launch-nuke.ts';
import { nukePretick } from './intents/nukes/pretick.ts';
import { tickNuke } from './intents/nukes/tick.ts';
import { tickPortal } from './intents/portals/tick.ts';
import { processPowerCreepIntents } from './intents/power-creeps/intents.ts';
import { tickPowerCreep } from './intents/power-creeps/tick.ts';
import { processPowerSpawnIntents } from './intents/power-spawns/intents.ts';
import { setRampartPublic } from './intents/ramparts/set-public.ts';
import { tickRampart } from './intents/ramparts/tick.ts';
import { tickRoad } from './intents/roads/tick.ts';
import { processRoomIntents } from './intents/room/intents.ts';
import { tickRuin } from './intents/ruins/tick.ts';
import { tickSource } from './intents/sources/tick.ts';
import { processSpawnIntents } from './intents/spawns/intents.ts';
import { tickSpawn } from './intents/spawns/tick.ts';
import { tickStorage } from './intents/storages/tick.ts';
import { terminalSend } from './intents/terminal/send.ts';
import { tickTerminal } from './intents/terminal/tick.ts';
import { tickTombstone } from './intents/tombstones/tick.ts';
import { processTowerIntents } from './intents/towers/intents.ts';
import { tickTower } from './intents/towers/tick.ts';
import type { ObjectIntentSet, RoomIntentsDoc, RoomScope, RoomUserIntents } from './scope.ts';
import type { MapView, RoomObject } from './state.ts';
import { isEqual, jsonClone, lookup } from './support.ts';

const KEEPER_ID = '3';
const INVADER_ID = '2';

export interface RoomProcessResult {
    /** Whether the room must be processed again next tick (upstream `driver.activateRoom`). */
    activateRoom: boolean;
    /** Serialized snapshot of the room objects written to room history when the room is active. */
    history: Record<string, unknown> | undefined;
    mapView: MapView;
    /** Whether `roomInfo` changed and must be saved. */
    roomInfoChanged: boolean;
}

function mergeNpcIntents(
    intents: RoomIntentsDoc,
    userId: string,
    npcIntents: Record<string, ObjectIntentSet>,
): void {
    let userIntents = intents.users[userId];
    if (!userIntents) {
        userIntents = {};
        intents.users[userId] = userIntents;
    }
    let objects = userIntents.objects;
    if (!objects) {
        objects = {};
        userIntents.objects = objects;
    }
    for (const objId of Object.keys(npcIntents)) {
        const ii = npcIntents[objId] as ObjectIntentSet;
        objects[objId] = Object.assign(ii, objects[objId] ?? {});
    }
}

/**
 * Processes one room for one tick. `scope` holds working copies of the room documents; writes are
 * accumulated in the scope bulks and executed by the caller.
 */
export function processRoom(scope: RoomScope, roomIntents: RoomIntentsDoc | undefined, recordHistory: boolean): RoomProcessResult {
    const { roomObjects, gameTime, roomInfo, bulk } = scope;
    const oldRoomInfo = { ...roomInfo };
    const roomSpawns: RoomObject[] = [];
    const roomExtensions: RoomObject[] = [];
    const roomNukes: RoomObject[] = [];
    const keepers: RoomObject[] = [];
    const invaders: RoomObject[] = [];
    let invaderCore: RoomObject | undefined;
    let activateRoom = false;

    for (const id of Object.keys(roomObjects)) {
        const object = roomObjects[id];
        if (!object) {
            continue;
        }

        if (object.type === 'creep') {
            object._actionLog = object.actionLog;
            object._ticksToLive = (object.ageTime as number) - gameTime;
            object.actionLog = {
                attacked: null,
                healed: null,
                attack: null,
                rangedAttack: null,
                rangedMassAttack: null,
                rangedHeal: null,
                harvest: null,
                heal: null,
                repair: null,
                build: null,
                say: null,
                upgradeController: null,
                reserveController: null,
            };
            if (object.user === KEEPER_ID) {
                keepers.push(object);
            } else if (object.user === INVADER_ID && !object.strongholdId) {
                invaders.push(object);
            }
        }
        if (object.type === 'invaderCore') {
            invaderCore = object;
            object._actionLog = object.actionLog;
            object.actionLog = {
                transferEnergy: null,
                reserveController: null,
                attackController: null,
                upgradeController: null,
            };
            if (object.deployTime) {
                activateRoom = true;
            }
        }
        if (object.type === 'link') {
            object._actionLog = object.actionLog;
            object.actionLog = { transferEnergy: null };
        }
        if (object.type === 'lab') {
            object._actionLog = object.actionLog;
            object.actionLog = { runReaction: null, reverseReaction: null };
        }
        if (object.type === 'tower') {
            object._actionLog = object.actionLog;
            object.actionLog = { attack: null, heal: null, repair: null };
        }
        if (object.type === 'controller') {
            scope.roomController = object;
            if (
                object.reservation &&
                object.reservation.user === '2' &&
                object.reservation.endTime - gameTime <
                    C.CONTROLLER_RESERVE_MAX - C.INVADER_CORE_CONTROLLER_POWER * C.CONTROLLER_RESERVE
            ) {
                activateRoom = true;
            }
            if (object.user && object.user !== '2') {
                activateRoom = true;
            }
        }
        if (object.type === 'observer') {
            object.observeRoom = null;
        }
        if (
            object.user &&
            object.user !== '3' &&
            !object.userNotActive &&
            object.type !== 'flag' &&
            !object.strongholdId &&
            object.type !== 'controller'
        ) {
            activateRoom = true;
        }
        if (object.type === 'powerBank' && gameTime > (object.decayTime as number) - 500) {
            activateRoom = true;
        }
        if (object.type === 'deposit' && gameTime > (object.decayTime as number) - 500) {
            activateRoom = true;
        }
        if (object.type === 'energy') {
            activateRoom = true;
        }
        if (object.type === 'nuke') {
            activateRoom = true;
            roomNukes.push(object);
        }
        if (object.type === 'tombstone') {
            activateRoom = true;
        }
        if (object.type === 'portal') {
            activateRoom = true;
        }
        if (object.type === 'extension') {
            roomExtensions.push(object);
        }
        if (object.type === 'spawn') {
            roomSpawns.push(object);
        }
        if (object.type === 'powerCreep') {
            object._actionLog = object.actionLog;
            object.actionLog = {
                spawned: null,
                attack: null,
                attacked: null,
                healed: null,
                power: null,
                say: null,
            };
        }
        if (object.type === 'factory') {
            object._actionLog = object.actionLog;
            object.actionLog = { produce: null };
        }
    }

    const intents: RoomIntentsDoc = roomIntents ?? { users: {} };

    for (const nuke of roomNukes) {
        nukePretick(nuke, intents, scope);
    }

    for (const keeper of keepers) {
        mergeNpcIntents(intents, keeper.user as string, keeperPretick(keeper, scope));
    }

    for (const invader of invaders) {
        mergeNpcIntents(intents, invader.user as string, invaderPretick(invader, scope));
    }

    if (invaderCore && invaderCore.user) {
        mergeNpcIntents(intents, invaderCore.user, invaderCorePretick(invaderCore, scope));
    }

    if (roomSpawns.length || roomExtensions.length) {
        calcSpawns(roomSpawns, roomExtensions, scope);
    }

    for (const userId of Object.keys(intents.users)) {
        const userIntents = intents.users[userId] as RoomUserIntents;

        if (userIntents.objectsManual) {
            userIntents.objects = userIntents.objects || {};
            Object.assign(userIntents.objects, userIntents.objectsManual);
        }

        const objects = userIntents.objects ?? {};
        for (const objectId of Object.keys(objects)) {
            const objectIntents = objects[objectId];
            if (!objectIntents) {
                continue;
            }

            if (objectId === 'room') {
                processRoomIntents(userId, objectIntents, scope);
                continue;
            }

            const object = roomObjects[objectId];
            if (!object || object._skip || (object.user && object.user !== userId)) {
                continue;
            }

            if (object.type === 'creep') processCreepIntents(object, objectIntents, scope);
            if (object.type === 'powerCreep') processPowerCreepIntents(object, objectIntents, scope);
            if (object.type === 'link') processLinkIntents(object, objectIntents, scope);
            if (object.type === 'tower') processTowerIntents(object, objectIntents, scope);
            if (object.type === 'lab') processLabIntents(object, objectIntents, scope);
            if (object.type === 'spawn') processSpawnIntents(object, objectIntents, scope);

            if (object.type === 'rampart' && objectIntents.setPublic) {
                setRampartPublic(object, objectIntents.setPublic, scope);
            }
            if (object.type === 'terminal' && objectIntents.send) {
                terminalSend(object, objectIntents.send, scope);
            }
            if (object.type === 'nuker' && objectIntents.launchNuke) {
                launchNuke(object, objectIntents.launchNuke, scope);
            }
            if (object.type === 'observer' && objectIntents.observeRoom) {
                object.observeRoom = objectIntents.observeRoom.roomName;
            }
            if (object.type === 'powerSpawn') {
                processPowerSpawnIntents(object, objectIntents, scope);
            }
            if (object.type === 'invaderCore') {
                processInvaderCoreIntents(object, objectIntents, scope);
            }
            if (object.type === 'factory' && objectIntents.produce) {
                factoryProduce(object, objectIntents.produce, scope);
            }
            if (object.type === 'controller') {
                if (objectIntents.unclaim) {
                    unclaimController(object, objectIntents.unclaim, scope);
                }
                if (objectIntents.activateSafeMode) {
                    activateSafeMode(object, objectIntents.activateSafeMode, scope);
                }
            }

            if (
                objectIntents.notifyWhenAttacked &&
                (lookup<number>(C.CONSTRUCTION_COST, object.type) ||
                    object.type === 'creep' ||
                    object.type === 'powerCreep')
            ) {
                bulk.update(object, { notifyWhenAttacked: !!objectIntents.notifyWhenAttacked.enabled });
            }
        }
    }

    const controller = scope.roomController;
    scope.movement.check(
        controller && (controller.safeMode as number) > gameTime ? controller.user || false : false,
    );

    let energyAvailable = 0;
    for (const id of Object.keys(roomObjects)) {
        const i = roomObjects[id];
        if (i && !i.off && (i.type === 'spawn' || i.type === 'extension')) {
            energyAvailable += Number(i.store?.energy) || 0;
        }
    }
    scope.energyAvailable = energyAvailable;

    const mapView: MapView = { w: [], r: [], pb: [], p: [], s: [], c: [], m: [], k: [] };
    const pushView = (key: string, object: RoomObject): void => {
        let list = mapView[key];
        if (!list) {
            list = [];
            mapView[key] = list;
        }
        list.push([object.x, object.y]);
    };
    const objectsToHistory: Record<string, unknown> = {};

    for (const id of Object.keys(roomObjects)) {
        const object = roomObjects[id];
        if (!object || object._skip) {
            continue;
        }

        switch (object.type) {
            case 'invaderCore':
                tickInvaderCore(object, scope);
                break;
            case 'energy':
                tickEnergy(object, scope);
                break;
            case 'source':
                tickSource(object, scope);
                break;
            case 'deposit':
                tickDeposit(object, scope);
                break;
            case 'mineral':
                tickMineral(object, scope);
                break;
            case 'creep':
                tickCreep(object, scope);
                break;
            case 'powerCreep':
                tickPowerCreep(object, scope);
                break;
            case 'spawn':
                tickSpawn(object, scope);
                break;
            case 'rampart':
                tickRampart(object, scope);
                break;
            case 'extension':
                tickExtension(object, scope);
                break;
            case 'road':
                tickRoad(object, scope);
                break;
            case 'constructionSite':
                tickConstructionSite(object, scope);
                break;
            case 'keeperLair':
                tickKeeperLair(object, scope);
                break;
            case 'portal':
                tickPortal(object, scope);
                break;
            case 'constructedWall':
                tickConstructedWall(object, scope);
                break;
            case 'link':
                tickLink(object, scope);
                break;
            case 'extractor':
                tickExtractor(object, scope);
                break;
            case 'tower':
                tickTower(object, scope);
                break;
            case 'controller':
                tickController(object, scope);
                break;
            case 'lab':
                tickLab(object, scope);
                break;
            case 'container':
                tickContainer(object, scope);
                break;
            case 'terminal':
                tickTerminal(object, scope);
                break;
            case 'tombstone':
                tickTombstone(object, scope);
                break;
            case 'ruin':
                tickRuin(object, scope);
                break;
            case 'factory':
                tickFactory(object, scope);
                break;
            case 'nuke':
                tickNuke(object, scope);
                break;
            case 'observer':
                bulk.update(object, { observeRoom: object.observeRoom });
                break;
            case 'storage':
                tickStorage(object, scope);
                break;
            default:
                break;
        }

        if (object.effects) {
            const collapseEffect = object.effects.find((e) => e.effect === C.EFFECT_COLLAPSE_TIMER);
            if (collapseEffect && collapseEffect.endTime <= gameTime) {
                bulk.remove(object._id);
                delete roomObjects[object._id];
                continue;
            }
        }

        if (object.type === 'powerBank' || object.type === 'deposit') {
            if (gameTime >= (object.decayTime as number) - 1) {
                bulk.remove(object._id);
                delete roomObjects[object._id];
            }
        }

        if (object.type !== 'flag') {
            objectsToHistory[object._id] = object;
            if (object.type === 'creep' || object.type === 'powerCreep') {
                const copy = jsonClone(object);
                copy._id = String(object._id);
                delete copy._actionLog;
                delete copy._ticksToLive;
                const say = object.actionLog?.say;
                if (say && (say === true || !say.isPublic) && copy.actionLog) {
                    delete copy.actionLog.say;
                }
                objectsToHistory[object._id] = copy;
            }
        }

        if (object.user) {
            if (
                object.type !== 'constructionSite' &&
                !object.newbieWall &&
                object.type !== 'ruin' &&
                object.type !== 'tombstone' &&
                (object.type !== 'rampart' || !object.isPublic)
            ) {
                pushView(object.user, object);
            }
        } else if (object.type === 'constructedWall') {
            pushView('w', object);
        } else if (object.type === 'road') {
            pushView('r', object);
        } else if (object.type === 'powerBank') {
            pushView('pb', object);
        } else if (object.type === 'portal') {
            pushView('p', object);
        } else if (object.type === 'source') {
            pushView('s', object);
        } else if (object.type === 'mineral' || object.type === 'deposit') {
            pushView('m', object);
        } else if (object.type === 'controller') {
            pushView('c', object);
        } else if (object.type === 'keeperLair') {
            pushView('k', object);
        } else if (object.type === 'energy' && object.resourceType === 'power') {
            pushView('pb', object);
        }
    }

    if (roomInfo.active) {
        activateRoom = true;
        delete roomInfo.active;
    }

    return {
        activateRoom,
        history: activateRoom && recordHistory ? jsonClone(objectsToHistory) : undefined,
        mapView,
        roomInfoChanged: !isEqual(roomInfo, oldRoomInfo),
    };
}
