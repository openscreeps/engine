/**
 * Shared type vocabulary derived from the literal-typed game constants.
 *
 * These are type-only declarations; the runtime values live in `src/constants.ts`.
 */

import type * as C from '../constants.ts';

type ValueOf<T> = T[keyof T];

// ---------------------------------------------------------------------------
// Return codes

export type OK = typeof C.OK;
export type ErrorCode =
  | typeof C.ERR_NOT_OWNER
  | typeof C.ERR_NO_PATH
  | typeof C.ERR_NAME_EXISTS
  | typeof C.ERR_BUSY
  | typeof C.ERR_NOT_FOUND
  | typeof C.ERR_NOT_ENOUGH_RESOURCES
  | typeof C.ERR_INVALID_TARGET
  | typeof C.ERR_FULL
  | typeof C.ERR_NOT_IN_RANGE
  | typeof C.ERR_INVALID_ARGS
  | typeof C.ERR_TIRED
  | typeof C.ERR_NO_BODYPART
  | typeof C.ERR_RCL_NOT_ENOUGH
  | typeof C.ERR_GCL_NOT_ENOUGH
  | typeof C.ERR_ACCESS_DENIED;
export type ScreepsReturnCode = OK | ErrorCode;

// ---------------------------------------------------------------------------
// Find / look

export type ExitConstant =
  | typeof C.FIND_EXIT_TOP
  | typeof C.FIND_EXIT_RIGHT
  | typeof C.FIND_EXIT_BOTTOM
  | typeof C.FIND_EXIT_LEFT;
export type FindConstant =
  | ExitConstant
  | typeof C.FIND_EXIT
  | typeof C.FIND_CREEPS
  | typeof C.FIND_MY_CREEPS
  | typeof C.FIND_HOSTILE_CREEPS
  | typeof C.FIND_SOURCES_ACTIVE
  | typeof C.FIND_SOURCES
  | typeof C.FIND_DROPPED_RESOURCES
  | typeof C.FIND_STRUCTURES
  | typeof C.FIND_MY_STRUCTURES
  | typeof C.FIND_HOSTILE_STRUCTURES
  | typeof C.FIND_FLAGS
  | typeof C.FIND_CONSTRUCTION_SITES
  | typeof C.FIND_MY_SPAWNS
  | typeof C.FIND_HOSTILE_SPAWNS
  | typeof C.FIND_MY_CONSTRUCTION_SITES
  | typeof C.FIND_HOSTILE_CONSTRUCTION_SITES
  | typeof C.FIND_MINERALS
  | typeof C.FIND_NUKES
  | typeof C.FIND_TOMBSTONES
  | typeof C.FIND_POWER_CREEPS
  | typeof C.FIND_MY_POWER_CREEPS
  | typeof C.FIND_HOSTILE_POWER_CREEPS
  | typeof C.FIND_DEPOSITS
  | typeof C.FIND_RUINS;

export type LookConstant =
  | typeof C.LOOK_CREEPS
  | typeof C.LOOK_ENERGY
  | typeof C.LOOK_RESOURCES
  | typeof C.LOOK_SOURCES
  | typeof C.LOOK_MINERALS
  | typeof C.LOOK_DEPOSITS
  | typeof C.LOOK_STRUCTURES
  | typeof C.LOOK_FLAGS
  | typeof C.LOOK_CONSTRUCTION_SITES
  | typeof C.LOOK_NUKES
  | typeof C.LOOK_TERRAIN
  | typeof C.LOOK_TOMBSTONES
  | typeof C.LOOK_POWER_CREEPS
  | typeof C.LOOK_RUINS;

// ---------------------------------------------------------------------------
// Geometry

export type DirectionConstant =
  | typeof C.TOP
  | typeof C.TOP_RIGHT
  | typeof C.RIGHT
  | typeof C.BOTTOM_RIGHT
  | typeof C.BOTTOM
  | typeof C.BOTTOM_LEFT
  | typeof C.LEFT
  | typeof C.TOP_LEFT;

export type ColorConstant = (typeof C.COLORS_ALL)[number];

export type TerrainMaskConstant =
  typeof C.TERRAIN_MASK_WALL | typeof C.TERRAIN_MASK_SWAMP | typeof C.TERRAIN_MASK_LAVA;
export type TerrainType = 'plain' | 'wall' | 'swamp';

/** Any object exposing in-room tile coordinates. */
export interface PosLike {
  readonly x: number;
  readonly y: number;
}

/** Any object exposing world tile coordinates (RoomPosition shape). */
export interface RoomPosLike extends PosLike {
  readonly roomName: string;
}

/** Any object exposing a `pos` property (RoomObject shape). */
export interface HasPos {
  readonly pos: PosLike;
}

/** Accepted wherever upstream code did `if (a.pos) a = a.pos`. */
export type PositionSource = PosLike | HasPos;

// ---------------------------------------------------------------------------
// Body parts

export type BodyPartConstant = (typeof C.BODYPARTS_ALL)[number];
export type BoostedBodyPartConstant = keyof typeof C.BOOSTS;

// ---------------------------------------------------------------------------
// Structures

export type StructureConstant =
  | typeof C.STRUCTURE_SPAWN
  | typeof C.STRUCTURE_EXTENSION
  | typeof C.STRUCTURE_ROAD
  | typeof C.STRUCTURE_WALL
  | typeof C.STRUCTURE_RAMPART
  | typeof C.STRUCTURE_KEEPER_LAIR
  | typeof C.STRUCTURE_PORTAL
  | typeof C.STRUCTURE_CONTROLLER
  | typeof C.STRUCTURE_LINK
  | typeof C.STRUCTURE_STORAGE
  | typeof C.STRUCTURE_TOWER
  | typeof C.STRUCTURE_OBSERVER
  | typeof C.STRUCTURE_POWER_BANK
  | typeof C.STRUCTURE_POWER_SPAWN
  | typeof C.STRUCTURE_EXTRACTOR
  | typeof C.STRUCTURE_LAB
  | typeof C.STRUCTURE_TERMINAL
  | typeof C.STRUCTURE_CONTAINER
  | typeof C.STRUCTURE_NUKER
  | typeof C.STRUCTURE_FACTORY
  | typeof C.STRUCTURE_INVADER_CORE;

/** Structure types that may be placed as construction sites. */
export type BuildableStructureConstant = keyof typeof C.CONSTRUCTION_COST;

/** Structure types whose count is limited by controller level. */
export type ControllerStructureConstant = keyof typeof C.CONTROLLER_STRUCTURES;

export type ObstacleObjectType = (typeof C.OBSTACLE_OBJECT_TYPES)[number];

/** Controller levels that have an upgrade threshold. */
export type ControllerLevel = keyof typeof C.CONTROLLER_DOWNGRADE;

// ---------------------------------------------------------------------------
// Resources

export type ResourceConstant = (typeof C.RESOURCES_ALL)[number];

export type MineralConstant =
  | typeof C.RESOURCE_HYDROGEN
  | typeof C.RESOURCE_OXYGEN
  | typeof C.RESOURCE_UTRIUM
  | typeof C.RESOURCE_LEMERGIUM
  | typeof C.RESOURCE_KEANIUM
  | typeof C.RESOURCE_ZYNTHIUM
  | typeof C.RESOURCE_CATALYST;

/** Every lab reaction product (including ghodium). */
export type MineralCompoundConstant = ValueOf<{
  [K in keyof typeof C.REACTIONS]: ValueOf<(typeof C.REACTIONS)[K]>;
}>;

/** Every lab reagent that participates in a reaction. */
export type ReactionReagentConstant = keyof typeof C.REACTIONS;

/** Compounds with a defined reaction time. */
export type ReactionProductConstant = keyof typeof C.REACTION_TIME;

/** Compounds usable for boosting a given body part. */
export type MineralBoostConstant = ValueOf<{
  [K in BoostedBodyPartConstant]: keyof (typeof C.BOOSTS)[K];
}>;

/** Boost effect method names (e.g. `harvest`, `fatigue`, `damage`). */
export type BoostMethodName = ValueOf<{
  [K in BoostedBodyPartConstant]: ValueOf<{
    [B in keyof (typeof C.BOOSTS)[K]]: keyof (typeof C.BOOSTS)[K][B];
  }>;
}>;

export type DepositConstant =
  | typeof C.RESOURCE_SILICON
  | typeof C.RESOURCE_METAL
  | typeof C.RESOURCE_BIOMASS
  | typeof C.RESOURCE_MIST;

/** Resources a factory can produce. */
export type FactoryProductConstant = keyof typeof C.COMMODITIES;
export type CommodityRecipe = ValueOf<typeof C.COMMODITIES>;

export type InterShardResourceConstant = (typeof C.INTERSHARD_RESOURCES)[number];
export type MarketResourceConstant = ResourceConstant | InterShardResourceConstant;

export type OrderTypeConstant = typeof C.ORDER_SELL | typeof C.ORDER_BUY;

export type DensityConstant =
  typeof C.DENSITY_LOW | typeof C.DENSITY_MODERATE | typeof C.DENSITY_HIGH | typeof C.DENSITY_ULTRA;

// ---------------------------------------------------------------------------
// Powers & effects

export type PowerConstant = keyof typeof C.POWER_INFO;
export type PowerInfo = ValueOf<typeof C.POWER_INFO>;
export type PowerClassConstant = ValueOf<typeof C.POWER_CLASS>;
export type NaturalEffectConstant =
  typeof C.EFFECT_INVULNERABILITY | typeof C.EFFECT_COLLAPSE_TIMER;
export type EffectConstant = PowerConstant | NaturalEffectConstant;

// ---------------------------------------------------------------------------
// Events

export type EventConstant =
  | typeof C.EVENT_ATTACK
  | typeof C.EVENT_OBJECT_DESTROYED
  | typeof C.EVENT_ATTACK_CONTROLLER
  | typeof C.EVENT_BUILD
  | typeof C.EVENT_HARVEST
  | typeof C.EVENT_HEAL
  | typeof C.EVENT_REPAIR
  | typeof C.EVENT_RESERVE_CONTROLLER
  | typeof C.EVENT_UPGRADE_CONTROLLER
  | typeof C.EVENT_EXIT
  | typeof C.EVENT_POWER
  | typeof C.EVENT_TRANSFER;

export type EventAttackType =
  | typeof C.EVENT_ATTACK_TYPE_MELEE
  | typeof C.EVENT_ATTACK_TYPE_RANGED
  | typeof C.EVENT_ATTACK_TYPE_RANGED_MASS
  | typeof C.EVENT_ATTACK_TYPE_DISMANTLE
  | typeof C.EVENT_ATTACK_TYPE_HIT_BACK
  | typeof C.EVENT_ATTACK_TYPE_NUKE;

export type EventHealType = typeof C.EVENT_HEAL_TYPE_MELEE | typeof C.EVENT_HEAL_TYPE_RANGED;

// ---------------------------------------------------------------------------
// Constants namespace

/** The shape of the complete constants module, e.g. for injecting into a sandbox global scope. */
export type Constants = typeof C;
