/*
 * Port of screeps/engine `processor/intents/invader-core/stronghold/stronghold.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../../constants.ts';
import { calcBodyEffectiveness, calcReward, dist } from '../../../../utils/index.ts';
import { containerAmounts, containerRewards, templates } from '../../../../utils/strongholds.ts';
import type { Bulk } from '../../../bulk.ts';
import { type IntentList, lodashMax, lodashMin } from '../../../npc/fake-runtime.ts';
import type { RoomScope } from '../../../scope.ts';
import type {
    Effect,
    RoomObject,
    StoreCapacityResource,
    StrongholdPopulationEntry,
} from '../../../state.ts';
import { lookup, shuffle } from '../../../support.ts';
import { createEnergy } from '../../create-energy.ts';
import { creepDie } from '../../creeps/die.ts';
import { destroyStructure } from '../../structures/destroy.ts';
import type { NpcCreateCreepArgs } from '../create-creep.ts';
import { behaviors as creepBehaviors, bodies as creepBodies, type CreepSetup } from './creeps.ts';
import { distribute } from './defence.ts';

export interface StrongholdContext {
    scope: RoomScope;
    intents: IntentList;
    roomObjects: Record<string, RoomObject>;
    gameTime: number;
    bulk: Bulk<RoomObject>;
    creeps: RoomObject[];
    defenders: RoomObject[];
    damagedDefenders: RoomObject[];
    hostiles: RoomObject[];
    towers: RoomObject[];
    ramparts: RoomObject[];
    damagedRoads: RoomObject[];
    roomController: RoomObject | undefined;
    core: RoomObject;
    spots?: Record<string, string>;
}

const towerRefillChance = [0, 0.01, 0.1, 0.3, 1, 1];

function range(a: RoomObject | undefined, b: RoomObject | undefined): number {
    if (
        a === undefined ||
        a.x === undefined ||
        a.y === undefined ||
        a.room === undefined ||
        b === undefined ||
        b.x === undefined ||
        b.y === undefined ||
        b.room === undefined ||
        a.room !== b.room
    ) {
        return Infinity;
    }

    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function deployStronghold(context: StrongholdContext): void {
    const { scope, core, ramparts, bulk, gameTime } = context;
    const { roomObjects } = scope;

    if (core.deployTime && core.deployTime <= 1 + gameTime) {
        const duration = Math.round(C.STRONGHOLD_DECAY_TICKS * (0.9 + scope.env.random() * 0.2));
        const decayTime = gameTime + duration;

        const coreEffects = core.effects as Effect[];
        coreEffects.push({
            effect: C.EFFECT_COLLAPSE_TIMER,
            power: C.EFFECT_COLLAPSE_TIMER,
            endTime: gameTime + duration,
            duration,
        });
        bulk.update(core, {
            deployTime: null,
            decayTime,
            hits: C.INVADER_CORE_HITS,
            hitsMax: C.INVADER_CORE_HITS,
            effects: coreEffects,
        });

        ramparts.forEach((rampart) => {
            bulk.remove(rampart._id);
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- upstream drops the doc from the room index
            delete roomObjects[rampart._id];
        });

        const template = lookup(templates, core.templateName) as (typeof templates)[keyof typeof templates];

        // shared option objects (incl. nested `store`/`actionLog`) are reused across inserted docs, like upstream
        const objectOptions: Record<string, Record<string, unknown>> = {};
        objectOptions[C.STRUCTURE_RAMPART] = {
            hits: lookup(C.STRONGHOLD_RAMPART_HITS, template.rewardLevel),
            hitsMax: C.RAMPART_HITS_MAX[8],
            hitsTarget: lookup(C.STRONGHOLD_RAMPART_HITS, core.level),
            nextDecayTime: decayTime,
        };
        objectOptions[C.STRUCTURE_TOWER] = {
            hits: C.TOWER_HITS,
            hitsMax: C.TOWER_HITS,
            store: { energy: C.TOWER_CAPACITY },
            storeCapacityResource: { energy: C.TOWER_CAPACITY },
            actionLog: { attack: null, heal: null, repair: null },
        };
        objectOptions[C.STRUCTURE_CONTAINER] = {
            notifyWhenAttacked: false,
            hits: C.CONTAINER_HITS,
            hitsMax: C.CONTAINER_HITS,
            nextDecayTime: decayTime,
            store: {},
            storeCapacity: 0,
        };
        objectOptions[C.STRUCTURE_ROAD] = {
            notifyWhenAttacked: false,
            hits: C.ROAD_HITS,
            hitsMax: C.ROAD_HITS,
            nextDecayTime: decayTime,
        };

        let createdStructureCounter = 1;
        for (const i of template.structures) {
            const x = 0 + (core.x + i.dx);
            const y = 0 + (core.y + i.dy);
            for (const key of Object.keys(roomObjects)) {
                const o = roomObjects[key] as RoomObject;
                if (o.strongholdId || o.x !== x || o.y !== y) {
                    continue;
                }

                if (o.type === 'creep' || o.type === 'powerCreep') {
                    creepDie(o, undefined, true, scope);
                }
                if (o.type === 'constructionSite') {
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- upstream drops the doc from the room index
                    delete roomObjects[o._id];
                    bulk.remove(o._id);
                    if ((o.progress as number) > 1) {
                        createEnergy(o.x, o.y, o.room, Math.floor((o.progress as number) / 2), 'energy', scope);
                    }
                }
                if (lookup(C.CONSTRUCTION_COST, o.type)) {
                    destroyStructure(o, scope);
                }
            }

            if (i.type === C.STRUCTURE_INVADER_CORE) {
                continue;
            }

            const s: Record<string, unknown> = Object.assign(
                {},
                i,
                {
                    x,
                    y,
                    room: core.room,
                    strongholdId: core.strongholdId,
                    decayTime,
                    effects: [
                        {
                            effect: C.EFFECT_COLLAPSE_TIMER,
                            power: C.EFFECT_COLLAPSE_TIMER,
                            endTime: gameTime + duration,
                            duration,
                        },
                    ],
                },
                objectOptions[i.type] ?? {},
            );
            delete s.dx;
            delete s.dy;

            if (i.type === C.STRUCTURE_TOWER || i.type === C.STRUCTURE_RAMPART) {
                s.user = core.user;
            }

            if (i.type === C.STRUCTURE_CONTAINER) {
                s.store = calcReward(containerRewards, containerAmounts[template.rewardLevel] as number, 3, () =>
                    scope.env.random(),
                );
            }

            const doc = s as unknown as RoomObject;
            bulk.insert(doc);
            roomObjects[`deployedStructure${String(createdStructureCounter)}`] = doc;
            createdStructureCounter++;
        }
    }
}

function handleController(context: StrongholdContext): void {
    const { gameTime, core, intents, roomController } = context;

    if (roomController) {
        if (roomController.user === core.user) {
            if ((roomController.downgradeTime as number) - gameTime < C.INVADER_CORE_CONTROLLER_DOWNGRADE - 25) {
                intents.set(core._id, 'upgradeController', { id: roomController._id });
            }
        } else if (!roomController.reservation || roomController.reservation.user === core.user) {
            intents.set(core._id, 'reserveController', { id: roomController._id });
        } else {
            intents.set(core._id, 'attackController', { id: roomController._id });
        }
    }
}

function hasRampartAt(ramparts: readonly RoomObject[], o: RoomObject): boolean {
    return ramparts.some((r) => r.x === o.x && r.y === o.y);
}

function refillTowers(context: StrongholdContext): boolean {
    const { core, intents, towers, ramparts, scope } = context;
    if ((towerRefillChance[core.level as number] as number) < scope.env.random()) {
        return false;
    }

    const underchargedTowers = towers.filter(
        (t) => (t.store?.energy as number) <= 2 * C.TOWER_ENERGY_COST && hasRampartAt(ramparts, t),
    );
    if (underchargedTowers.length > 0) {
        // lodash `_.min` never yields a falsy value here (a doc, or `Infinity`)
        const towerToCharge = lodashMin(underchargedTowers, (t) => t.store?.energy) as RoomObject;
        intents.set(core._id, 'transfer', {
            id: towerToCharge._id,
            amount:
                ((towerToCharge.storeCapacityResource as StoreCapacityResource).energy as number) -
                (towerToCharge.store?.energy as number),
            resourceType: C.RESOURCE_ENERGY,
        });
        return true;
    }

    return false;
}

function refillCreeps(context: StrongholdContext): boolean {
    const { core, intents, defenders } = context;

    const underchargedCreeps = defenders.filter(
        (c) =>
            (c.storeCapacity as number) > 0 && 2 * (c.store?.energy as number) <= (c.storeCapacity as number),
    );
    if (underchargedCreeps.length > 0) {
        const creep = lodashMin(underchargedCreeps, (c) => c.store?.energy) as RoomObject;
        intents.set(core._id, 'transfer', {
            id: creep._id,
            amount: (creep.storeCapacity as number) - (creep.store?.energy as number),
            resourceType: C.RESOURCE_ENERGY,
        });
        return true;
    }

    return false;
}

function pullFrom<T>(list: T[], value: T): void {
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === value) {
            list.splice(i, 1);
        }
    }
}

function towersMaintenance(context: StrongholdContext): void {
    const { intents, towers, ramparts, damagedDefenders, damagedRoads } = context;
    if (!towers.length || (!damagedDefenders.length && !damagedRoads.length)) {
        return;
    }

    const protectedCreeps = damagedDefenders.filter((d) => hasRampartAt(ramparts, d));
    if (protectedCreeps.length > 0) {
        const creep = protectedCreeps[0] as RoomObject;
        const tower = towers[0] as RoomObject;
        intents.set(tower._id, 'heal', { id: creep._id });
        pullFrom(towers, tower);
        return;
    }

    const protectedRoads = damagedRoads.filter((r) => hasRampartAt(ramparts, r));
    if (protectedRoads.length > 0) {
        // upstream repairs the first damaged road, not the first protected one
        const road = damagedRoads[0] as RoomObject;
        const tower = towers[0] as RoomObject;
        intents.set(tower._id, 'repair', { id: road._id });
        pullFrom(towers, tower);
    }
}

function attackWithDefenders(context: StrongholdContext, target: RoomObject): void {
    const { intents, defenders } = context;

    const meleesNear = defenders.filter(
        (d) => range(d, target) === 1 && (d.body ?? []).some((p) => p.type === C.ATTACK),
    );
    for (const melee of meleesNear) {
        intents.set(melee._id, 'attack', { id: target._id, x: target.x, y: target.y });
    }

    const rangersInRange = defenders.filter(
        (d) => range(d, target) <= 3 && (d.body ?? []).some((p) => p.type === C.RANGED_ATTACK),
    );
    for (const r of rangersInRange) {
        if (range(r, target) === 1) {
            intents.set(r._id, 'rangedMassAttack', {});
        } else {
            intents.set(r._id, 'rangedAttack', { id: target._id });
        }
    }
}

function focusClosest(context: StrongholdContext): boolean {
    const { core, intents, hostiles, towers } = context;

    if (hostiles.length === 0) {
        return false;
    }

    const target = lodashMin(hostiles, (c) => dist(c, core)) as RoomObject;
    for (const t of towers) {
        intents.set(t._id, 'attack', { id: target._id });
    }

    attackWithDefenders(context, target);

    return true;
}

function focusMax(context: StrongholdContext): boolean {
    const { intents, defenders, hostiles, towers, gameTime } = context;

    if (hostiles.length === 0) {
        return false;
    }

    const activeTowers = towers.filter((t) => (t.store?.energy as number) >= C.TOWER_ENERGY_COST);
    const target = lodashMax(hostiles, (creep) => {
        let damage = 0;
        for (const tower of activeTowers) {
            let r = dist(creep, tower);
            let amount: number = C.TOWER_POWER_ATTACK;
            if (r > C.TOWER_OPTIMAL_RANGE) {
                if (r > C.TOWER_FALLOFF_RANGE) {
                    r = C.TOWER_FALLOFF_RANGE;
                }
                amount -=
                    (amount * C.TOWER_FALLOFF * (r - C.TOWER_OPTIMAL_RANGE)) /
                    (C.TOWER_FALLOFF_RANGE - C.TOWER_OPTIMAL_RANGE);
            }
            for (const power of [C.PWR_OPERATE_TOWER, C.PWR_DISRUPT_TOWER] as const) {
                const effect = (tower.effects ?? []).find((e) => e.power === power);
                if (effect && effect.endTime > gameTime) {
                    amount *= C.POWER_INFO[power].effect[(effect.level as number) - 1] as number;
                }
            }
            damage += Math.floor(amount) || 0;
        }
        for (const defender of defenders) {
            let d = 0;
            if (range(defender, creep) <= 3 && (defender.body ?? []).some((p) => p.type === C.RANGED_ATTACK)) {
                d += calcBodyEffectiveness(
                    defender.body ?? [],
                    C.RANGED_ATTACK,
                    'rangedAttack',
                    C.RANGED_ATTACK_POWER,
                );
            }
            if (range(defender, creep) <= 1 && (defender.body ?? []).some((p) => p.type === C.ATTACK)) {
                d += calcBodyEffectiveness(defender.body ?? [], C.ATTACK, 'attack', C.ATTACK_POWER);
            }
            damage += d || 0;
        }

        return damage;
    }) as RoomObject;

    attackWithDefenders(context, target);

    for (const t of activeTowers) {
        intents.set(t._id, 'attack', { id: target._id });
    }

    return true;
}

function maintainCreep(
    name: string,
    setup: CreepSetup | undefined,
    context: StrongholdContext,
    behavior: ((creep: RoomObject, context: StrongholdContext) => unknown) | undefined,
): void {
    const { core, intents, defenders } = context;
    const creep = defenders.find((d) => d.name === name);
    if (creep && behavior) {
        behavior(creep, context);
        return;
    }

    if (!core.spawning && !core._spawning) {
        const creepSetup = setup as CreepSetup;
        const createCreepArgs: NpcCreateCreepArgs = {
            name,
            body: creepSetup.body as NonNullable<NpcCreateCreepArgs['body']>,
            boosts: creepSetup.boosts,
        };
        intents.set(core._id, 'createCreep', createCreepArgs);
        core._spawning = true;
    }
}

function maintainPopulation(context: StrongholdContext): void {
    const { core } = context;

    if (!core.population) {
        return;
    }

    core.population.forEach((entry, i) => {
        maintainCreep(
            `defender${String(i)}`,
            lookup(creepBodies, entry.body),
            context,
            lookup(creepBehaviors, entry.behavior),
        );
    });
}

function antinuke(context: StrongholdContext): void {
    const { core, ramparts, roomObjects, bulk, gameTime } = context;
    if (gameTime % 10) {
        return;
    }
    const objects = Object.values(roomObjects);
    const nukes = objects.filter((o) => o.type === 'nuke');

    const baseLevel = lookup(C.STRONGHOLD_RAMPART_HITS, core.level) as number;
    for (const rampart of ramparts) {
        if (objects.some((o) => o.type === C.STRUCTURE_CONTAINER && o.x === rampart.x && o.y === rampart.y)) {
            continue;
        }
        let hitsTarget = baseLevel;
        for (const n of nukes) {
            const nukeRange = dist(rampart, n);
            if (nukeRange === 0) {
                hitsTarget += C.NUKE_DAMAGE[0];
                continue;
            }
            if (nukeRange <= 2) {
                hitsTarget += C.NUKE_DAMAGE[2];
            }
        }
        if (rampart.hitsTarget !== hitsTarget) {
            bulk.update(rampart, { hitsTarget });
        }
    }
}

function assignDefenders(context: StrongholdContext): Record<string, string> {
    let rangerSpots: RoomObject[] = [];
    let meleeSpots: RoomObject[] = [];
    for (const h of context.hostiles) {
        meleeSpots.push(...context.ramparts.filter((r) => dist(h, r) <= 1));
        rangerSpots.push(...context.ramparts.filter((r) => dist(h, r) <= 3));
    }
    meleeSpots = [...new Set(meleeSpots)];
    rangerSpots = [...new Set(rangerSpots.filter((r) => !meleeSpots.includes(r)))];
    const rangers: string[] = [];
    const melees: string[] = [];
    for (const d of context.defenders) {
        if ((d.body ?? []).some((p) => p.type === C.ATTACK)) {
            melees.push(d._id.toString());
        }
        if ((d.body ?? []).some((p) => p.type === C.RANGED_ATTACK)) {
            rangers.push(d._id.toString());
        }
    }

    let spots: Record<string, string> = {};
    if (meleeSpots.length > 0 && melees.length > 0) {
        spots = distribute(meleeSpots, melees);
    }
    if (rangerSpots.length > 0 && rangers.length > 0) {
        Object.assign(spots, distribute(rangerSpots, rangers));
    }

    return spots;
}

export const behaviors: Readonly<Record<string, (context: StrongholdContext) => void>> = {
    deploy(context) {
        handleController(context);
        deployStronghold(context);
    },
    default(context) {
        handleController(context);
        refillTowers(context);
        focusClosest(context);
    },
    bunker1(context) {
        handleController(context);
        if (!refillTowers(context)) refillCreeps(context);
        focusClosest(context);
    },
    bunker2(context) {
        handleController(context);
        if (!refillTowers(context)) refillCreeps(context);

        const { core, bulk } = context;
        if (!core.population) {
            bulk.update(core, {
                population: [{ body: 'weakDefender', behavior: 'simple-melee' }],
            });
        }

        maintainPopulation(context);

        focusClosest(context);
    },
    bunker3(context) {
        handleController(context);
        refillTowers(context);

        const { core, bulk } = context;
        if (!core.population) {
            bulk.update(core, {
                population: [
                    { body: 'fullDefender', behavior: 'simple-melee' },
                    { body: 'fullDefender', behavior: 'simple-melee' },
                ],
            });
        }

        maintainPopulation(context);

        focusClosest(context);
    },
    bunker4(context) {
        handleController(context);
        if (!refillTowers(context)) refillCreeps(context);

        const { core, bulk, scope } = context;
        if (!core.population) {
            const populationDeck: StrongholdPopulationEntry[] = [
                { body: 'fortifier', behavior: 'fortifier' },
                ...new Array<StrongholdPopulationEntry>(4).fill({ body: 'boostedDefender', behavior: 'coordinated' }),
                ...new Array<StrongholdPopulationEntry>(3).fill({ body: 'boostedRanger', behavior: 'coordinated' }),
            ];

            bulk.update(core, {
                population: shuffle(populationDeck, () => scope.env.random()).slice(0, 4),
            });
        }

        context.spots = assignDefenders(context);

        maintainPopulation(context);

        towersMaintenance(context);
        focusMax(context);
    },
    bunker5(context) {
        handleController(context);
        if (!refillTowers(context)) refillCreeps(context);

        const { core, bulk, scope } = context;
        if (!core.population) {
            const populationDeck = shuffle(
                [
                    { body: 'fortifier', behavior: 'fortifier' },
                    ...new Array<StrongholdPopulationEntry>(7).fill({
                        body: 'fullBoostedMelee',
                        behavior: 'coordinated',
                    }),
                    ...new Array<StrongholdPopulationEntry>(9).fill({
                        body: 'fullBoostedRanger',
                        behavior: 'coordinated',
                    }),
                ],
                () => scope.env.random(),
            );

            bulk.update(core, {
                population: [
                    { body: 'fortifier', behavior: 'fortifier' },
                    ...shuffle(populationDeck, () => scope.env.random()).slice(0, 8),
                ],
            });
        }

        antinuke(context);

        context.spots = assignDefenders(context);

        maintainPopulation(context);

        towersMaintenance(context);
        focusMax(context);
    },
};
