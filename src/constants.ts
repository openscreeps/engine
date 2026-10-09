/*
 * Ported from @screeps/common lib/constants.js.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
 * provided that the above copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
 * AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
 * OF THIS SOFTWARE.
 */

export const OK = 0;
export const ERR_NOT_OWNER = -1;
export const ERR_NO_PATH = -2;
export const ERR_NAME_EXISTS = -3;
export const ERR_BUSY = -4;
export const ERR_NOT_FOUND = -5;
export const ERR_NOT_ENOUGH_ENERGY = -6;
export const ERR_NOT_ENOUGH_RESOURCES = -6;
export const ERR_INVALID_TARGET = -7;
export const ERR_FULL = -8;
export const ERR_NOT_IN_RANGE = -9;
export const ERR_INVALID_ARGS = -10;
export const ERR_TIRED = -11;
export const ERR_NO_BODYPART = -12;
export const ERR_NOT_ENOUGH_EXTENSIONS = -6;
export const ERR_RCL_NOT_ENOUGH = -14;
export const ERR_GCL_NOT_ENOUGH = -15;
export const ERR_ACCESS_DENIED = -16;

export const FIND_EXIT_TOP = 1;
export const FIND_EXIT_RIGHT = 3;
export const FIND_EXIT_BOTTOM = 5;
export const FIND_EXIT_LEFT = 7;
export const FIND_EXIT = 10;
export const FIND_CREEPS = 101;
export const FIND_MY_CREEPS = 102;
export const FIND_HOSTILE_CREEPS = 103;
export const FIND_SOURCES_ACTIVE = 104;
export const FIND_SOURCES = 105;
export const FIND_DROPPED_RESOURCES = 106;
export const FIND_STRUCTURES = 107;
export const FIND_MY_STRUCTURES = 108;
export const FIND_HOSTILE_STRUCTURES = 109;
export const FIND_FLAGS = 110;
export const FIND_CONSTRUCTION_SITES = 111;
export const FIND_MY_SPAWNS = 112;
export const FIND_HOSTILE_SPAWNS = 113;
export const FIND_MY_CONSTRUCTION_SITES = 114;
export const FIND_HOSTILE_CONSTRUCTION_SITES = 115;
export const FIND_MINERALS = 116;
export const FIND_NUKES = 117;
export const FIND_TOMBSTONES = 118;
export const FIND_POWER_CREEPS = 119;
export const FIND_MY_POWER_CREEPS = 120;
export const FIND_HOSTILE_POWER_CREEPS = 121;
export const FIND_DEPOSITS = 122;
export const FIND_RUINS = 123;

export const TOP = 1;
export const TOP_RIGHT = 2;
export const RIGHT = 3;
export const BOTTOM_RIGHT = 4;
export const BOTTOM = 5;
export const BOTTOM_LEFT = 6;
export const LEFT = 7;
export const TOP_LEFT = 8;

export const COLOR_RED = 1;
export const COLOR_PURPLE = 2;
export const COLOR_BLUE = 3;
export const COLOR_CYAN = 4;
export const COLOR_GREEN = 5;
export const COLOR_YELLOW = 6;
export const COLOR_ORANGE = 7;
export const COLOR_BROWN = 8;
export const COLOR_GREY = 9;
export const COLOR_WHITE = 10;

export const LOOK_CREEPS = 'creep';
export const LOOK_ENERGY = 'energy';
export const LOOK_RESOURCES = 'resource';
export const LOOK_SOURCES = 'source';
export const LOOK_MINERALS = 'mineral';
export const LOOK_DEPOSITS = 'deposit';
export const LOOK_STRUCTURES = 'structure';
export const LOOK_FLAGS = 'flag';
export const LOOK_CONSTRUCTION_SITES = 'constructionSite';
export const LOOK_NUKES = 'nuke';
export const LOOK_TERRAIN = 'terrain';
export const LOOK_TOMBSTONES = 'tombstone';
export const LOOK_POWER_CREEPS = 'powerCreep';
export const LOOK_RUINS = 'ruin';

export const OBSTACLE_OBJECT_TYPES = [
  'spawn',
  'creep',
  'powerCreep',
  'source',
  'mineral',
  'deposit',
  'controller',
  'constructedWall',
  'extension',
  'link',
  'storage',
  'tower',
  'observer',
  'powerSpawn',
  'powerBank',
  'lab',
  'terminal',
  'nuker',
  'factory',
  'invaderCore',
] as const;

export const MOVE = 'move';
export const WORK = 'work';
export const CARRY = 'carry';
export const ATTACK = 'attack';
export const RANGED_ATTACK = 'ranged_attack';
export const TOUGH = 'tough';
export const HEAL = 'heal';
export const CLAIM = 'claim';

export const BODYPART_COST = {
  move: 50,
  work: 100,
  attack: 80,
  carry: 50,
  heal: 250,
  ranged_attack: 150,
  tough: 10,
  claim: 600,
} as const;

// WORLD_WIDTH and WORLD_HEIGHT constants are deprecated, please use Game.map.getWorldSize() instead
export const WORLD_WIDTH = 202;
export const WORLD_HEIGHT = 202;

export const CREEP_LIFE_TIME = 1500;
export const CREEP_CLAIM_LIFE_TIME = 600;
export const CREEP_CORPSE_RATE = 0.2;
export const CREEP_PART_MAX_ENERGY = 125;

export const CARRY_CAPACITY = 50;
export const HARVEST_POWER = 2;
export const HARVEST_MINERAL_POWER = 1;
export const HARVEST_DEPOSIT_POWER = 1;
export const REPAIR_POWER = 100;
export const DISMANTLE_POWER = 50;
export const BUILD_POWER = 5;
export const ATTACK_POWER = 30;
export const UPGRADE_CONTROLLER_POWER = 1;
export const RANGED_ATTACK_POWER = 10;
export const HEAL_POWER = 12;
export const RANGED_HEAL_POWER = 4;
export const REPAIR_COST = 0.01;
export const DISMANTLE_COST = 0.005;

export const RAMPART_DECAY_AMOUNT = 300;
export const RAMPART_DECAY_TIME = 100;
export const RAMPART_HITS = 1;
export const RAMPART_HITS_MAX = {
  2: 300000,
  3: 1000000,
  4: 3000000,
  5: 10000000,
  6: 30000000,
  7: 100000000,
  8: 300000000,
} as const;

export const ENERGY_REGEN_TIME = 300;
export const ENERGY_DECAY = 1000;

export const SPAWN_HITS = 5000;
export const SPAWN_ENERGY_START = 300;
export const SPAWN_ENERGY_CAPACITY = 300;
export const CREEP_SPAWN_TIME = 3;
export const SPAWN_RENEW_RATIO = 1.2;

export const SOURCE_ENERGY_CAPACITY = 3000;
export const SOURCE_ENERGY_NEUTRAL_CAPACITY = 1500;
export const SOURCE_ENERGY_KEEPER_CAPACITY = 4000;

export const WALL_HITS = 1;
export const WALL_HITS_MAX = 300000000;

export const EXTENSION_HITS = 1000;
export const EXTENSION_ENERGY_CAPACITY = {
  0: 50,
  1: 50,
  2: 50,
  3: 50,
  4: 50,
  5: 50,
  6: 50,
  7: 100,
  8: 200,
} as const;

export const ROAD_HITS = 5000;
export const ROAD_WEAROUT = 1;
export const ROAD_WEAROUT_POWER_CREEP = 100;
export const ROAD_DECAY_AMOUNT = 100;
export const ROAD_DECAY_TIME = 1000;

export const LINK_HITS = 1000;
export const LINK_HITS_MAX = 1000;
export const LINK_CAPACITY = 800;
export const LINK_COOLDOWN = 1;
export const LINK_LOSS_RATIO = 0.03;

export const STORAGE_CAPACITY = 1000000;
export const STORAGE_HITS = 10000;

export const STRUCTURE_SPAWN = 'spawn';
export const STRUCTURE_EXTENSION = 'extension';
export const STRUCTURE_ROAD = 'road';
export const STRUCTURE_WALL = 'constructedWall';
export const STRUCTURE_RAMPART = 'rampart';
export const STRUCTURE_KEEPER_LAIR = 'keeperLair';
export const STRUCTURE_PORTAL = 'portal';
export const STRUCTURE_CONTROLLER = 'controller';
export const STRUCTURE_LINK = 'link';
export const STRUCTURE_STORAGE = 'storage';
export const STRUCTURE_TOWER = 'tower';
export const STRUCTURE_OBSERVER = 'observer';
export const STRUCTURE_POWER_BANK = 'powerBank';
export const STRUCTURE_POWER_SPAWN = 'powerSpawn';
export const STRUCTURE_EXTRACTOR = 'extractor';
export const STRUCTURE_LAB = 'lab';
export const STRUCTURE_TERMINAL = 'terminal';
export const STRUCTURE_CONTAINER = 'container';
export const STRUCTURE_NUKER = 'nuker';
export const STRUCTURE_FACTORY = 'factory';
export const STRUCTURE_INVADER_CORE = 'invaderCore';

export const CONSTRUCTION_COST = {
  spawn: 15000,
  extension: 3000,
  road: 300,
  constructedWall: 1,
  rampart: 1,
  link: 5000,
  storage: 30000,
  tower: 5000,
  observer: 8000,
  powerSpawn: 100000,
  extractor: 5000,
  lab: 50000,
  terminal: 100000,
  container: 5000,
  nuker: 100000,
  factory: 100000,
} as const;
export const CONSTRUCTION_COST_ROAD_SWAMP_RATIO = 5;
export const CONSTRUCTION_COST_ROAD_WALL_RATIO = 150;

export const CONTROLLER_LEVELS = {
  1: 200,
  2: 45000,
  3: 135000,
  4: 405000,
  5: 1215000,
  6: 3645000,
  7: 10935000,
} as const;
export const CONTROLLER_STRUCTURES = {
  spawn: { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
  extension: { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
  link: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 3, 7: 4, 8: 6 },
  road: { 0: 2500, 1: 2500, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
  constructedWall: { 1: 0, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
  rampart: { 1: 0, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
  storage: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
  tower: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
  observer: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 },
  powerSpawn: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 },
  extractor: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1 },
  terminal: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1 },
  lab: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 3, 7: 6, 8: 10 },
  container: { 0: 5, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5, 8: 5 },
  nuker: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 },
  factory: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 1, 8: 1 },
} as const;
export const CONTROLLER_DOWNGRADE = {
  1: 20000,
  2: 10000,
  3: 20000,
  4: 40000,
  5: 80000,
  6: 120000,
  7: 150000,
  8: 200000,
} as const;
export const CONTROLLER_DOWNGRADE_RESTORE = 100;
export const CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD = 5000;
export const CONTROLLER_CLAIM_DOWNGRADE = 300;
export const CONTROLLER_RESERVE = 1;
export const CONTROLLER_RESERVE_MAX = 5000;
export const CONTROLLER_MAX_UPGRADE_PER_TICK = 15;
export const CONTROLLER_ATTACK_BLOCKED_UPGRADE = 1000;
export const CONTROLLER_NUKE_BLOCKED_UPGRADE = 200;

export const SAFE_MODE_DURATION = 20000;
export const SAFE_MODE_COOLDOWN = 50000;
export const SAFE_MODE_COST = 1000;

export const TOWER_HITS = 3000;
export const TOWER_CAPACITY = 1000;
export const TOWER_ENERGY_COST = 10;
export const TOWER_POWER_ATTACK = 600;
export const TOWER_POWER_HEAL = 400;
export const TOWER_POWER_REPAIR = 800;
export const TOWER_OPTIMAL_RANGE = 5;
export const TOWER_FALLOFF_RANGE = 20;
export const TOWER_FALLOFF = 0.75;

export const OBSERVER_HITS = 500;
export const OBSERVER_RANGE = 10;

export const POWER_BANK_HITS = 2000000;
export const POWER_BANK_CAPACITY_MAX = 5000;
export const POWER_BANK_CAPACITY_MIN = 500;
export const POWER_BANK_CAPACITY_CRIT = 0.3;
export const POWER_BANK_DECAY = 5000;
export const POWER_BANK_HIT_BACK = 0.5;

export const POWER_SPAWN_HITS = 5000;
export const POWER_SPAWN_ENERGY_CAPACITY = 5000;
export const POWER_SPAWN_POWER_CAPACITY = 100;
export const POWER_SPAWN_ENERGY_RATIO = 50;

export const EXTRACTOR_HITS = 500;
export const EXTRACTOR_COOLDOWN = 5;

export const LAB_HITS = 500;
export const LAB_MINERAL_CAPACITY = 3000;
export const LAB_ENERGY_CAPACITY = 2000;
export const LAB_BOOST_ENERGY = 20;
export const LAB_BOOST_MINERAL = 30;
export const LAB_COOLDOWN = 10; // not used
export const LAB_REACTION_AMOUNT = 5;
export const LAB_UNBOOST_ENERGY = 0;
export const LAB_UNBOOST_MINERAL = 15;

export const GCL_POW = 2.4;
export const GCL_MULTIPLY = 1000000;
export const GCL_NOVICE = 3;

export const MODE_SIMULATION = null;
export const MODE_WORLD = null;

export const TERRAIN_MASK_WALL = 1;
export const TERRAIN_MASK_SWAMP = 2;
export const TERRAIN_MASK_LAVA = 4;

export const MAX_CONSTRUCTION_SITES = 100;
export const MAX_CREEP_SIZE = 50;

export const MINERAL_REGEN_TIME = 50000;
export const MINERAL_MIN_AMOUNT = {
  H: 35000,
  O: 35000,
  L: 35000,
  K: 35000,
  Z: 35000,
  U: 35000,
  X: 35000,
} as const;
export const MINERAL_RANDOM_FACTOR = 2;

export const MINERAL_DENSITY = { 1: 15000, 2: 35000, 3: 70000, 4: 100000 } as const;
export const MINERAL_DENSITY_PROBABILITY = { 1: 0.1, 2: 0.5, 3: 0.9, 4: 1 } as const;
export const MINERAL_DENSITY_CHANGE = 0.05;

export const DENSITY_LOW = 1;
export const DENSITY_MODERATE = 2;
export const DENSITY_HIGH = 3;
export const DENSITY_ULTRA = 4;

export const DEPOSIT_EXHAUST_MULTIPLY = 0.001;
export const DEPOSIT_EXHAUST_POW = 1.2;
export const DEPOSIT_DECAY_TIME = 50000;

export const TERMINAL_CAPACITY = 300000;
export const TERMINAL_HITS = 3000;
export const TERMINAL_SEND_COST = 0.1;
export const TERMINAL_MIN_SEND = 100;
export const TERMINAL_COOLDOWN = 10;

export const CONTAINER_HITS = 250000;
export const CONTAINER_CAPACITY = 2000;
export const CONTAINER_DECAY = 5000;
export const CONTAINER_DECAY_TIME = 100;
export const CONTAINER_DECAY_TIME_OWNED = 500;

export const NUKER_HITS = 1000;
export const NUKER_COOLDOWN = 100000;
export const NUKER_ENERGY_CAPACITY = 300000;
export const NUKER_GHODIUM_CAPACITY = 5000;
export const NUKE_LAND_TIME = 50000;
export const NUKE_RANGE = 10;
export const NUKE_DAMAGE = { 0: 10000000, 2: 5000000 } as const;

export const FACTORY_HITS = 1000;
export const FACTORY_CAPACITY = 50000;

export const TOMBSTONE_DECAY_PER_PART = 5;
export const TOMBSTONE_DECAY_POWER_CREEP = 500;

export const RUIN_DECAY = 500;
export const RUIN_DECAY_STRUCTURES = { powerBank: 10 } as const;

export const PORTAL_DECAY = 30000;

export const ORDER_SELL = 'sell';
export const ORDER_BUY = 'buy';

export const MARKET_FEE = 0.05;

export const MARKET_MAX_ORDERS = 300;
export const MARKET_ORDER_LIFE_TIME = 2592000000; // 1000 * 60 * 60 * 24 * 30

export const FLAGS_LIMIT = 10000;

export const SUBSCRIPTION_TOKEN = 'token';
export const CPU_UNLOCK = 'cpuUnlock';
export const PIXEL = 'pixel';
export const ACCESS_KEY = 'accessKey';

export const PIXEL_CPU_COST = 10000;

export const RESOURCE_ENERGY = 'energy';
export const RESOURCE_POWER = 'power';

export const RESOURCE_HYDROGEN = 'H';
export const RESOURCE_OXYGEN = 'O';
export const RESOURCE_UTRIUM = 'U';
export const RESOURCE_LEMERGIUM = 'L';
export const RESOURCE_KEANIUM = 'K';
export const RESOURCE_ZYNTHIUM = 'Z';
export const RESOURCE_CATALYST = 'X';
export const RESOURCE_GHODIUM = 'G';

export const RESOURCE_SILICON = 'silicon';
export const RESOURCE_METAL = 'metal';
export const RESOURCE_BIOMASS = 'biomass';
export const RESOURCE_MIST = 'mist';

export const RESOURCE_HYDROXIDE = 'OH';
export const RESOURCE_ZYNTHIUM_KEANITE = 'ZK';
export const RESOURCE_UTRIUM_LEMERGITE = 'UL';

export const RESOURCE_UTRIUM_HYDRIDE = 'UH';
export const RESOURCE_UTRIUM_OXIDE = 'UO';
export const RESOURCE_KEANIUM_HYDRIDE = 'KH';
export const RESOURCE_KEANIUM_OXIDE = 'KO';
export const RESOURCE_LEMERGIUM_HYDRIDE = 'LH';
export const RESOURCE_LEMERGIUM_OXIDE = 'LO';
export const RESOURCE_ZYNTHIUM_HYDRIDE = 'ZH';
export const RESOURCE_ZYNTHIUM_OXIDE = 'ZO';
export const RESOURCE_GHODIUM_HYDRIDE = 'GH';
export const RESOURCE_GHODIUM_OXIDE = 'GO';

export const RESOURCE_UTRIUM_ACID = 'UH2O';
export const RESOURCE_UTRIUM_ALKALIDE = 'UHO2';
export const RESOURCE_KEANIUM_ACID = 'KH2O';
export const RESOURCE_KEANIUM_ALKALIDE = 'KHO2';
export const RESOURCE_LEMERGIUM_ACID = 'LH2O';
export const RESOURCE_LEMERGIUM_ALKALIDE = 'LHO2';
export const RESOURCE_ZYNTHIUM_ACID = 'ZH2O';
export const RESOURCE_ZYNTHIUM_ALKALIDE = 'ZHO2';
export const RESOURCE_GHODIUM_ACID = 'GH2O';
export const RESOURCE_GHODIUM_ALKALIDE = 'GHO2';

export const RESOURCE_CATALYZED_UTRIUM_ACID = 'XUH2O';
export const RESOURCE_CATALYZED_UTRIUM_ALKALIDE = 'XUHO2';
export const RESOURCE_CATALYZED_KEANIUM_ACID = 'XKH2O';
export const RESOURCE_CATALYZED_KEANIUM_ALKALIDE = 'XKHO2';
export const RESOURCE_CATALYZED_LEMERGIUM_ACID = 'XLH2O';
export const RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE = 'XLHO2';
export const RESOURCE_CATALYZED_ZYNTHIUM_ACID = 'XZH2O';
export const RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE = 'XZHO2';
export const RESOURCE_CATALYZED_GHODIUM_ACID = 'XGH2O';
export const RESOURCE_CATALYZED_GHODIUM_ALKALIDE = 'XGHO2';

export const RESOURCE_OPS = 'ops';

export const RESOURCE_UTRIUM_BAR = 'utrium_bar';
export const RESOURCE_LEMERGIUM_BAR = 'lemergium_bar';
export const RESOURCE_ZYNTHIUM_BAR = 'zynthium_bar';
export const RESOURCE_KEANIUM_BAR = 'keanium_bar';
export const RESOURCE_GHODIUM_MELT = 'ghodium_melt';
export const RESOURCE_OXIDANT = 'oxidant';
export const RESOURCE_REDUCTANT = 'reductant';
export const RESOURCE_PURIFIER = 'purifier';
export const RESOURCE_BATTERY = 'battery';

export const RESOURCE_COMPOSITE = 'composite';
export const RESOURCE_CRYSTAL = 'crystal';
export const RESOURCE_LIQUID = 'liquid';

export const RESOURCE_WIRE = 'wire';
export const RESOURCE_SWITCH = 'switch';
export const RESOURCE_TRANSISTOR = 'transistor';
export const RESOURCE_MICROCHIP = 'microchip';
export const RESOURCE_CIRCUIT = 'circuit';
export const RESOURCE_DEVICE = 'device';

export const RESOURCE_CELL = 'cell';
export const RESOURCE_PHLEGM = 'phlegm';
export const RESOURCE_TISSUE = 'tissue';
export const RESOURCE_MUSCLE = 'muscle';
export const RESOURCE_ORGANOID = 'organoid';
export const RESOURCE_ORGANISM = 'organism';

export const RESOURCE_ALLOY = 'alloy';
export const RESOURCE_TUBE = 'tube';
export const RESOURCE_FIXTURES = 'fixtures';
export const RESOURCE_FRAME = 'frame';
export const RESOURCE_HYDRAULICS = 'hydraulics';
export const RESOURCE_MACHINE = 'machine';

export const RESOURCE_CONDENSATE = 'condensate';
export const RESOURCE_CONCENTRATE = 'concentrate';
export const RESOURCE_EXTRACT = 'extract';
export const RESOURCE_SPIRIT = 'spirit';
export const RESOURCE_EMANATION = 'emanation';
export const RESOURCE_ESSENCE = 'essence';

export const REACTIONS = {
  H: { O: 'OH', L: 'LH', K: 'KH', U: 'UH', Z: 'ZH', G: 'GH' },
  O: { H: 'OH', L: 'LO', K: 'KO', U: 'UO', Z: 'ZO', G: 'GO' },
  Z: { K: 'ZK', H: 'ZH', O: 'ZO' },
  L: { U: 'UL', H: 'LH', O: 'LO' },
  K: { Z: 'ZK', H: 'KH', O: 'KO' },
  G: { H: 'GH', O: 'GO' },
  U: { L: 'UL', H: 'UH', O: 'UO' },
  OH: {
    UH: 'UH2O',
    UO: 'UHO2',
    ZH: 'ZH2O',
    ZO: 'ZHO2',
    KH: 'KH2O',
    KO: 'KHO2',
    LH: 'LH2O',
    LO: 'LHO2',
    GH: 'GH2O',
    GO: 'GHO2',
  },
  X: {
    UH2O: 'XUH2O',
    UHO2: 'XUHO2',
    LH2O: 'XLH2O',
    LHO2: 'XLHO2',
    KH2O: 'XKH2O',
    KHO2: 'XKHO2',
    ZH2O: 'XZH2O',
    ZHO2: 'XZHO2',
    GH2O: 'XGH2O',
    GHO2: 'XGHO2',
  },
  ZK: { UL: 'G' },
  UL: { ZK: 'G' },
  LH: { OH: 'LH2O' },
  ZH: { OH: 'ZH2O' },
  GH: { OH: 'GH2O' },
  KH: { OH: 'KH2O' },
  UH: { OH: 'UH2O' },
  LO: { OH: 'LHO2' },
  ZO: { OH: 'ZHO2' },
  KO: { OH: 'KHO2' },
  UO: { OH: 'UHO2' },
  GO: { OH: 'GHO2' },
  LH2O: { X: 'XLH2O' },
  KH2O: { X: 'XKH2O' },
  ZH2O: { X: 'XZH2O' },
  UH2O: { X: 'XUH2O' },
  GH2O: { X: 'XGH2O' },
  LHO2: { X: 'XLHO2' },
  UHO2: { X: 'XUHO2' },
  KHO2: { X: 'XKHO2' },
  ZHO2: { X: 'XZHO2' },
  GHO2: { X: 'XGHO2' },
} as const;

export const BOOSTS = {
  work: {
    UO: { harvest: 3 },
    UHO2: { harvest: 5 },
    XUHO2: { harvest: 7 },
    LH: { build: 1.5, repair: 1.5 },
    LH2O: { build: 1.8, repair: 1.8 },
    XLH2O: { build: 2, repair: 2 },
    ZH: { dismantle: 2 },
    ZH2O: { dismantle: 3 },
    XZH2O: { dismantle: 4 },
    GH: { upgradeController: 1.5 },
    GH2O: { upgradeController: 1.8 },
    XGH2O: { upgradeController: 2 },
  },
  attack: {
    UH: { attack: 2 },
    UH2O: { attack: 3 },
    XUH2O: { attack: 4 },
  },
  ranged_attack: {
    KO: { rangedAttack: 2, rangedMassAttack: 2 },
    KHO2: { rangedAttack: 3, rangedMassAttack: 3 },
    XKHO2: { rangedAttack: 4, rangedMassAttack: 4 },
  },
  heal: {
    LO: { heal: 2, rangedHeal: 2 },
    LHO2: { heal: 3, rangedHeal: 3 },
    XLHO2: { heal: 4, rangedHeal: 4 },
  },
  carry: {
    KH: { capacity: 2 },
    KH2O: { capacity: 3 },
    XKH2O: { capacity: 4 },
  },
  move: {
    ZO: { fatigue: 2 },
    ZHO2: { fatigue: 3 },
    XZHO2: { fatigue: 4 },
  },
  tough: {
    GO: { damage: 0.7 },
    GHO2: { damage: 0.5 },
    XGHO2: { damage: 0.3 },
  },
} as const;

export const REACTION_TIME = {
  OH: 20,
  ZK: 5,
  UL: 5,
  G: 5,
  UH: 10,
  UH2O: 5,
  XUH2O: 60,
  UO: 10,
  UHO2: 5,
  XUHO2: 60,
  KH: 10,
  KH2O: 5,
  XKH2O: 60,
  KO: 10,
  KHO2: 5,
  XKHO2: 60,
  LH: 15,
  LH2O: 10,
  XLH2O: 65,
  LO: 10,
  LHO2: 5,
  XLHO2: 60,
  ZH: 20,
  ZH2O: 40,
  XZH2O: 160,
  ZO: 10,
  ZHO2: 5,
  XZHO2: 60,
  GH: 10,
  GH2O: 15,
  XGH2O: 80,
  GO: 10,
  GHO2: 30,
  XGHO2: 150,
} as const;

export const PORTAL_UNSTABLE = 864000000; // 10 * 24 * 3600 * 1000
export const PORTAL_MIN_TIMEOUT = 1036800000; // 12 * 24 * 3600 * 1000
export const PORTAL_MAX_TIMEOUT = 1900800000; // 22 * 24 * 3600 * 1000

export const POWER_BANK_RESPAWN_TIME = 50000;

export const INVADERS_ENERGY_GOAL = 100000;

export const SYSTEM_USERNAME = 'Screeps';

// SIGN_NOVICE_AREA and SIGN_RESPAWN_AREA constants are deprecated, please use SIGN_PLANNED_AREA instead
export const SIGN_NOVICE_AREA =
  'A new Novice or Respawn Area is being planned somewhere in this sector. Please make sure all important rooms are reserved.';
export const SIGN_RESPAWN_AREA =
  'A new Novice or Respawn Area is being planned somewhere in this sector. Please make sure all important rooms are reserved.';
export const SIGN_PLANNED_AREA =
  'A new Novice or Respawn Area is being planned somewhere in this sector. Please make sure all important rooms are reserved.';

export const EVENT_ATTACK = 1;
export const EVENT_OBJECT_DESTROYED = 2;
export const EVENT_ATTACK_CONTROLLER = 3;
export const EVENT_BUILD = 4;
export const EVENT_HARVEST = 5;
export const EVENT_HEAL = 6;
export const EVENT_REPAIR = 7;
export const EVENT_RESERVE_CONTROLLER = 8;
export const EVENT_UPGRADE_CONTROLLER = 9;
export const EVENT_EXIT = 10;
export const EVENT_POWER = 11;
export const EVENT_TRANSFER = 12;

export const EVENT_ATTACK_TYPE_MELEE = 1;
export const EVENT_ATTACK_TYPE_RANGED = 2;
export const EVENT_ATTACK_TYPE_RANGED_MASS = 3;
export const EVENT_ATTACK_TYPE_DISMANTLE = 4;
export const EVENT_ATTACK_TYPE_HIT_BACK = 5;
export const EVENT_ATTACK_TYPE_NUKE = 6;

export const EVENT_HEAL_TYPE_MELEE = 1;
export const EVENT_HEAL_TYPE_RANGED = 2;

export const POWER_LEVEL_MULTIPLY = 1000;
export const POWER_LEVEL_POW = 2;
export const POWER_CREEP_SPAWN_COOLDOWN = 28800000; // 8 * 3600 * 1000
export const POWER_CREEP_DELETE_COOLDOWN = 86400000; // 24 * 3600 * 1000
export const POWER_CREEP_MAX_LEVEL = 25;
export const POWER_CREEP_LIFE_TIME = 5000;

export const POWER_CLASS = { OPERATOR: 'operator' } as const;

export const PWR_GENERATE_OPS = 1;
export const PWR_OPERATE_SPAWN = 2;
export const PWR_OPERATE_TOWER = 3;
export const PWR_OPERATE_STORAGE = 4;
export const PWR_OPERATE_LAB = 5;
export const PWR_OPERATE_EXTENSION = 6;
export const PWR_OPERATE_OBSERVER = 7;
export const PWR_OPERATE_TERMINAL = 8;
export const PWR_DISRUPT_SPAWN = 9;
export const PWR_DISRUPT_TOWER = 10;
export const PWR_DISRUPT_SOURCE = 11;
export const PWR_SHIELD = 12;
export const PWR_REGEN_SOURCE = 13;
export const PWR_REGEN_MINERAL = 14;
export const PWR_DISRUPT_TERMINAL = 15;
export const PWR_OPERATE_POWER = 16;
export const PWR_FORTIFY = 17;
export const PWR_OPERATE_CONTROLLER = 18;
export const PWR_OPERATE_FACTORY = 19;

export const EFFECT_INVULNERABILITY = 1001;
export const EFFECT_COLLAPSE_TIMER = 1002;

export const INVADER_CORE_HITS = 100000;
export const INVADER_CORE_CREEP_SPAWN_TIME = { 0: 0, 1: 0, 2: 6, 3: 3, 4: 2, 5: 1 } as const;
export const INVADER_CORE_EXPAND_TIME = { 1: 4000, 2: 3500, 3: 3000, 4: 2500, 5: 2000 } as const;
export const INVADER_CORE_CONTROLLER_POWER = 2;
export const INVADER_CORE_CONTROLLER_DOWNGRADE = 5000;
export const STRONGHOLD_RAMPART_HITS = {
  0: 0,
  1: 100000,
  2: 200000,
  3: 500000,
  4: 1000000,
  5: 2000000,
} as const;
export const STRONGHOLD_DECAY_TICKS = 75000;
export const POWER_INFO = {
  1: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 50,
    effect: [1, 2, 4, 6, 8],
  },
  2: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 300,
    duration: 1000,
    range: 3,
    ops: 100,
    effect: [0.9, 0.7, 0.5, 0.35, 0.2],
  },
  3: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 10,
    duration: 100,
    range: 3,
    ops: 10,
    effect: [1.1, 1.2, 1.3, 1.4, 1.5],
  },
  4: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 800,
    duration: 1000,
    range: 3,
    ops: 100,
    effect: [500000, 1000000, 2000000, 4000000, 7000000],
  },
  5: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 50,
    duration: 1000,
    range: 3,
    ops: 10,
    effect: [2, 4, 6, 8, 10],
  },
  6: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 50,
    range: 3,
    ops: 2,
    effect: [0.2, 0.4, 0.6, 0.8, 1],
  },
  7: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 400,
    duration: [200, 400, 600, 800, 1000],
    range: 3,
    ops: 10,
  },
  8: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 500,
    duration: 1000,
    range: 3,
    ops: 100,
    effect: [0.9, 0.8, 0.7, 0.6, 0.5],
  },
  9: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 5,
    range: 20,
    ops: 10,
    duration: [1, 2, 3, 4, 5],
  },
  10: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 0,
    duration: 5,
    range: 50,
    ops: 10,
    effect: [0.9, 0.8, 0.7, 0.6, 0.5],
  },
  11: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 100,
    range: 3,
    ops: 100,
    duration: [100, 200, 300, 400, 500],
  },
  12: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    effect: [5000, 10000, 15000, 20000, 25000],
    duration: 50,
    cooldown: 20,
    energy: 100,
  },
  13: {
    className: 'operator',
    level: [10, 11, 12, 14, 22],
    cooldown: 100,
    duration: 300,
    range: 3,
    effect: [50, 100, 150, 200, 250],
    period: 15,
  },
  14: {
    className: 'operator',
    level: [10, 11, 12, 14, 22],
    cooldown: 100,
    duration: 100,
    range: 3,
    effect: [2, 4, 6, 8, 10],
    period: 10,
  },
  15: {
    className: 'operator',
    level: [20, 21, 22, 23, 24],
    cooldown: 8,
    duration: 10,
    range: 50,
    ops: [50, 40, 30, 20, 10],
  },
  16: {
    className: 'operator',
    level: [10, 11, 12, 14, 22],
    cooldown: 800,
    range: 3,
    duration: 1000,
    ops: 200,
    effect: [1, 2, 3, 4, 5],
  },
  17: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 5,
    range: 3,
    ops: 5,
    duration: [1, 2, 3, 4, 5],
  },
  18: {
    className: 'operator',
    level: [20, 21, 22, 23, 24],
    cooldown: 800,
    range: 3,
    duration: 1000,
    ops: 200,
    effect: [10, 20, 30, 40, 50],
  },
  19: {
    className: 'operator',
    level: [0, 2, 7, 14, 22],
    cooldown: 800,
    range: 3,
    duration: 1000,
    ops: 100,
  },
} as const;

export const BODYPARTS_ALL = [
  'move',
  'work',
  'carry',
  'attack',
  'ranged_attack',
  'tough',
  'heal',
  'claim',
] as const;
export const RESOURCES_ALL = [
  'energy',
  'power',
  'H',
  'O',
  'U',
  'K',
  'L',
  'Z',
  'X',
  'G',
  'OH',
  'ZK',
  'UL',
  'UH',
  'UO',
  'KH',
  'KO',
  'LH',
  'LO',
  'ZH',
  'ZO',
  'GH',
  'GO',
  'UH2O',
  'UHO2',
  'KH2O',
  'KHO2',
  'LH2O',
  'LHO2',
  'ZH2O',
  'ZHO2',
  'GH2O',
  'GHO2',
  'XUH2O',
  'XUHO2',
  'XKH2O',
  'XKHO2',
  'XLH2O',
  'XLHO2',
  'XZH2O',
  'XZHO2',
  'XGH2O',
  'XGHO2',
  'ops',
  'silicon',
  'metal',
  'biomass',
  'mist',
  'utrium_bar',
  'lemergium_bar',
  'zynthium_bar',
  'keanium_bar',
  'ghodium_melt',
  'oxidant',
  'reductant',
  'purifier',
  'battery',
  'composite',
  'crystal',
  'liquid',
  'wire',
  'switch',
  'transistor',
  'microchip',
  'circuit',
  'device',
  'cell',
  'phlegm',
  'tissue',
  'muscle',
  'organoid',
  'organism',
  'alloy',
  'tube',
  'fixtures',
  'frame',
  'hydraulics',
  'machine',
  'condensate',
  'concentrate',
  'extract',
  'spirit',
  'emanation',
  'essence',
] as const;
export const COLORS_ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const INTERSHARD_RESOURCES = ['token', 'cpuUnlock', 'pixel', 'accessKey'] as const;
export const COMMODITIES = {
  utrium_bar: {
    amount: 100,
    cooldown: 20,
    components: { U: 500, energy: 200 },
  },
  U: {
    amount: 500,
    cooldown: 20,
    components: { utrium_bar: 100, energy: 200 },
  },
  lemergium_bar: {
    amount: 100,
    cooldown: 20,
    components: { L: 500, energy: 200 },
  },
  L: {
    amount: 500,
    cooldown: 20,
    components: { lemergium_bar: 100, energy: 200 },
  },
  zynthium_bar: {
    amount: 100,
    cooldown: 20,
    components: { Z: 500, energy: 200 },
  },
  Z: {
    amount: 500,
    cooldown: 20,
    components: { zynthium_bar: 100, energy: 200 },
  },
  keanium_bar: {
    amount: 100,
    cooldown: 20,
    components: { K: 500, energy: 200 },
  },
  K: {
    amount: 500,
    cooldown: 20,
    components: { keanium_bar: 100, energy: 200 },
  },
  ghodium_melt: {
    amount: 100,
    cooldown: 20,
    components: { G: 500, energy: 200 },
  },
  G: {
    amount: 500,
    cooldown: 20,
    components: { ghodium_melt: 100, energy: 200 },
  },
  oxidant: {
    amount: 100,
    cooldown: 20,
    components: { O: 500, energy: 200 },
  },
  O: {
    amount: 500,
    cooldown: 20,
    components: { oxidant: 100, energy: 200 },
  },
  reductant: {
    amount: 100,
    cooldown: 20,
    components: { H: 500, energy: 200 },
  },
  H: {
    amount: 500,
    cooldown: 20,
    components: { reductant: 100, energy: 200 },
  },
  purifier: {
    amount: 100,
    cooldown: 20,
    components: { X: 500, energy: 200 },
  },
  X: {
    amount: 500,
    cooldown: 20,
    components: { purifier: 100, energy: 200 },
  },
  battery: {
    amount: 50,
    cooldown: 10,
    components: { energy: 600 },
  },
  energy: {
    amount: 500,
    cooldown: 10,
    components: { battery: 50 },
  },
  composite: {
    level: 1,
    amount: 20,
    cooldown: 50,
    components: { utrium_bar: 20, zynthium_bar: 20, energy: 20 },
  },
  crystal: {
    level: 2,
    amount: 6,
    cooldown: 21,
    components: { lemergium_bar: 6, keanium_bar: 6, purifier: 6, energy: 45 },
  },
  liquid: {
    level: 3,
    amount: 12,
    cooldown: 60,
    components: { oxidant: 12, reductant: 12, ghodium_melt: 12, energy: 90 },
  },
  wire: {
    amount: 20,
    cooldown: 8,
    components: { utrium_bar: 20, silicon: 100, energy: 40 },
  },
  switch: {
    level: 1,
    amount: 5,
    cooldown: 70,
    components: { wire: 40, oxidant: 95, utrium_bar: 35, energy: 20 },
  },
  transistor: {
    level: 2,
    amount: 1,
    cooldown: 59,
    components: { switch: 4, wire: 15, reductant: 85, energy: 8 },
  },
  microchip: {
    level: 3,
    amount: 1,
    cooldown: 250,
    components: { transistor: 2, composite: 50, wire: 117, purifier: 25, energy: 16 },
  },
  circuit: {
    level: 4,
    amount: 1,
    cooldown: 800,
    components: { microchip: 1, transistor: 5, switch: 4, oxidant: 115, energy: 32 },
  },
  device: {
    level: 5,
    amount: 1,
    cooldown: 600,
    components: { circuit: 1, microchip: 3, crystal: 110, ghodium_melt: 150, energy: 64 },
  },
  cell: {
    amount: 20,
    cooldown: 8,
    components: { lemergium_bar: 20, biomass: 100, energy: 40 },
  },
  phlegm: {
    level: 1,
    amount: 2,
    cooldown: 35,
    components: { cell: 20, oxidant: 36, lemergium_bar: 16, energy: 8 },
  },
  tissue: {
    level: 2,
    amount: 2,
    cooldown: 164,
    components: { phlegm: 10, cell: 10, reductant: 110, energy: 16 },
  },
  muscle: {
    level: 3,
    amount: 1,
    cooldown: 250,
    components: { tissue: 3, phlegm: 3, zynthium_bar: 50, reductant: 50, energy: 16 },
  },
  organoid: {
    level: 4,
    amount: 1,
    cooldown: 800,
    components: { muscle: 1, tissue: 5, purifier: 208, oxidant: 256, energy: 32 },
  },
  organism: {
    level: 5,
    amount: 1,
    cooldown: 600,
    components: { organoid: 1, liquid: 150, tissue: 6, cell: 310, energy: 64 },
  },
  alloy: {
    amount: 20,
    cooldown: 8,
    components: { zynthium_bar: 20, metal: 100, energy: 40 },
  },
  tube: {
    level: 1,
    amount: 2,
    cooldown: 45,
    components: { alloy: 40, zynthium_bar: 16, energy: 8 },
  },
  fixtures: {
    level: 2,
    amount: 1,
    cooldown: 115,
    components: { composite: 20, alloy: 41, oxidant: 161, energy: 8 },
  },
  frame: {
    level: 3,
    amount: 1,
    cooldown: 125,
    components: { fixtures: 2, tube: 4, reductant: 330, zynthium_bar: 31, energy: 16 },
  },
  hydraulics: {
    level: 4,
    amount: 1,
    cooldown: 800,
    components: { liquid: 150, fixtures: 3, tube: 15, purifier: 208, energy: 32 },
  },
  machine: {
    level: 5,
    amount: 1,
    cooldown: 600,
    components: { hydraulics: 1, frame: 2, fixtures: 3, tube: 12, energy: 64 },
  },
  condensate: {
    amount: 20,
    cooldown: 8,
    components: { keanium_bar: 20, mist: 100, energy: 40 },
  },
  concentrate: {
    level: 1,
    amount: 3,
    cooldown: 41,
    components: { condensate: 30, keanium_bar: 15, reductant: 54, energy: 12 },
  },
  extract: {
    level: 2,
    amount: 2,
    cooldown: 128,
    components: { concentrate: 10, condensate: 30, oxidant: 60, energy: 16 },
  },
  spirit: {
    level: 3,
    amount: 1,
    cooldown: 200,
    components: { extract: 2, concentrate: 6, reductant: 90, purifier: 20, energy: 16 },
  },
  emanation: {
    level: 4,
    amount: 1,
    cooldown: 800,
    components: { spirit: 2, extract: 2, concentrate: 3, keanium_bar: 112, energy: 32 },
  },
  essence: {
    level: 5,
    amount: 1,
    cooldown: 600,
    components: { emanation: 1, spirit: 3, crystal: 110, ghodium_melt: 150, energy: 64 },
  },
} as const;
