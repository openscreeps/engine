/*
 * Per-user runtime data delivered into the player sandbox every tick.
 *
 * Mirrors the object assembled by screeps/driver `lib/runtime/data.js` (`runtimeData`) and the fields
 * added by `lib/runtime/runtime.js` before `game.init` is invoked.
 *
 * Portions derived from screeps/driver and screeps/engine, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type {
    FlagDoc,
    MarketOrder,
    PowerCreepDoc,
    RoomInfo,
    RoomObject as RawRoomObject,
    TransactionDoc,
    UserDoc,
} from '../../simulation/state.ts';

export type { RawRoomObject, RoomInfo, FlagDoc, PowerCreepDoc, MarketOrder, TransactionDoc, UserDoc };

/** Player code modules: source text, or `{binary}` holding base64 data (e.g. WebAssembly). */
export type CodeModules = Record<string, string | { binary: string }>;

/** The running player's own `users` document; `username` and `rooms` are always present upstream. */
export interface RuntimeUser extends UserDoc {
    username: string;
    rooms: string[];
}

/** Public profile of any user referenced by visible objects, transactions, signs or reservations. */
export interface RuntimeUserInfo {
    _id: string;
    username: string;
    badge?: unknown;
}

/** An active market order with `_id` renamed to `id` (driver `getCachedMarketOrders`). */
export interface RuntimeMarketOrder extends Omit<MarketOrder, '_id'> {
    id: string;
}

export interface MarketHistoryEntry {
    resourceType: string;
    date: string;
    transactions: number;
    volume: number;
    avgPrice: number;
    stddevPrice: number;
}

export interface RuntimeMarketData {
    /** Orders by resource type plus the `all` index, keyed by order id. Prices are in milli-credits. */
    orders: Record<string, Record<string, RuntimeMarketOrder>>;
    /** Market history by resource type plus the `all` list. */
    history: Record<string, MarketHistoryEntry[]>;
    /** The player's own orders (active or not) as raw documents. */
    myOrders: MarketOrder[];
}

export interface RoomStatusData {
    novice: Record<string, number>;
    respawn: Record<string, number>;
    /** `null` encodes an unlimited closure (upstream serializes `Infinity` through JSON). */
    closed: Record<string, number | null>;
}

export interface ConsoleCommand {
    expression: string;
    hidden?: boolean;
}

export interface ForeignMemorySegment {
    username: string;
    id: number;
    /** `null` when the foreign segment was never written (upstream `hget` result). */
    data: string | null;
}

export interface MapGridRoomExits {
    t?: number;
    r?: number;
    b?: number;
    l?: number;
}

export interface MapGrid {
    /** Exit counts per room keyed by `"x,y"` world coordinates (driver `WorldMapGrid.gridData`). */
    gridData: Record<string, MapGridRoomExits>;
}

/** Data copied into the sandbox for a single player run. */
export interface RuntimeData {
    time: number;
    user: RuntimeUser;
    users: Record<string, RuntimeUserInfo>;
    userCode: CodeModules;
    userCodeTimestamp: number;
    userMemory: { data: string; userId: string };
    consoleCommands: ConsoleCommand[];
    /** Objects owned by the player in any room, keyed by `_id`. */
    userObjects: Record<string, RawRoomObject>;
    /** Objects in visible rooms plus all player-owned objects, keyed by `_id`. */
    roomObjects: Record<string, RawRoomObject>;
    /** Visible rooms. */
    rooms: Record<string, RoomInfo>;
    flags: FlagDoc[];
    /** JSON encoded list of accessible room names. */
    accessibleRooms: string;
    roomStatusData: RoomStatusData;
    transactions: { outgoing: TransactionDoc[]; incoming: TransactionDoc[] };
    cpu: number;
    cpuBucket: number;
    /** JSON encoded event log per visible room (`undefined` when the room has none). */
    roomEventLog: Record<string, string | undefined>;
    userPowerCreeps: Record<string, PowerCreepDoc>;
    market: RuntimeMarketData;
    memorySegments?: Record<number, string>;
    foreignMemorySegment?: ForeignMemorySegment;
    shardName: string;
    worldSize: number;
}

/** Fields attached inside the sandbox before `game.init` (driver `runtime.js` `_start`). */
export interface SandboxRuntimeData extends RuntimeData {
    mapGrid: MapGrid;
    /** Terrain bytes per room (`y * 50 + x`, `TERRAIN_MASK_*` bits). */
    staticTerrainData: Record<string, Uint8Array>;
}
