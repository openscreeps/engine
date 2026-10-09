/*
 * Persistent world state shapes for the simulation.
 *
 * The collections mirror the documents the official Screeps server keeps in its database
 * (`rooms`, `rooms.objects`, `rooms.terrain`, `rooms.flags`, `users`, `users.power_creeps`,
 * `market.orders`, `transactions`, `users.money`, `users.resources`, `users.notifications`) plus the
 * env keys the engine reads or writes (game time, active rooms, room event logs, map views).
 * Field names are kept identical to the upstream documents so that persisted data is
 * interchangeable with the official engine.
 *
 * Portions derived from screeps/engine and screeps/driver, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type * as C from '../constants.ts';

export type ResourceType = (typeof C.RESOURCES_ALL)[number];

/** Store contents keyed by resource type. */
export type Store = Record<string, number>;
/** Per-resource capacity. `null` entries are written by labs when a mineral slot is released. */
export type StoreCapacityResource = Record<string, number | null>;

export interface BodyPart {
    type: string;
    hits: number;
    boost?: string | null;
    /** Processing-only: hits before damage was applied this tick. Stripped on persist. */
    _oldHits?: number;
}

export interface Effect {
    effect: number;
    power?: number;
    level?: number;
    endTime: number;
    duration?: number;
}

export interface ActionLogEntry {
    x?: number;
    y?: number;
    /** Target id, or the power constant for `actionLog.power` of power creeps. */
    id?: string | number;
    message?: string;
    isPublic?: boolean | undefined;
    power?: number;
    /** Lab reaction source labs (`runReaction` / `reverseReaction`). */
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
    /** Factory `produce` product. */
    resourceType?: string;
}

/** Per-tick action log of an object; `spawned: true` marks a power creep spawned this tick. */
export type ActionLog = Record<string, ActionLogEntry | true | null>;

export interface RoomPositionData {
    room: string;
    x: number;
    y: number;
    shard?: string;
}

export interface SpawningInfo {
    name: string;
    needTime?: number;
    spawnTime: number;
    directions?: number[] | undefined;
}

export interface ControllerReservation {
    user: string;
    endTime: number;
}

export interface ControllerSign {
    user: string;
    text: string;
    time: number;
    datetime: number;
}

export interface TerminalSendIntent {
    targetRoomName: string;
    resourceType: string;
    amount: number;
    description?: string;
}

export interface RuinStructureInfo {
    id: string;
    type: string;
    hits: number;
    hitsMax?: number | undefined;
    user?: string | null | undefined;
}

export interface MemoryMove {
    dest?: string | null;
    path?: string | null;
    time?: number | null;
    lastMove?: number | null;
}

export interface PowerCreepPowerInfo {
    level: number;
    cooldownTime?: number;
}

export interface WallDecayTimestamp {
    timestamp: number;
}

export interface StrongholdPopulationEntry {
    body: string;
    behavior: string;
}

/**
 * A `rooms.objects` document. Every room object type shares a single shape whose type specific
 * fields are optional, exactly like the schemaless upstream documents. Dropped resources keep
 * their amount under the resource type key (e.g. `{type: 'energy', resourceType: 'H', H: 20}`).
 *
 * Fields prefixed with `_` are processing-only scratch values; they are never persisted.
 */
export interface RoomObject extends Partial<Record<ResourceType, number>> {
    _id: string;
    type: string;
    room: string;
    x: number;
    y: number;

    user?: string | null | undefined;
    name?: string;
    hits?: number;
    hitsMax?: number;
    notifyWhenAttacked?: boolean;
    store?: Store;
    storeCapacity?: number | null;
    storeCapacityResource?: StoreCapacityResource;
    effects?: Effect[] | null;
    actionLog?: ActionLog;
    off?: boolean;
    cooldown?: number;
    cooldownTime?: number;
    decayTime?: number | WallDecayTimestamp | null;
    nextDecayTime?: number;
    ticksToLive?: number | null;
    tutorial?: boolean;
    strongholdId?: string;
    userNotActive?: boolean;

    // creeps & power creeps
    body?: BodyPart[];
    fatigue?: number;
    ageTime?: number;
    spawning?: boolean | SpawningInfo | null;
    interRoom?: RoomPositionData | null;
    userSummoned?: boolean;
    noCapacityRecalc?: boolean;
    tombstoneDecay?: number;
    memory_move?: MemoryMove | null;
    memory_sourceId?: string;
    className?: string;
    level?: number;
    powers?: Record<string, PowerCreepPowerInfo>;
    shard?: string | null;
    spawnCooldownTime?: number | null;
    deleteTime?: number | null;

    // controller
    bindUser?: string;
    progress?: number;
    progressTotal?: number;
    downgradeTime?: number | null;
    safeMode?: number | null;
    safeModeAvailable?: number;
    safeModeCooldown?: number | null;
    upgradeBlocked?: number | null;
    reservation?: ControllerReservation | null;
    sign?: ControllerSign | null;
    hardSign?: ControllerSign | null;
    isPowerEnabled?: boolean;
    promoPeriodUntil?: number;

    // construction sites
    structureType?: string;

    // sources, minerals, deposits, dropped resources
    energyCapacity?: number;
    nextRegenerationTime?: number | null;
    invaderHarvested?: number;
    mineralType?: string;
    mineralAmount?: number;
    density?: number;
    depositType?: string;
    harvested?: number;
    resourceType?: string;

    // structures
    isPublic?: boolean;
    destination?: RoomPositionData;
    unstableDate?: number | null;
    observeRoom?: string | null | undefined;
    send?: TerminalSendIntent | null;
    newbieWall?: boolean;
    nextSpawnTime?: number | null;
    templateName?: string;
    deployTime?: number | null;
    strongholdBehavior?: string;
    depositTypes?: string[];
    nextExpandTime?: number;
    population?: StrongholdPopulationEntry[] | null;
    hitsTarget?: number;

    // nukes
    launchRoomName?: string;
    landTime?: number;

    // tombstones & ruins
    deathTime?: number;
    creepId?: string;
    creepName?: string;
    creepTicksToLive?: number;
    creepBody?: string[];
    creepSaying?: string;
    powerCreepId?: string;
    powerCreepName?: string;
    powerCreepTicksToLive?: number;
    powerCreepClassName?: string;
    powerCreepLevel?: number;
    powerCreepPowers?: Record<string, PowerCreepPowerInfo>;
    powerCreepSaying?: string;
    structure?: RuinStructureInfo;
    destroyTime?: number;

    // processing-only scratch values (never persisted)
    _actionLog?: ActionLog | undefined;
    _ticksToLive?: number;
    _skip?: boolean;
    _off?: boolean;
    _fatigue?: number;
    _oldFatigue?: number | undefined;
    _pull?: string;
    _pulled?: string;
    _damageToApply?: number;
    _healToApply?: number;
    _attack?: boolean;
    _upgraded?: number;
    _upgradeBlocked?: number;
    _safeModeActivated?: number;
    _cooldown?: number;
    _justSpawned?: boolean;
    _spawning?: boolean;
    _usedPowerLevels?: number;
}

/** A `rooms` document. */
export interface RoomInfo {
    _id: string;
    status?: string;
    active?: boolean;
    novice?: number | null;
    respawnArea?: number | null;
    openTime?: number | null;
    bus?: boolean;
    depositType?: string;
    lastPvpTime?: number;
    powerBankTime?: number;
    invaderGoal?: number;
    sourceKeepers?: boolean;
    controllerLevel?: number;
}

/** A `rooms.flags` document: all flags of one user in one room, serialized like upstream. */
export interface FlagDoc {
    _id: string;
    user: string;
    room: string;
    /** `name~color~secondaryColor~x~y` entries joined by `|`. */
    data: string;
}

export interface UserDoc {
    _id: string;
    username?: string;
    usernameLower?: string;
    cpu?: number;
    cpuAvailable?: number;
    gcl?: number;
    power?: number;
    money?: number;
    rooms?: string[];
    active?: number;
    bot?: string;
    badge?: unknown;
    shardAccess?: boolean;
    powerExperimentations?: number;
    powerExperimentationTime?: number;
    lastRespawnDate?: number;
    blocked?: boolean;
    steam?: unknown;
    resources?: Record<string, number>;
    /** Processing-only: power levels consumed by power creep intents this tick. */
    _usedPowerLevels?: number;
}

/** A `users.power_creeps` document (power creep account record, alive or not). */
export interface PowerCreepDoc {
    _id: string;
    user: string;
    name: string;
    className: string;
    level: number;
    hitsMax: number;
    store: Store;
    storeCapacity: number;
    spawnCooldownTime: number | null;
    deleteTime?: number | null;
    shard?: string | null;
    powers: Record<string, PowerCreepPowerInfo>;
}

/** A `market.orders` document (normal and intershard orders share the collection upstream). */
export interface MarketOrder {
    _id: string;
    created?: number;
    createdTimestamp?: number;
    user?: string | null;
    active?: boolean;
    type: string;
    amount: number;
    remainingAmount: number;
    totalAmount?: number;
    resourceType: string;
    price: number;
    roomName?: string;
    /** Transient (per-tick) flag: price changed this tick, deals are rejected. */
    _skip?: boolean;
    /** Transient (per-tick) flag: cancelled this tick, removed during cleanup. */
    _cancelled?: boolean;
}

export interface TransactionOrderInfo {
    id: string;
    type: string;
    price: number;
}

/** A `transactions` document. */
export interface TransactionDoc {
    _id: string;
    time: number;
    sender?: string | undefined;
    recipient?: string | undefined;
    resourceType: string;
    amount: number;
    from: string;
    to: string;
    description?: string | undefined;
    order?: TransactionOrderInfo;
}

export interface MoneyLogMarketInfo {
    orderId?: string;
    anotherUser?: string;
    order?: unknown;
    changeOrderPrice?: { orderId: string; oldPrice: number; newPrice: number };
    extendOrder?: { orderId: string; addAmount: number };
    resourceType?: string;
    roomName?: string;
    targetRoomName?: string;
    price?: number;
    npc?: boolean;
    owner?: string;
    dealer?: string;
    amount?: number;
}

/** A `users.money` document (credits history). */
export interface MoneyLogDoc {
    _id: string;
    date: number;
    tick: number;
    user: string;
    type: string;
    balance: number;
    change: number;
    market: MoneyLogMarketInfo;
}

/** A `users.resources` document (account resources history). */
export interface ResourceLogDoc {
    _id: string;
    date: number;
    resourceType: string;
    user: string;
    change: number;
    balance?: number;
    marketOrderId?: string;
    market?: MoneyLogMarketInfo;
}

/** A `users.notifications` document. */
export interface NotificationDoc {
    _id: string;
    user: string;
    message: string;
    date: number;
    type: string;
    count: number;
}

export interface EventData {
    targetId?: string;
    damage?: number;
    attackType?: number;
    amount?: number;
    healType?: number;
    energySpent?: number;
    structureType?: string;
    x?: number;
    y?: number;
    incomplete?: boolean;
    room?: string;
    resourceType?: string;
    type?: string;
    power?: number;
}

export interface EventLogEntry {
    event: number;
    objectId: string;
    data?: EventData;
}

/** Map view written for each processed room: owner id or terrain-feature code -> positions. */
export type MapView = Record<string, Array<[number, number]>>;

export interface WorldState {
    gameTime: number;
    shardName: string;
    rooms: Record<string, RoomInfo>;
    /** 2500-character terrain string per room (`'0'`..`'3'`, row-major `y * 50 + x`). */
    terrain: Record<string, string>;
    roomObjects: Record<string, RoomObject>;
    flags: Record<string, FlagDoc>;
    users: Record<string, UserDoc>;
    userPowerCreeps: Record<string, PowerCreepDoc>;
    marketOrders: Record<string, MarketOrder>;
    transactions: Record<string, TransactionDoc>;
    usersMoney: Record<string, MoneyLogDoc>;
    usersResources: Record<string, ResourceLogDoc>;
    notifications: Record<string, NotificationDoc>;
    /** Rooms scheduled for processing on the next tick. */
    activeRooms: string[];
    /** Event log of each room produced by its latest processing. */
    roomEventLogs: Record<string, EventLogEntry[]>;
    mapViews: Record<string, MapView>;
    /** Monotonic counter used to generate document ids. */
    idCounter: number;
    /** Seeded generator state used everywhere upstream calls `Math.random()`. */
    rngState: number;
}

export function createWorldState(init: Partial<WorldState> = {}): WorldState {
    return {
        gameTime: init.gameTime ?? 1,
        shardName: init.shardName ?? 'shard0',
        rooms: init.rooms ?? {},
        terrain: init.terrain ?? {},
        roomObjects: init.roomObjects ?? {},
        flags: init.flags ?? {},
        users: init.users ?? {},
        userPowerCreeps: init.userPowerCreeps ?? {},
        marketOrders: init.marketOrders ?? {},
        transactions: init.transactions ?? {},
        usersMoney: init.usersMoney ?? {},
        usersResources: init.usersResources ?? {},
        notifications: init.notifications ?? {},
        activeRooms: init.activeRooms ?? [],
        roomEventLogs: init.roomEventLogs ?? {},
        mapViews: init.mapViews ?? {},
        idCounter: init.idCounter ?? 0,
        rngState: init.rngState ?? 0x2545f491,
    };
}
