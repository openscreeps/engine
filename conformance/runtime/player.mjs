// These functions are serialized verbatim as player modules for BOTH engines. All observation
// construction happens inside the player realm; the adapter cannot manufacture API results.
export function playerModules(loop) {
  return {
    main: `let state = 123456789; Math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }; Date.now = () => 1700000000000; const kit = (${probeKit.toString()})(); module.exports.loop = ${loop.toString()};`,
    helper: 'global.helperLoads = (global.helperLoads || 0) + 1; module.exports = {answer: 42};',
    binary: { binary: 'AAECA/8=' },
  };
}

// Lossless JSON-safe observation encoding shared by the core API probes. Keeps undefined, holes,
// NaN/Infinity/-0, functions, typed arrays, prototypes and exception classes distinguishable, so
// JSON transport of Memory cannot collapse distinct upstream/local results into equal leaves.
export function probeKit() {
  const checksum = (values) => {
    let hash = 0;
    for (let i = 0; i < values.length; i++) hash = (Math.imul(hash, 31) + (values[i] | 0)) | 0;
    return hash;
  };
  function describe(value, depth = 0) {
    switch (typeof value) {
      case 'undefined':
        return { undefined: true };
      case 'number':
        if (Number.isNaN(value)) return { number: 'NaN' };
        if (value === Infinity || value === -Infinity) return { number: String(value) };
        if (Object.is(value, -0)) return { number: '-0' };
        return value;
      case 'bigint':
        return { bigint: String(value) };
      case 'symbol':
        return { symbol: String(value) };
      case 'function':
        return { function: value.name, length: value.length };
      case 'string':
      case 'boolean':
        return value;
    }
    if (value === null) return null;
    if (depth > 5) return { depthLimit: Object.prototype.toString.call(value) };
    if (value instanceof RoomPosition) {
      const own = {};
      for (const key of Object.keys(value)) own[key] = describe(value[key], depth + 1);
      return { pos: String(value), packed: value.__packedPos, own };
    }
    if (value instanceof Room) return { room: value.name };
    if (value instanceof Flag) return { flag: value.name };
    if (ArrayBuffer.isView(value))
      return {
        typed: value.constructor.name,
        length: value.length,
        checksum: checksum(value),
        head: Array.from(value.subarray(0, 4)),
      };
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++)
        out.push(i in value ? describe(value[i], depth + 1) : { hole: true });
      return out;
    }
    if (typeof value.id === 'string' && value.pos instanceof RoomPosition)
      return { object: value.id };
    const out = {};
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype)
      out['[[Prototype]]'] =
        proto === null
          ? null
          : typeof proto.constructor === 'function'
            ? proto.constructor.name
            : '?';
    for (const key of Object.keys(value)) out[key] = describe(value[key], depth + 1);
    return out;
  }
  function attempt(fn) {
    try {
      return { value: describe(fn()) };
    } catch (error) {
      return {
        throws:
          error instanceof Error ? { name: error.name, message: error.message } : describe(error),
      };
    }
  }
  return { describe, attempt };
}

export function gameplay() {
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      return { throws: { name: error.name, message: error.message } };
    }
  };
  const room = Game.rooms.W1N1;
  const c = Game.creeps.worker;
  const source = Game.getObjectById('source');
  const container = Game.getObjectById('container');
  const ctrl = Game.getObjectById('controller');
  const records = {};
  const add = (name, fn) => {
    records[name] = attempt(fn);
  };
  for (const name of ['worker', 'hostile', 'tired', 'spawning', 'noMove', 'empty', 'broken']) {
    const creep = Game.getObjectById(name);
    for (const [action, args] of Object.entries({
      move: [0],
      harvest: [null],
      attack: [null],
      rangedAttack: [null],
      heal: [null],
      rangedHeal: [null],
      build: [null],
      repair: [null],
      upgradeController: [null],
      claimController: [null],
      transfer: [null, 'invalid', -1],
      withdraw: [null, 'invalid', -1],
      drop: ['invalid', -1],
      pickup: [null],
      pull: [null],
    }))
      add(`precedence/${name}/${action}`, () => creep[action](...args));
  }
  for (const [name, fn] of Object.entries({
    harvestSource: () => c.harvest(source),
    harvestDryFar: () => c.harvest(Game.getObjectById('drySource')),
    harvestMineral: () => c.harvest(Game.getObjectById('mineral')),
    harvestDeposit: () => c.harvest(Game.getObjectById('deposit')),
    transferZero: () => c.transfer(container, RESOURCE_ENERGY, 0),
    transferNegative: () => c.transfer(container, RESOURCE_ENERGY, -2),
    transferResource: () => c.transfer(container, 'invalid', 1),
    transferAmount: () => c.transfer(container, RESOURCE_ENERGY, 999),
    transferValid: () => c.transfer(container, RESOURCE_ENERGY, 3),
    withdrawValid: () => c.withdraw(container, RESOURCE_ENERGY, 4),
    dropEnergy: () => c.drop(RESOURCE_ENERGY, 2),
    dropHydrogen: () => c.drop(RESOURCE_HYDROGEN, 1),
    pickup: () => c.pickup(Game.getObjectById('drop')),
    attackHostile: () => c.attack(Game.getObjectById('hostile')),
    healSelf: () => c.heal(c),
    build: () => c.build(Game.getObjectById('site')),
    repair: () => c.repair(Game.getObjectById('road')),
    upgrade: () => c.upgradeController(ctrl),
    sayFirst: () => c.say('first', true),
    sayLast: () => c.say('last', false),
    moveFirst: () => c.move(RIGHT),
    moveReplace: () => c.move(BOTTOM),
    cancelMove: () => c.cancelOrder('move'),
    cancelMissing: () => c.cancelOrder('move'),
    moveFinal: () => c.move(LEFT),
    spawnBadBody: () => Game.spawns.Spawn1.spawnCreep(['bad'], 'born'),
    spawnBadName: () => Game.spawns.Spawn1.spawnCreep([MOVE], ''),
    spawnDry: () => Game.spawns.Spawn1.spawnCreep([MOVE], 'born', { dryRun: true }),
    spawnFirst: () => Game.spawns.Spawn1.spawnCreep([MOVE], 'born', { directions: [RIGHT] }),
    spawnReplace: () =>
      Game.spawns.Spawn1.spawnCreep([WORK, MOVE], 'replacement', {
        memory: { role: 'probe' },
        directions: [BOTTOM],
      }),
    towerBadTarget: () => Game.getObjectById('tower').attack(null),
    towerAttack: () => Game.getObjectById('tower').attack(Game.getObjectById('hostile')),
    linkBadTarget: () => Game.getObjectById('link').transferEnergy(null),
    linkTransfer: () => Game.getObjectById('link').transferEnergy(Game.getObjectById('link2'), 50),
    labBadTarget: () => Game.getObjectById('lab').boostCreep(null),
    terminalBadResource: () => Game.getObjectById('terminal').send('invalid', 5, 'W2N1'),
    terminalBadAmount: () => Game.getObjectById('terminal').send(RESOURCE_HYDROGEN, -1, 'W2N1'),
    terminalSend: () =>
      Game.getObjectById('terminal').send(RESOURCE_HYDROGEN, 5, 'W2N1', 'fixture'),
    siteBadCoordinates: () => room.createConstructionSite(-1, 0, STRUCTURE_ROAD),
    flagBadColor: () => room.createFlag(15, 15, 'Probe', -1),
    flagCreate: () => room.createFlag(15, 15, 'Probe', COLOR_RED, COLOR_BLUE),
    flagColor: () => Game.flags.Flag1.setColor(COLOR_GREEN, COLOR_YELLOW),
    flagMove: () => Game.flags.Flag1.setPosition(16, 16),
    notify: () => Game.notify('fixture', 5),
    marketBadDeal: () => Game.market.deal('missing', 1, 'W1N1'),
    marketBadOrder: () =>
      Game.market.createOrder({
        type: 'bad',
        resourceType: RESOURCE_ENERGY,
        price: 1,
        totalAmount: 10,
        roomName: 'W1N1',
      }),
    serializedTarget: () =>
      c.harvest({ id: 'a'.repeat(24), pos: { x: 10, y: 10, roomName: 'W1N1' } }),
  }))
    add(`actions/${name}`, fn);
  const properties = {};
  for (const id of [
    'worker',
    'hostile',
    'spawning',
    'controller',
    'spawn',
    'source',
    'drySource',
    'mineral',
    'deposit',
    'drop',
    'container',
    'tower',
    'link',
    'lab',
    'terminal',
    'site',
    'road',
    'tombstone',
    'ruin',
  ]) {
    const object = Game.getObjectById(id);
    properties[id] = {
      json: attempt(() => JSON.parse(JSON.stringify(object))),
      keys: Object.keys(object),
      constructor: object.constructor.name,
      pos: object.pos && [object.pos.x, object.pos.y, object.pos.roomName, object.pos.toString()],
      existsInRoom: object.room === room,
    };
    if (object.store) {
      properties[id].store = {
        keys: Object.keys(object.store),
        missing: object.store.invalid,
        methods: {},
      };
      for (const method of ['getCapacity', 'getUsedCapacity', 'getFreeCapacity']) {
        properties[id].store.methods[method] = [
          undefined,
          RESOURCE_ENERGY,
          RESOURCE_HYDROGEN,
          'invalid',
        ].map((resource) => attempt(() => object.store[method](resource)));
      }
    }
  }
  const finds = {};
  for (const type of [
    FIND_CREEPS,
    FIND_MY_CREEPS,
    FIND_HOSTILE_CREEPS,
    FIND_STRUCTURES,
    FIND_MY_STRUCTURES,
    FIND_SOURCES,
    FIND_SOURCES_ACTIVE,
    FIND_MINERALS,
    FIND_DEPOSITS,
    FIND_DROPPED_RESOURCES,
    FIND_CONSTRUCTION_SITES,
    FIND_FLAGS,
    FIND_TOMBSTONES,
    FIND_RUINS,
  ]) {
    finds[type] = room.find(type).map((object) => object.id || object.name);
  }
  const pos = new RoomPosition(11, 11, 'W1N1');
  const positions = {
    range: pos.getRangeTo(source),
    near: pos.isNearTo(source),
    equal: pos.isEqualTo(c),
    direction: pos.getDirectionTo(source),
    closestRange: pos.findClosestByRange(FIND_SOURCES).id,
    inRange: pos.findInRange(FIND_STRUCTURES, 1).map((object) => object.id),
    lookAt: room
      .lookAt(11, 11)
      .map((entry) => (entry.type === 'creep' ? { type: entry.type, id: entry.creep.id } : entry)),
    lookFor: room.lookForAt(LOOK_CREEPS, pos).map((object) => object.id),
    invalidPositions: [
      [-1, 0],
      [50, 0],
      [0, -1],
      [0, 50],
      ['1', 2],
    ].map(([x, y]) => attempt(() => new RoomPosition(x, y, 'W1N1').toString())),
    serialize: Room.serializePath([
      { x: 12, y: 11, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 12, dx: 0, dy: 1, direction: BOTTOM },
    ]),
    deserialize: Room.deserializePath('121135'),
  };
  PathFinder.use(false);
  const path = room.findPath(pos, new RoomPosition(15, 14, 'W1N1'), { ignoreCreeps: true });
  positions.path = path;
  positions.closestPath = pos.findClosestByPath(FIND_SOURCES, { ignoreCreeps: true }).id;
  add('actions/moveByPath', () => c.moveByPath(path));
  add('actions/moveByPathInvalid', () => c.moveByPath('bad'));
  add('actions/moveToLegacy', () => c.moveTo(15, 14, { ignoreCreeps: true, reusePath: 0 }));
  add('actions/moveFinalAfterPath', () => c.move(LEFT));
  const matrix = new PathFinder.CostMatrix();
  matrix.set(1, 2, 260);
  matrix.set(3, 4, -2);
  matrix.set(5.9, 6.9, 7.9);
  positions.matrix = {
    cells: [matrix.get(1, 2), matrix.get(3, 4), matrix.get(5, 6)],
    clone: matrix.clone().serialize(),
    serialized: PathFinder.CostMatrix.deserialize(matrix.serialize()).serialize(),
  };
  positions.emptySearch = PathFinder.search(pos, []);
  const map = {
    terrain: [
      Game.map.getRoomTerrain('W1N1').get(11, 11),
      Game.map.getRoomTerrain('W1N1').getRawBuffer()[0],
    ],
    exits: Game.map.describeExits('W1N1'),
    distance: Game.map.getRoomLinearDistance('W1N1', 'W2N1'),
    worldSize: Game.map.getWorldSize(),
    route: Game.map.findRoute('W1N1', 'W2N1'),
    exit: room.findExitTo('W2N1'),
    status: Game.map.getRoomStatus('W1N1'),
  };
  const market = {
    credits: Game.market.credits,
    orders: Game.market.getAllOrders({ resourceType: RESOURCE_HYDROGEN }),
    history: Game.market.getHistory(RESOURCE_HYDROGEN),
    incoming: Game.market.incomingTransactions,
    outgoing: Game.market.outgoingTransactions,
    transactionCost: Game.market.calcTransactionCost(100, 'W1N1', 'W2N1'),
  };
  new RoomVisual('W1N1').circle(11, 11, { radius: 0.3, fill: '#fff' }).text('probe', 11, 12);
  Memory.probe = {
    records,
    properties,
    finds,
    positions,
    map,
    market,
    eventLog: room.getEventLog(),
    eventLogRaw: room.getEventLog(true),
    gcl: Game.gcl,
    gpl: Game.gpl,
    resources: Game.resources,
    shard: Game.shard,
    time: Game.time,
  };
  console.log('gameplay', Object.keys(records).length);
}

export function persistence() {
  const helper = require('./helper');
  const binary = require('binary');
  global.turns = (global.turns || 0) + 1;
  Memory.turns = (Memory.turns || 0) + 1;
  const creep = Game.creeps.worker;
  const prior = creep.memory.turns || 0;
  creep.memory.turns = prior + 1;
  const before = {
    turns: global.turns,
    memory: Memory.turns,
    creep: prior,
    loads: global.helperLoads,
    answer: helper.answer,
    binary: Array.from(binary),
    time: Game.time,
    x: creep.pos.x,
    segments: { ...RawMemory.segments },
    foreign: RawMemory.foreignSegment,
  };
  Memory.observations = Memory.observations || [];
  Memory.observations.push(before);
  RawMemory.segments[3] = `segment-${global.turns}`;
  RawMemory.setActiveSegments(['3', 4]);
  RawMemory.setPublicSegments([3]);
  RawMemory.setDefaultPublicSegment(3);
  RawMemory.setActiveForeignSegment('bob', 7);
  Game.flags.Flag1.memory.turns = global.turns;
  Game.rooms.W1N1.memory.turns = global.turns;
  console.log(JSON.stringify(before));
}

export function rawMemory() {
  const attempt = (fn) => {
    try {
      const value = fn();
      return { value };
    } catch (error) {
      return { throws: error.message };
    }
  };
  const records = {};
  records.initial = RawMemory.get();
  records.badSet = attempt(() => RawMemory.set(5));
  records.badSegments = attempt(() => RawMemory.setActiveSegments('bad'));
  records.tooMany = attempt(() => RawMemory.setActiveSegments(Array(11).fill(0)));
  records.badID = attempt(() => RawMemory.setActiveSegments([1, 100]));
  records.badPublic = attempt(() => RawMemory.setPublicSegments(['bad']));
  records.badDefault = attempt(() => RawMemory.setDefaultPublicSegment(-1));
  records.badForeign = attempt(() => RawMemory.setActiveForeignSegment('bob', 100));
  RawMemory.setActiveSegments(['03extra', 3, 4]);
  RawMemory.setPublicSegments(['03extra', 3]);
  RawMemory.setDefaultPublicSegment(null);
  RawMemory.setActiveForeignSegment(null);
  RawMemory.segments[3] = 'stored';
  Memory.before = 1;
  records.beforeSet = RawMemory.get();
  RawMemory.set('{"replaced":true}');
  records.memoryAfterRawSet = Memory;
  Memory.after = 2;
  // Upstream invalidates _parsed but keeps the already-materialized global Memory. A subsequent
  // assignment must not quietly cause the old object to be serialized instead of the raw string.
  console.log(JSON.stringify(records));
}

export function invalidMemory() {
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      return { name: error.name, message: error.message };
    }
  };
  const prototype =
    Memory === null
      ? 'null-value'
      : typeof Memory !== 'object'
        ? typeof Memory
        : Object.getPrototypeOf(Memory) === null
          ? 'null-prototype'
          : Object.getPrototypeOf(Memory) === Object.prototype
            ? 'Object.prototype'
            : 'other';
  console.log(
    JSON.stringify({
      raw: RawMemory.get(),
      parsed: Memory,
      prototype,
      keys: attempt(() => Object.keys(Memory)),
      creep: attempt(() => Game.creeps.worker.memory),
      room: attempt(() => Game.rooms.W1N1.memory),
      spawn: attempt(() => Game.spawns.Spawn1.memory),
    }),
  );
}

export function memoryJSON() {
  Memory.serializationCalls = 0;
  const inherited = Object.create({ inherited: true });
  inherited.own = 'saved';
  Memory.values = {
    omitted: undefined,
    nan: NaN,
    infinity: Infinity,
    negativeZero: -0,
    date: new Date(1700000000000),
    boxed: new Number(7),
    array: [1, undefined, , null],
    inherited,
    custom: {
      toJSON() {
        Memory.serializationCalls++;
        return { serialized: true };
      },
    },
  };
  RawMemory.segments[0] = JSON.stringify(Memory.values);
  RawMemory.setActiveSegments([0]);
  console.log(RawMemory.segments[0]);
}

// RoomPosition construction/packing/coercion, geometry, search, look, exit finds, path
// (de)serialization, Room.Terrain, pre-native PathFinder/findPath early returns and cross-tick
// reuse of RoomPosition/exit caches. Native PathFinder search is never reached.
export function positions() {
  const { describe, attempt } = kit;
  global.positionTicks = (global.positionTicks || 0) + 1;
  const room = Game.rooms.W1N1;
  const P = (x, y, roomName = 'W1N1') => new RoomPosition(x, y, roomName);
  const out = { tick: global.positionTicks };
  const coordinates = [
    0,
    49,
    -1,
    50,
    '7',
    ' 8 ',
    5.5,
    49.5,
    -0.5,
    -0,
    NaN,
    null,
    undefined,
    true,
    [],
    [3],
    {},
    '0x10',
    Infinity,
    1e10,
    { valueOf: () => 9 },
  ];
  out.constructX = coordinates.map((x) => attempt(() => P(x, 5)));
  out.constructY = coordinates.map((y) => attempt(() => P(5, y)));
  const roomNames = [
    'W1N1',
    'w1n1',
    'E0S0',
    'e0s0',
    'sim',
    'W127N127',
    'E127S127',
    'E128S128',
    'W128N0',
    'E0S128',
    'W1N1extra',
    'X1Y1',
    'N1W1',
    'W1',
    'W',
    '',
    'W100N100',
    'W99N9',
    'W01N01',
    5,
    null,
    undefined,
    {},
    new String('W2N1'),
    ['W1N1'],
    { substr: (start) => 'W3S4'.substr(start), charAt: (index) => 'W3S4'.charAt(index) },
    { substr: () => '12', charAt: () => 'E' },
  ];
  out.constructRoom = roomNames.map((roomName) => attempt(() => P(1, 2, roomName)));
  out.constructMissing = [attempt(() => new RoomPosition()), attempt(() => new RoomPosition(1))];
  const shaped = P(10, 20);
  const forIn = [];
  for (const key in shaped) forIn.push(key);
  out.shape = {
    keys: Object.keys(shaped),
    names: Object.getOwnPropertyNames(shaped),
    forIn,
    json: JSON.stringify(shaped),
    string: String(shaped),
    descriptor: describe(Object.getOwnPropertyDescriptor(shaped, '__packedPos')),
    protoKeys: Object.keys(RoomPosition.prototype),
    protoNames: Object.getOwnPropertyNames(RoomPosition.prototype),
    accessors: ['x', 'y', 'roomName'].map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(RoomPosition.prototype, key);
      return [
        descriptor.enumerable,
        descriptor.configurable,
        typeof descriptor.get,
        typeof descriptor.set,
      ];
    }),
    constructor: [RoomPosition.name, RoomPosition.length, shaped.constructor === RoomPosition],
    methods: Object.getOwnPropertyNames(RoomPosition.prototype).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(RoomPosition.prototype, key);
      return [key, describe(descriptor.value), descriptor.enumerable, descriptor.writable];
    }),
  };
  const mutable = P(10, 20);
  out.setters = [
    ['x', '7'],
    ['x', 7.9],
    ['x', -1],
    ['x', 50],
    ['x', NaN],
    ['x', null],
    ['x', undefined],
    ['y', '12'],
    ['y', 49],
    ['y', -0.1],
    ['y', 49.9],
    ['roomName', 'W2N1'],
    ['roomName', 'sim'],
    ['roomName', 'w3s4'],
    ['roomName', 'bad'],
    ['roomName', 5],
    ['roomName', 'E128S128'],
    ['roomName', 'W1N1'],
    ['__packedPos', 0],
    ['__packedPos', -1],
    ['__packedPos', 'x'],
    ['__packedPos', 2 ** 40 + 0x80800a14],
    ['extra', 1],
  ].map(([key, value]) => ({
    key,
    value: describe(value),
    result: attempt(() => {
      mutable[key] = value;
      return [mutable.x, mutable.y, mutable.roomName, mutable.__packedPos, JSON.stringify(mutable)];
    }),
  }));
  out.withOwnProperty = attempt(() => {
    const own = P(4, 5);
    own.note = 'kept';
    own.x = 6;
    return [JSON.stringify(own), own.toJSON(), Object.keys(own)];
  });

  const origin = P(11, 11);
  const targets = [
    origin,
    P(13, 14),
    P(11, 11, 'W2N1'),
    P(11, 11, 'w1n1'),
    Game.getObjectById('source'),
    Game.creeps.worker,
    Game.flags.Flag1,
    { x: 12, y: 12 },
    { x: 12, y: 12, roomName: 'W1N1' },
    { pos: { x: 12, y: 12, roomName: 'W1N1' } },
    { pos: P(12, 13) },
    { __packedPos: origin.__packedPos },
    null,
    undefined,
    5,
    'W1N1',
  ];
  out.geometry = targets.map((target) => ({
    range: attempt(() => origin.getRangeTo(target)),
    inRange1: attempt(() => origin.inRangeTo(target, 1)),
    inRange3: attempt(() => origin.inRangeTo(target, '3')),
    near: attempt(() => origin.isNearTo(target)),
    equal: attempt(() => origin.isEqualTo(target)),
    direction: attempt(() => origin.getDirectionTo(target)),
  }));
  out.xy = [
    [12, 12],
    [11, 11],
    ['12', '12'],
    [12, '12'],
    [NaN, 11],
    [11, NaN],
    [60, 11],
    [-5, -5],
    [11.5, 11],
    [Infinity, 11],
    [12, undefined],
    [undefined, 12],
    [12, null],
  ].map(([x, y]) => ({
    range: attempt(() => origin.getRangeTo(x, y)),
    inRange: attempt(() => origin.inRangeTo(x, y, 1)),
    near: attempt(() => origin.isNearTo(x, y)),
    equal: attempt(() => origin.isEqualTo(x, y)),
    direction: attempt(() => origin.getDirectionTo(x, y)),
  }));
  out.directions = [];
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) out.directions.push(origin.getDirectionTo(11 + dx, 11 + dy));
  out.crossRoom = ['W0N1', 'W2N1', 'W1N0', 'W1N2', 'W0N0', 'W2N2', 'E5S5', 'sim', 'W1N1'].map(
    (roomName) => ({
      to: attempt(() => origin.getDirectionTo(P(5, 45, roomName))),
      from: attempt(() => P(5, 45, roomName).getDirectionTo(origin)),
      range: attempt(() => origin.getRangeTo(P(5, 45, roomName))),
    }),
  );

  const source = Game.getObjectById('source');
  const candidates = [
    source,
    Game.creeps.worker,
    { x: 11, y: 12 },
    { x: 11, y: 12, roomName: 'W1N1' },
    { pos: { x: 11, y: 12, roomName: 'W1N1' } },
    P(12, 12),
    P(12, 12, 'W2N1'),
    P(14, 14),
    null,
  ];
  out.search = {
    inRangeFind: [0, 1, 2, 3, '2', -1, NaN, undefined, Infinity].map((range) =>
      attempt(() => origin.findInRange(FIND_STRUCTURES, range)),
    ),
    inRangeArray: [1, 3].map((range) => attempt(() => origin.findInRange(candidates, range))),
    inRangeFilters: [
      { filter: { structureType: 'tower' } },
      { filter: 'my' },
      { filter: (object) => object.structureType === 'link' },
      { filter: null },
      null,
      'opts',
    ].map((opts) => attempt(() => origin.findInRange(FIND_STRUCTURES, 3, opts))),
    inRangeOther: [
      attempt(() => origin.findInRange('creeps', 1)),
      attempt(() => origin.findInRange(FIND_MY_CREEPS, 0)),
      attempt(() => origin.findInRange(candidates.slice(0, 3), 1, { filter: { id: 'source' } })),
      attempt(() => P(1, 1, 'W2N1').findInRange(FIND_CREEPS, 1)),
    ],
    closestByRange: [
      attempt(() => origin.findClosestByRange(FIND_SOURCES)),
      attempt(() =>
        origin.findClosestByRange(FIND_STRUCTURES, { filter: { structureType: 'lab' } }),
      ),
      attempt(() => origin.findClosestByRange(candidates)),
      attempt(() => origin.findClosestByRange([P(13, 13), P(9, 9), P(13, 9)])),
      attempt(() => origin.findClosestByRange([null, P(12, 12, 'W2N1'), { x: 1 }])),
      attempt(() => origin.findClosestByRange([])),
      attempt(() => origin.findClosestByRange(FIND_HOSTILE_STRUCTURES)),
      attempt(() =>
        origin.findClosestByRange(candidates, { filter: (object) => !!object && !object.id }),
      ),
      attempt(() => P(1, 1, 'W2N1').findClosestByRange(FIND_SOURCES)),
    ],
  };

  const terrainAt = (x, y, roomName) => attempt(() => P(x, y, roomName).lookFor(LOOK_TERRAIN));
  out.look = {
    look: attempt(() => origin.look()),
    lookEdge: attempt(() => P(0, 20).look()),
    lookForCreeps: attempt(() => origin.lookFor(LOOK_CREEPS)),
    lookForStructures: attempt(() => P(12, 11).lookFor(LOOK_STRUCTURES)),
    lookForBad: attempt(() => origin.lookFor('nonsense')),
    terrain: [
      [11, 11],
      [17, 5],
      [17, 8],
      [19, 11],
      [0, 0],
      [0, 21],
      [0, 30],
      [35, 35],
    ].map(([x, y]) => terrainAt(x, y)),
    terrainOtherRoom: terrainAt(5, 5, 'W2N1'),
    terrainMissingRoom: terrainAt(5, 5, 'W9N9'),
    foreignRoom: attempt(() => P(5, 5, 'W2N1').lookFor(LOOK_CREEPS)),
    foreignLook: attempt(() => P(5, 5, 'W2N1').look()),
  };

  const exitTypes = [FIND_EXIT_TOP, FIND_EXIT_RIGHT, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT, FIND_EXIT];
  out.room = {
    positionAt: [
      [0, 0],
      [49, 49],
      [-1, 0],
      [50, 0],
      ['5', '6'],
      [5.5, 6],
      [NaN, 0],
      [undefined, undefined],
    ].map(([x, y]) => attempt(() => room.getPositionAt(x, y))),
    exits: exitTypes.map((type) => attempt(() => room.find(type))),
    exitFilters: [
      attempt(() => room.find(FIND_EXIT, { filter: (pos) => pos.y === 0 })),
      attempt(() => room.find(FIND_EXIT_LEFT, { filter: { x: 0, y: 22 } })),
    ],
  };
  // Upstream caches exit positions per tick and returns shallow clones: element mutation leaks.
  const firstExits = room.find(FIND_EXIT_TOP);
  if (global.positionTicks === 1) {
    firstExits[0].x = 30;
    firstExits.push('junk');
  }
  out.room.exitAliasing = {
    top: describe(room.find(FIND_EXIT_TOP)),
    all: describe(room.find(FIND_EXIT).slice(0, 4)),
    sameElement: room.find(FIND_EXIT_TOP)[0] === firstExits[0],
    sameArray: room.find(FIND_EXIT_TOP) === firstExits,
  };

  out.serializePath = [
    [],
    [{ x: 5, y: 5, direction: 1 }],
    [{ x: 12, y: 3, direction: 3 }, { direction: 'x' }, {}],
    [{ x: -1, y: 0, direction: 1 }],
    [{ x: 0, y: -1, direction: 1 }],
    [{ x: '5', y: '15', direction: 2 }],
    [{ x: 5.5, y: 0, direction: 1 }],
    [{ x: 100, y: 100, direction: 8 }],
    [{}],
    [null],
    'path',
    null,
    undefined,
    { length: 1, 0: { x: 1, y: 1, direction: 1 } },
  ].map((path) => attempt(() => Room.serializePath(path)));
  out.deserializePath = [
    '',
    '0505',
    '05051',
    '050512345678',
    '0505123456789',
    '05059',
    '05050',
    '0',
    '1',
    'ab',
    '0a0b1',
    ' 1 21',
    '99991',
    '-1-11',
    '01011.',
    5,
    null,
    undefined,
    ['0505'],
    new String('05051'),
  ].map((path) => attempt(() => Room.deserializePath(path)));
  out.pathRoundTrip = attempt(() => Room.serializePath(Room.deserializePath('1011' + '12345678')));

  const terrain = new Room.Terrain('W1N1');
  out.terrain = {
    keys: Object.keys(terrain),
    shape: [Room.Terrain.name, Room.Terrain.length, Object.keys(Room.Terrain.prototype)],
    get: [
      [11, 11],
      [17, 5],
      [19, 11],
      [0, 30],
      [35, 35],
      [-1, 1],
      [50, 0],
      ['1', '1'],
      [1.5, 0],
      [NaN, 0],
      [0, -1],
      [49, 49],
      [0, 50],
      [],
    ].map(([x, y]) => attempt(() => terrain.get(x, y))),
    raw: attempt(() => terrain.getRawBuffer()),
    rawIntoExact: attempt(() => terrain.getRawBuffer(new Uint8Array(2500))),
    rawIntoLarge: attempt(() => terrain.getRawBuffer(new Uint8Array(2600))),
    rawIntoSmall: attempt(() => terrain.getRawBuffer(new Uint8Array(10))),
    rawIntoPlain: attempt(() => terrain.getRawBuffer([])),
    rawIntoFloat: attempt(() => terrain.getRawBuffer(new Float64Array(2500))),
    rawFalsy: attempt(() => terrain.getRawBuffer(0)),
    rawIdentity: terrain.getRawBuffer() !== terrain.getRawBuffer(),
    rawDetached: attempt(() => {
      const buffer = terrain.getRawBuffer();
      buffer[11 * 50 + 11] = 1;
      return [terrain.get(11, 11), buffer[11 * 50 + 11]];
    }),
    rooms: ['W2N1', 'E0N1', 'w1n1', 'W9N9', 5, undefined, null, { toString: () => 'W1N1' }].map(
      (roomName) => attempt(() => new Room.Terrain(roomName).get(0, 0)),
    ),
    withoutNew: attempt(() => Room.Terrain('W1N1')),
    roomTerrain: attempt(() => room.getTerrain().get(19, 11)),
    mapTerrain: attempt(() => Game.map.getRoomTerrain('W1N1').get(17, 5)),
  };

  out.preNative = {
    searchGoals: [[], null, undefined, 0, '', false, NaN].map((goal) =>
      attempt(() => PathFinder.search(origin, goal)),
    ),
    searchNoOrigin: attempt(() => PathFinder.search(null, [])),
    findPathSame: attempt(() => room.findPath(origin, P(11, 11))),
    findPathSameSerialized: attempt(() => room.findPath(origin, origin, { serialize: true })),
    findPathOtherRoom: attempt(() => room.findPath(P(1, 1, 'W2N1'), origin, {})),
    findPathOtherRoomSerialized: attempt(() =>
      room.findPath(P(1, 1, 'W2N1'), origin, { serialize: true }),
    ),
    findPathOtherRoomNoOpts: attempt(() => room.findPath(P(1, 1, 'W2N1'), origin)),
    findPathToSame: attempt(() => origin.findPathTo(11, 11)),
    findPathToSameObject: attempt(() => origin.findPathTo(origin, { serialize: true })),
    findPathToForeign: attempt(() => P(1, 1, 'W2N1').findPathTo(2, 2)),
    closestUndefined: attempt(() => origin.findClosestByPath()),
    closestEmpty: attempt(() => origin.findClosestByPath([])),
    closestOnSquare: attempt(() => origin.findClosestByPath([P(12, 12), P(11, 11), origin])),
    closestFiltered: attempt(() => origin.findClosestByPath([P(12, 12)], { filter: () => false })),
    closestForeign: attempt(() => P(1, 1, 'W2N1').findClosestByPath(FIND_SOURCES)),
  };

  if (global.positionTicks === 1)
    global.savedPositions = {
      RoomPosition,
      Room,
      PathFinder,
      origin,
      lower: P(3, 3, 'w1n1'),
      exits: room.find(FIND_EXIT_TOP),
      room,
    };
  const saved = global.savedPositions;
  out.persist = {
    sameConstructors: [
      saved.RoomPosition === RoomPosition,
      saved.Room === Room,
      saved.PathFinder === PathFinder,
      saved.room === room,
    ],
    savedInstance: saved.origin instanceof RoomPosition,
    savedFind: attempt(() => saved.origin.findInRange(FIND_CREEPS, 1)),
    savedClosest: attempt(() => saved.origin.findClosestByRange(FIND_MY_CREEPS)),
    savedLower: describe(saved.lower),
    savedExits: describe(saved.exits.slice(0, 2)),
    freshExits: describe(room.find(FIND_EXIT_TOP).slice(0, 2)),
    sameExitObjects: room.find(FIND_EXIT_TOP)[0] === saved.exits[0],
    savedRoomFind: attempt(() => saved.room.find(FIND_MY_CREEPS).length),
  };
  Memory.probe = out;
  console.log('positions', global.positionTicks);
}

// Legacy (PathFinder.use(false)) room pathfinding on the only tick the original keeps the legacy
// flag on the live register: obstacles, terrain costs, options, caches, end nodes, closest-by-path.
export function legacyPaths() {
  const { describe, attempt } = kit;
  PathFinder.use(false);
  const room = Game.rooms.W1N1;
  const P = (x, y, roomName = 'W1N1') => new RoomPosition(x, y, roomName);
  const from = P(11, 11);
  const out = {};
  const optionSets = [
    () => undefined,
    () => ({ ignoreCreeps: true }),
    () => ({ ignoreDestructibleStructures: true }),
    () => ({ ignoreCreeps: true, serialize: true }),
    () => ({ ignoreCreeps: true, maxOps: 5 }),
    () => ({ ignoreCreeps: true, heuristicWeight: 5 }),
    () => ({ ignoreCreeps: true, avoid: [P(14, 12), { x: 13, y: 14 }, { pos: P(16, 12) }] }),
    () => ({ ignoreCreeps: true, ignore: [Game.getObjectById('tower'), P(12, 13)] }),
    () => ({ ignoreCreeps: true, ignoreDestructibleStructures: true, serialize: true }),
  ];
  const targets = [
    [15, 14],
    [25, 12],
    [30, 30],
    [17, 10],
    [19, 12],
    [11, 11],
    [12, 12],
    [45, 45],
    [0, 25],
    [21, 0],
    [11, 13],
    [36, 35],
  ];
  out.paths = targets.map(([x, y]) =>
    optionSets.map((options) => attempt(() => room.findPath(from, P(x, y), options()))),
  );
  out.pathShapes = [
    attempt(() =>
      room.findPath({ x: 20, y: 20, roomName: 'W1N1' }, { x: 24, y: 22, roomName: 'W1N1' }, {}),
    ),
    attempt(() => room.findPath({ x: -1, y: 5, roomName: 'W1N1' }, P(5, 5), {})),
    attempt(() => room.findPath(from, { x: 50, y: 5, roomName: 'W1N1' }, {})),
    attempt(() => room.findPath(from, P(5, 5, 'W2N1'), {})),
    attempt(() => room.findPath(from, P(5, 5, 'W2N1'))),
    attempt(() => room.findPath(from, null, {})),
    attempt(() => room.findPath(from, FIND_SOURCES, {})),
    attempt(() => room.findPath(from, P(25, 12), { avoid: 'bad' })),
    attempt(() => room.findPath(from, P(25, 12), { ignore: 5 })),
    attempt(() => room.findPath(from, P(25, 12), { avoid: [null, 0, { x: 26, y: 12 }] })),
  ];
  const first = room.findPath(from, P(25, 12), { ignoreCreeps: true });
  const firstCopy = describe(first);
  first[0].x = 99;
  first.push('junk');
  const unreachable = room.findPath(from, P(30, 30), { ignoreCreeps: true });
  const lastStep = unreachable[unreachable.length - 1];
  out.cache = {
    first: firstCopy,
    second: attempt(() => room.findPath(from, P(25, 12), { ignoreCreeps: true })),
    serializedFromCache: attempt(() =>
      room.findPath(from, P(25, 12), { ignoreCreeps: true, serialize: true }),
    ),
    otherSuffix: attempt(() =>
      room.findPath(from, P(25, 12), { ignoreCreeps: true, ignoreDestructibleStructures: true }),
    ),
    unreachable: describe(unreachable),
    viaLastStep: lastStep
      ? attempt(() => room.findPath(from, P(lastStep.x, lastStep.y), { ignoreCreeps: true }))
      : null,
  };
  out.endNodes = {
    sources: attempt(() => room.getEndNodes(FIND_SOURCES)),
    filtered: attempt(() =>
      room.getEndNodes(FIND_STRUCTURES, { filter: { structureType: 'link' } }),
    ),
    array: attempt(() => room.getEndNodes([P(20, 20), { x: 21, y: 21 }])),
    arrayAgain: attempt(() => room.getEndNodes([{ x: 21, y: 21 }, P(20, 20)])),
    invalid: attempt(() => room.getEndNodes([5, 6])),
    undefinedType: attempt(() => room.getEndNodes()),
    dijkstraSources: attempt(() => room.findPath(from, FIND_SOURCES, {})),
    dijkstraArrayKey: attempt(() => room.findPath(P(25, 25), 1, { ignoreCreeps: true })),
  };
  out.closest = {
    near: attempt(() => from.findClosestByPath(FIND_SOURCES)),
    structures: attempt(() => P(30, 20).findClosestByPath(FIND_STRUCTURES)),
    astar: attempt(() =>
      P(30, 20).findClosestByPath(FIND_STRUCTURES, { algorithm: 'astar', ignoreCreeps: true }),
    ),
    dijkstra: attempt(() =>
      P(30, 20).findClosestByPath(FIND_STRUCTURES, { algorithm: 'dijkstra' }),
    ),
    array: attempt(() =>
      P(30, 20).findClosestByPath([P(25, 25), P(35, 15), Game.getObjectById('drySource')], {
        ignoreCreeps: true,
      }),
    ),
    filter: attempt(() =>
      P(30, 20).findClosestByPath(FIND_STRUCTURES, { filter: { structureType: 'tower' } }),
    ),
    exitTop: attempt(() => from.findClosestByPath(FIND_EXIT_TOP, { ignoreCreeps: true })),
    exitAny: attempt(() => from.findClosestByPath(FIND_EXIT, { ignoreCreeps: true })),
    none: attempt(() => from.findClosestByPath(FIND_HOSTILE_STRUCTURES)),
    walledIn: attempt(() => P(30, 30).findClosestByPath([P(40, 40)])),
  };
  out.findPathTo = {
    xy: attempt(() => from.findPathTo(25, 12, { ignoreCreeps: true })),
    xySerialized: attempt(() => from.findPathTo(25, 12, { ignoreCreeps: true, serialize: true })),
    object: attempt(() => from.findPathTo(Game.getObjectById('drySource'))),
    objectOptions: attempt(() =>
      from.findPathTo(Game.getObjectById('drySource'), { ignoreCreeps: true, maxOps: 50 }),
    ),
    crossRoomTop: attempt(() => from.findPathTo(P(25, 25, 'W1N2'), { ignoreCreeps: true })),
    crossRoomLeft: attempt(() => from.findPathTo(P(25, 25, 'W2N1'), { ignoreCreeps: true })),
    crossRoomRoute: attempt(() => from.findPathTo(P(25, 25, 'W0N1'), { ignoreCreeps: true })),
    crossRoomUnreachable: attempt(() => from.findPathTo(P(25, 25, 'E0N1'))),
  };
  out.moveTo = [
    attempt(() => Game.creeps.worker.moveTo(25, 12, { ignoreCreeps: true, reusePath: 5 })),
    describe(Game.creeps.worker.memory),
    attempt(() => Game.creeps.hostile.moveTo(25, 12)),
    attempt(() =>
      Game.creeps.empty.moveByPath(
        new String(Room.serializePath(room.findPath(from, P(14, 13), { ignoreCreeps: true }))),
      ),
    ),
    attempt(() => Game.creeps.noMove.moveByPath(new String('bad'))),
  ];
  Memory.probe = out;
  console.log('legacy-paths', out.paths.length);
}

// Game.map: exits, statuses, availability, linear/continuous distance, terrain lookups, route
// search with callback coercion/order/receiver/failures, findExit receivers and map reuse.
export function mapRouting() {
  const { describe, attempt } = kit;
  global.mapTicks = (global.mapTicks || 0) + 1;
  const out = { tick: global.mapTicks };
  const rooms = [
    'W0N0',
    'W1N0',
    'W2N0',
    'W0N1',
    'W1N1',
    'W2N1',
    'W0N2',
    'W1N2',
    'W2N2',
    'E0N1',
    'W3N0',
    'W3N1',
    'W3N2',
    'W1N3',
    'W2N3',
    'W0N3',
    'W9N9',
    'sim',
    'w1n1',
    'E0S0',
    'W1N1x',
    'xW1N1',
    'W1N1 ',
    '',
    'W',
    'WN',
    'W01N01',
    5,
    null,
    undefined,
    {},
    { name: 'W1N1' },
    new String('W1N1'),
    ['W1N1'],
  ];
  out.exits = rooms.map((room) => attempt(() => Game.map.describeExits(room)));
  out.status = rooms.map((room) => attempt(() => Game.map.getRoomStatus(room)));
  out.available = rooms.map((room) => attempt(() => Game.map.isRoomAvailable(room)));
  out.distance = rooms.map((room) =>
    [false, true, 'yes'].map((continuous) =>
      attempt(() => Game.map.getRoomLinearDistance('W1N1', room, continuous)),
    ),
  );
  out.distanceReverse = rooms.map((room) =>
    attempt(() => Game.map.getRoomLinearDistance(room, 'E0S0')),
  );
  out.worldSize = Game.map.getWorldSize();
  out.terrainAt = [
    [11, 11, 'W1N1'],
    [17, 5, 'W1N1'],
    [19, 11, 'W1N1'],
    [35, 35, 'W1N1'],
    [0, 30, 'W1N1'],
    [-1, 0, 'W1N1'],
    [50, 0, 'W1N1'],
    ['17', '5', 'W1N1'],
    ['1', '1', 'W1N1'],
    [0, 0, 'W9N9'],
    [0, 0, 'w1n1'],
    [0, 0, undefined],
    [NaN, 0, 'W1N1'],
    [0, 0, 'E0N1'],
  ].map(([x, y, room]) => attempt(() => Game.map.getTerrainAt(x, y, room)));
  out.terrainAtObject = [
    new RoomPosition(17, 5, 'W1N1'),
    { x: 19, y: 11, roomName: 'W1N1' },
    { x: '19', y: 11, roomName: 'W1N1' },
    { x: 1, y: 1 },
    { pos: new RoomPosition(17, 5, 'W1N1') },
  ].map((position) => attempt(() => Game.map.getTerrainAt(position)));
  out.roomTerrain = rooms
    .slice(0, 16)
    .map((room) => attempt(() => Game.map.getRoomTerrain(room).getRawBuffer()));
  const pairs = [
    ['W1N1', 'W1N1'],
    ['W1N1', 'W2N1'],
    ['W1N1', 'W0N1'],
    ['W1N1', 'W1N0'],
    ['W1N1', 'W0N0'],
    ['W1N1', 'E0N1'],
    ['W0N1', 'W1N1'],
    ['W2N2', 'W0N0'],
    ['W0N0', 'W2N2'],
    ['W1N1', 'W3N1'],
    ['W1N1', 'W3N0'],
    ['W1N1', 'W2N3'],
    ['W1N1', 'W9N9'],
    ['W1N1', 'W40N40'],
    ['W1N1', 'w1n2'],
    ['xW1N1', 'W1N2'],
    ['W1N1x', 'W1N2'],
    ['W1N1', 'sim'],
    [Game.rooms.W1N1, 'W1N2'],
    [{ name: 'W1N1' }, { name: 'W1N2' }],
    ['W1N1', new String('W1N1')],
    [5, 'W1N1'],
    [null, undefined],
    ['W1N1', undefined],
    [undefined, undefined],
    ['W01N01', 'W1N1'],
  ];
  out.routes = pairs.map(([from, to]) => ({
    route: attempt(() => Game.map.findRoute(from, to)),
    exit: attempt(() => Game.map.findExit(from, to)),
  }));
  const calls = [];
  const callbacks = {
    log: (room, from) => {
      calls.push(['log', room, from]);
      return 1;
    },
    blockNorth: (room) => (room === 'W1N2' ? Infinity : 1),
    string: () => '3',
    nan: () => NaN,
    zero: () => 0,
    negative: (room) => (room === 'W2N1' ? -5 : 1),
    huge: (room) => (room === 'W1N2' ? 1e9 : 1),
    object: () => ({ valueOf: () => 2 }),
    undefinedResult: () => undefined,
    negativeInfinity: () => -Infinity,
    infinityString: () => 'Infinity',
    allInfinity: () => Infinity,
    fractional: (room) => (room === 'W2N2' ? 0.25 : 1.5),
    throws: (room) => {
      if (room === 'W0N2') throw new Error('route callback failure');
      return 1;
    },
    receiver: function () {
      calls.push([
        'receiver',
        this === undefined ? 'undefined' : this === global ? 'global' : typeof this,
        arguments.length,
      ]);
      return 1;
    },
  };
  out.callbacks = {};
  for (const [name, callback] of Object.entries(callbacks))
    out.callbacks[name] = attempt(() =>
      Game.map.findRoute('W1N1', 'W0N1', { routeCallback: callback }),
    );
  out.calls = calls;
  out.afterFailure = attempt(() => Game.map.findRoute('W2N2', 'W1N0'));
  out.badCallbacks = [5, 'x', {}, null, 0, true].map((callback) =>
    attempt(() => Game.map.findRoute('W1N1', 'W0N1', { routeCallback: callback })),
  );
  out.badOptions = [null, 5, 'str', [], { routeCallback: undefined }].map((options) =>
    attempt(() => Game.map.findRoute('W1N1', 'W0N1', options)),
  );
  const room = Game.rooms.W1N1;
  out.findExitTo = [
    'W1N2',
    'W0N1',
    'W2N1',
    'W1N0',
    'W1N1',
    'E0N1',
    'W9N9',
    'bad',
    room,
    { name: 'W1N2' },
    undefined,
  ].map((target) => attempt(() => room.findExitTo(target)));
  out.findExitReceivers = [
    attempt(() => Game.map.findExit.call({ findRoute: () => 'custom' }, 'W1N1', 'W1N2')),
    attempt(() => Game.map.findExit.call({ findRoute: () => [{ exit: 'x' }] }, 'a', 'b')),
    attempt(() => Game.map.findExit.call({ findRoute: () => [] }, 'a', 'b')),
    attempt(() => Game.map.findExit.call(null, 'W1N1', 'W1N2')),
    attempt(() => Game.map.findExit.call({}, 'W1N1', 'W1N2')),
  ];
  out.mapShape = {
    keys: Object.keys(Game.map),
    methods: Object.keys(Game.map)
      .filter((key) => key !== 'visual')
      .map((key) => [key, describe(Game.map[key])]),
    visualDescriptor: describe(
      Object.getOwnPropertyDescriptor(Game.map, 'visual') &&
        Object.keys(Object.getOwnPropertyDescriptor(Game.map, 'visual')),
    ),
  };
  if (global.mapTicks === 1) global.savedMap = Game.map;
  out.persist = {
    sameMap: global.savedMap === Game.map,
    savedRoute: attempt(() => global.savedMap.findRoute('W2N2', 'W0N0')),
    interleaved: attempt(() => [
      Game.map.findRoute('W1N1', 'W2N2'),
      global.savedMap.findRoute('W0N0', 'W2N0'),
      Game.map.findRoute('W1N1', 'W2N2'),
    ]),
  };
  Memory.probe = out;
  console.log('map', global.mapTicks);
}

// CostMatrix storage/coercion/aliasing, clone and (de)serialization including malformed inputs,
// constructor/prototype metadata, foreign receivers, pre-native PathFinder returns and reuse of
// matrices and constructors held in globals or Memory across ticks.
export function costMatrix() {
  const { describe, attempt } = kit;
  global.matrixTicks = (global.matrixTicks || 0) + 1;
  const CostMatrix = PathFinder.CostMatrix;
  const out = { tick: global.matrixTicks };
  const matrix = new CostMatrix();
  let valueCalls = 0;
  const counted = {
    valueOf() {
      valueCalls++;
      return 42;
    },
  };
  const sets = [
    [1, 2, 260],
    [3, 4, -2],
    [5.9, 6.9, 7.9],
    [0, 0, NaN],
    [0, 1, '12'],
    [0, 2, true],
    [0, 3, null],
    [0, 4, undefined],
    [0, 5, 255.9],
    [0, 6, 1e10],
    [0, 7, -0.5],
    [0, 8, 'abc'],
    [0, 9, counted],
    [0, 10, [7]],
    [0, 11, 254.5],
    [0, 12, 0.9999],
    [0, 13, -Infinity],
    [0, 14, Infinity],
    ['3', '4', 9],
    [50, 0, 9],
    [-1, 49, 9],
    [0, 50, 33],
    [49, 49, 77],
    [NaN, NaN, 5],
    [2 ** 32 + 7, 0, 11],
    [-0.5, 40, 13],
    [1e10, 0, 99],
    [undefined, 20, 21],
    [{ valueOf: () => 2 }, 30, 31],
    [10, 10],
    [-50, 0, 44],
    [49, 51, 55],
  ];
  out.sets = sets.map(([x, y, value]) => attempt(() => matrix.set(x, y, value)));
  out.valueCalls = valueCalls;
  out.gets = sets.map(([x, y]) => attempt(() => matrix.get(x, y)));
  out.rawGets = [
    [50, 0],
    [-1, 49],
    [1, 0],
    [0, 0],
    [],
    ['0', '9'],
    [49.9, 49.9],
    [-1, -1],
    [50, 50],
    [0, 2500],
    [-50, 0],
  ].map(([x, y]) => attempt(() => matrix.get(x, y)));
  const serialized = matrix.serialize();
  out.serialized = {
    length: serialized.length,
    isArray: Array.isArray(serialized),
    nonZero: serialized.map((value, index) => (value ? [index, value] : null)).filter(Boolean),
  };
  const clone = matrix.clone();
  matrix.set(20, 20, 200);
  clone.set(21, 21, 201);
  out.clone = {
    cells: [matrix.get(20, 20), clone.get(20, 20), matrix.get(21, 21), clone.get(21, 21)],
    sameBits: clone._bits === matrix._bits,
    sameBuffer: clone._bits.buffer === matrix._bits.buffer,
    instance: clone instanceof CostMatrix,
    keys: Object.keys(clone),
    constructor: clone.constructor === CostMatrix,
    bits: describe(clone._bits),
  };
  const inputs = [
    serialized,
    JSON.parse(JSON.stringify(serialized)),
    [],
    [1],
    [0x01020304],
    [1.5, -1, 2 ** 32, 2 ** 32 + 5, '7', null, 'x', undefined],
    new Array(625).fill(0xffffffff),
    new Array(700).fill(1),
    { length: 2, 0: 5, 1: 6 },
    {},
    null,
    undefined,
    5,
    'abc',
    '3',
    new Uint8Array([1, 2, 3, 4]),
    new Uint32Array([258]),
    -1,
    2.5,
  ];
  out.deserialize = inputs.map((input) =>
    attempt(() => {
      const restored = CostMatrix.deserialize(input);
      return {
        bits: restored._bits,
        cells: [restored.get(0, 0), restored.get(0, 1), restored.get(1, 2), restored.get(49, 49)],
        instance: restored instanceof CostMatrix,
        keys: Object.keys(restored),
        own: Object.getOwnPropertyNames(restored),
        reserialized: attempt(() => restored.serialize().length),
      };
    }),
  );
  const json = JSON.stringify(matrix);
  out.shape = {
    name: CostMatrix.name,
    length: CostMatrix.length,
    protoKeys: Object.keys(CostMatrix.prototype),
    protoNames: Object.getOwnPropertyNames(CostMatrix.prototype),
    staticKeys: Object.keys(CostMatrix),
    methods: ['set', 'get', 'clone', 'serialize'].map((name) =>
      describe(CostMatrix.prototype[name]),
    ),
    deserialize: describe(CostMatrix.deserialize),
    instanceKeys: Object.keys(matrix),
    instanceNames: Object.getOwnPropertyNames(matrix),
    json: [json.length, json.slice(0, 60)],
    pathFinderKeys: Object.keys(PathFinder),
    pathFinderNames: Object.getOwnPropertyNames(PathFinder),
    pathFinderPrototype: Object.getPrototypeOf(PathFinder) === Object.prototype,
    pathFinderDescriptors: describe(Object.getOwnPropertyDescriptors(PathFinder)),
  };
  out.receivers = {
    withoutNew: attempt(() => CostMatrix()),
    detachedSet: attempt(() => {
      const set = matrix.set;
      return set(1, 1, 1);
    }),
    foreignGet: attempt(() => CostMatrix.prototype.get.call({ _bits: [5, 6, 7] }, 0, 1)),
    foreignSet: attempt(() => {
      const foreign = { _bits: [] };
      CostMatrix.prototype.set.call(foreign, 0, 3, 300);
      return foreign._bits;
    }),
    foreignClone: attempt(() => CostMatrix.prototype.clone.call({ _bits: [1, 2, 3, 4] })._bits),
    replacedBits: attempt(() => {
      const replaced = new CostMatrix();
      replaced._bits = new Uint8Array(12);
      replaced.set(0, 5, 50);
      replaced.set(0, 20, 50);
      return [replaced.get(0, 5), replaced.get(0, 20), replaced.serialize()];
    }),
    oddBuffer: attempt(() => {
      const odd = new CostMatrix();
      odd._bits = new Uint8Array(3);
      return odd.serialize();
    }),
    subclass: attempt(() => {
      class Sub extends CostMatrix {}
      const sub = new Sub();
      sub.set(1, 1, 5);
      return [sub.get(1, 1), sub instanceof CostMatrix, sub.clone() instanceof Sub];
    }),
  };
  out.pathFinder = {
    searchGoals: [[], null, undefined, 0, '', false, NaN].map((goal) =>
      attempt(() =>
        PathFinder.search(new RoomPosition(1, 1, 'W1N1'), goal, { roomCallback: () => false }),
      ),
    ),
    use: [
      attempt(() => PathFinder.use(true)),
      attempt(() => PathFinder.use()),
      attempt(() => PathFinder.use(1)),
    ],
  };
  if (global.matrixTicks === 1) {
    global.savedMatrix = new CostMatrix();
    global.savedMatrix.set(7, 7, 70);
    global.SavedCostMatrix = CostMatrix;
    Memory.savedMatrix = global.savedMatrix.serialize();
  } else {
    global.savedMatrix.set(8, 8, 80);
  }
  const fromMemory = CostMatrix.deserialize(Memory.savedMatrix);
  out.persist = {
    sameConstructor: global.SavedCostMatrix === CostMatrix,
    instance: global.savedMatrix instanceof CostMatrix,
    cells: [global.savedMatrix.get(7, 7), global.savedMatrix.get(8, 8)],
    fromMemory: [
      fromMemory.get(7, 7),
      fromMemory.get(8, 8),
      fromMemory instanceof global.SavedCostMatrix,
    ],
  };
  Memory.probe = out;
  console.log('cost-matrix', global.matrixTicks);
}

// Store capacity/usage/free-capacity across general, resource-specific and mixed stores, proxy
// reads/enumeration/coercion/writes, lazy `_sum` caching and receivers, legacy store aliases and
// store objects held across ticks.
export function stores() {
  const { describe, attempt } = kit;
  global.storeTicks = (global.storeTicks || 0) + 1;
  const out = { tick: global.storeTicks };
  const resources = [
    undefined,
    null,
    '',
    0,
    RESOURCE_ENERGY,
    RESOURCE_HYDROGEN,
    RESOURCE_POWER,
    RESOURCE_GHODIUM,
    RESOURCE_OXYGEN,
    'battery',
    'invalid',
    'toString',
    'constructor',
    'hasOwnProperty',
    'getCapacity',
    5,
    true,
  ];
  const probe = (store) => {
    const forIn = [];
    for (const key in store) forIn.push(key);
    const result = {
      keys: Object.keys(store),
      names: Object.getOwnPropertyNames(store),
      forIn,
      json: JSON.stringify(store),
      string: attempt(() => String(store)),
      template: attempt(() => `${store}`),
      concat: attempt(() => store + ''),
      number: attempt(() => +store),
      has: ['energy', 'H', 'O', 'getCapacity', 'toString', '_sum'].map((key) => key in store),
      own: ['energy', 'H', 'getCapacity', '_sum'].map((key) =>
        Object.prototype.hasOwnProperty.call(store, key),
      ),
      prototype: [Object.getPrototypeOf(store) === Store.prototype, store instanceof Store],
      reads: {},
      methods: {},
    };
    for (const key of [
      'energy',
      'H',
      'O',
      'power',
      'G',
      'battery',
      'invalid',
      'toString',
      'constructor',
      'getCapacity',
      '_sum',
      'length',
      '0',
    ])
      result.reads[key] = describe(store[key]);
    for (const method of ['getCapacity', 'getUsedCapacity', 'getFreeCapacity'])
      result.methods[method] = resources.map((resource) => attempt(() => store[method](resource)));
    result.namesAfter = Object.getOwnPropertyNames(store);
    result.sum = describe(Object.getOwnPropertyDescriptor(store, '_sum'));
    return result;
  };
  out.objects = {};
  for (const id of [
    'worker',
    'empty',
    'spawn',
    'container',
    'overfilled',
    'tower',
    'link',
    'lab',
    'emptyLab',
    'terminal',
    'storage',
    'foreignStorage',
    'factory',
    'nuker',
    'powerSpawn',
    'extension',
    'tombstone',
    'ruin',
  ]) {
    const object = Game.getObjectById(id);
    out.objects[id] = attempt(() => {
      const result = probe(object.store);
      result.sameStore = object.store === Game.getObjectById(id).store;
      result.aliases = {};
      for (const key of [
        'energy',
        'energyCapacity',
        'carry',
        'carryCapacity',
        'storeCapacity',
        'mineralAmount',
        'mineralType',
        'mineralCapacity',
        'power',
        'powerCapacity',
        'ghodium',
        'ghodiumCapacity',
      ])
        result.aliases[key] = attempt(() =>
          key === 'carry' ? object.carry === object.store : object[key],
        );
      return result;
    });
  }
  out.powerCreep = attempt(() => probe(Game.powerCreeps.Operator.store));
  const configs = {
    general: { store: { energy: 10, H: 5 }, storeCapacity: 100 },
    zeroes: { store: { energy: 0, H: 0, O: null }, storeCapacity: 50 },
    negative: { store: { energy: -5, H: 10 }, storeCapacity: 20 },
    overfilled: { store: { energy: 80, H: 40 }, storeCapacity: 100 },
    noCapacity: { store: { energy: 3 } },
    zeroCapacity: { store: {}, storeCapacity: 0 },
    energyOnly: { store: { energy: 10 }, storeCapacityResource: { energy: 50 } },
    energyOnlyEmpty: { store: {}, storeCapacityResource: { energy: 50 } },
    labMixed: {
      store: { energy: 100, H: 20 },
      storeCapacity: 5000,
      storeCapacityResource: { energy: 2000 },
    },
    labBoth: { store: { energy: 100, H: 20 }, storeCapacityResource: { energy: 2000, H: 3000 } },
    resourceOverCapacity: { store: {}, storeCapacity: 100, storeCapacityResource: { energy: 150 } },
    stringAmounts: { store: { energy: '10', H: '5' }, storeCapacity: '100' },
    nonResourceKeys: { store: { foo: 4, energy: 1, 0: 2 }, storeCapacity: 10 },
    inherited: { store: Object.create({ energy: 99 }), storeCapacity: 10 },
    zeroResourceCapacity: { store: { energy: 1 }, storeCapacityResource: { energy: 0 } },
    nanAmounts: { store: { energy: NaN, H: 2 }, storeCapacity: 10 },
  };
  out.synthetic = {};
  for (const [name, config] of Object.entries(configs))
    out.synthetic[name] = attempt(() => probe(new Store(config)));
  out.construct = [undefined, null, {}, { store: null }, { store: 5 }, { store: 'ab' }, 5].map(
    (config) => attempt(() => Object.keys(new Store(config))),
  );
  out.storeShape = {
    name: Store.name,
    length: Store.length,
    protoNames: Object.getOwnPropertyNames(Store.prototype),
    descriptor: describe(
      Object.keys(Object.getOwnPropertyDescriptor(new Store(configs.general), 'getCapacity')),
    ),
    methodShape: ['getCapacity', 'getUsedCapacity', 'getFreeCapacity', 'toString'].map((name) =>
      describe(new Store(configs.general)[name]),
    ),
  };
  out.receivers = {
    poisonedSum: attempt(() => {
      const store = new Store(configs.general);
      store._sum = 1000;
      return [store.getUsedCapacity(), store.getFreeCapacity(), store._sum];
    }),
    callOther: attempt(() =>
      new Store(configs.general).getFreeCapacity.call(
        { getCapacity: () => 100, getUsedCapacity: () => 30 },
        RESOURCE_ENERGY,
      ),
    ),
    callOtherSum: attempt(() => {
      const other = { getCapacity: () => 100 };
      const free = new Store(configs.general).getFreeCapacity.call(other);
      return [free, other._sum, Object.keys(other)];
    }),
    callMissing: attempt(() =>
      new Store(configs.energyOnly).getFreeCapacity.call({}, RESOURCE_ENERGY),
    ),
    writes: attempt(() => {
      const store = new Store(configs.general);
      store.energy = 7;
      store.O = 3;
      delete store.H;
      let strict;
      try {
        (function () {
          'use strict';
          store.getCapacity = 1;
        })();
      } catch (error) {
        strict = [error.name, error.message];
      }
      store.getUsedCapacity = 5;
      return [
        store.energy,
        store.H,
        store.O,
        store.getUsedCapacity(RESOURCE_ENERGY),
        store.getUsedCapacity(),
        Object.keys(store),
        strict,
      ];
    }),
  };
  // Sloppy-mode detached calls bind the global object: the first lazily defined `_sum` is global
  // and non-configurable, so later detached calls (even on other ticks) reuse it.
  out.detached = {
    used: attempt(() => {
      const used = new Store(global.storeTicks === 1 ? configs.general : configs.overfilled)
        .getUsedCapacity;
      return used();
    }),
    globalSum: describe(Object.getOwnPropertyDescriptor(global, '_sum')),
    other: attempt(() => {
      const used = new Store(configs.overfilled).getUsedCapacity;
      return used();
    }),
    free: attempt(() => {
      const free = new Store(configs.general).getFreeCapacity;
      return free(RESOURCE_ENERGY);
    }),
  };
  if (global.storeTicks === 1) {
    global.savedStore = Game.getObjectById('container').store;
    global.savedStore.getUsedCapacity();
    global.SavedStore = Store;
  }
  out.persist = {
    sameConstructor: global.SavedStore === Store,
    sameStore: global.savedStore === Game.getObjectById('container').store,
    saved: [
      global.savedStore.energy,
      global.savedStore.getUsedCapacity(),
      global.savedStore.getFreeCapacity(),
    ],
    fresh: [
      Game.getObjectById('container').store.energy,
      Game.getObjectById('container').store.getUsedCapacity(),
    ],
    savedNames: Object.getOwnPropertyNames(global.savedStore),
  };
  Memory.probe = out;
  console.log('stores', global.storeTicks);
}

// Authentic native PathFinder through the player API (separate native-backed process): search
// goals/options/limits/coercion, room callbacks (matrices, false, foreign shapes, failures, call
// order), rooms without terrain, new-pathfinder findPath/findPathTo/findClosestByPath options and
// grid caches, and moveTo path reuse in creep Memory across ticks.
export function nativePaths() {
  const { describe, attempt } = kit;
  global.nativeTicks = (global.nativeTicks || 0) + 1;
  const room = Game.rooms.W1N1;
  const P = (x, y, roomName = 'W1N1') => new RoomPosition(x, y, roomName);
  const from = P(11, 11);
  const CostMatrix = PathFinder.CostMatrix;
  const out = { tick: global.nativeTicks };
  const calls = [];
  const wall = new CostMatrix();
  for (let y = 0; y < 50; y++) wall.set(25, y, 255);
  wall.set(25, 30, 0);
  const weighted = new CostMatrix();
  for (let x = 12; x < 25; x++) weighted.set(x, 10, 40);
  const searches = {
    single: [P(25, 12)],
    range: [{ pos: P(25, 12), range: 3 }],
    rangeString: [{ pos: P(25, 12), range: '2' }],
    multi: [[P(40, 40), { pos: P(5, 45), range: 1 }, P(30, 33)]],
    walledIn: [P(30, 30)],
    wallTarget: [P(17, 5)],
    sameTile: [from],
    plainGoal: [{ x: 20, y: 20, roomName: 'W1N1' }],
    crossRoom: [P(25, 25, 'W1N2')],
    crossRoomFar: [P(25, 25, 'W2N2')],
    isolatedRoom: [P(25, 25, 'E0N1')],
    unknownRoom: [P(25, 25, 'W9N9')],
    otherOrigin: [P(40, 40, 'W1N2'), { origin: P(10, 10, 'W1N2') }],
    flee: [{ pos: P(12, 12), range: 5 }, { flee: true }],
    fleeMulti: [
      [
        { pos: P(12, 12), range: 4 },
        { pos: P(5, 5), range: 3 },
      ],
      { flee: true, maxOps: 500 },
    ],
    cheap: [P(25, 12), { plainCost: 1, swampCost: 1 }],
    swampHeavy: [P(25, 12), { plainCost: 2, swampCost: 50 }],
    oddCosts: [P(25, 12), { plainCost: '3', swampCost: NaN, heuristicWeight: 9.5 }],
    extremeCosts: [P(25, 12), { plainCost: 0, swampCost: 300, heuristicWeight: 0.5 }],
    maxOps: [P(45, 45), { maxOps: 5 }],
    maxCost: [P(45, 45), { maxCost: 10 }],
    maxRooms: [P(25, 25, 'W1N2'), { maxRooms: 1 }],
    heuristicHigh: [P(45, 45), { heuristicWeight: 9 }],
    callbackWall: [
      P(40, 12),
      {
        roomCallback: (roomName) => {
          calls.push(['wall', roomName]);
          return roomName === 'W1N1' ? wall : undefined;
        },
      },
    ],
    callbackWeighted: [P(25, 10), { roomCallback: () => weighted }],
    callbackFalse: [
      P(25, 25, 'W1N2'),
      {
        roomCallback: (roomName) => {
          calls.push(['false', roomName]);
          return roomName !== 'W1N2';
        },
      },
    ],
    callbackRawBits: [P(25, 12), { roomCallback: () => ({ _bits: new Uint8Array(2500).fill(3) }) }],
    callbackShortBits: [P(25, 12), { roomCallback: () => ({ _bits: new Uint8Array(10) }) }],
    callbackArrayBits: [P(25, 12), { roomCallback: () => ({ _bits: [1, 2] }) }],
    callbackNonFunction: [P(25, 12), { roomCallback: 5 }],
    callbackThrows: [
      P(25, 12),
      {
        roomCallback: () => {
          throw new Error('room callback failure');
        },
      },
    ],
    invalidGoal: [{ range: 1 }],
    invalidGoalPosition: [{ x: 50, y: 0, roomName: 'W1N1' }],
    invalidOrigin: [P(1, 1), { origin: { x: -1, y: 0, roomName: 'W1N1' } }],
    simRoom: [P(2, 2, 'sim'), { origin: P(1, 1, 'sim') }],
  };
  out.search = {};
  for (const [name, [goal, options]] of Object.entries(searches))
    out.search[name] = attempt(() => {
      const origin = options && options.origin ? options.origin : from;
      if (options) delete options.origin;
      return PathFinder.search(origin, goal, options);
    });
  out.calls = calls;
  const cost = (roomName, matrix) => {
    calls.push(['cost', roomName, matrix instanceof CostMatrix, matrix.get(12, 10)]);
    matrix.set(12, 10, 255);
    matrix.set(13, 12, 200);
  };
  out.findPath = {
    plain: attempt(() => room.findPath(from, P(25, 12))),
    ignoreCreeps: attempt(() => room.findPath(from, P(25, 12), { ignoreCreeps: true })),
    ignoreStructures: attempt(() =>
      room.findPath(from, P(25, 12), { ignoreDestructibleStructures: true }),
    ),
    ignoreRoads: attempt(() => room.findPath(from, P(25, 12), { ignoreRoads: true })),
    serialize: attempt(() =>
      room.findPath(from, P(25, 12), { serialize: true, ignoreCreeps: true }),
    ),
    range: attempt(() => room.findPath(from, P(25, 12), { range: 3 })),
    rangeAdjacent: attempt(() => room.findPath(from, P(12, 12))),
    costCallback: attempt(() => room.findPath(from, P(25, 12), { costCallback: cost })),
    costCallbackReturn: attempt(() => room.findPath(from, P(25, 12), { costCallback: () => wall })),
    costCallbackForeign: attempt(() =>
      room.findPath(from, P(25, 12), { costCallback: () => ({}) }),
    ),
    afterCallback: attempt(() => room.findPath(from, P(25, 12))),
    costs: attempt(() => room.findPath(from, P(25, 12), { plainCost: 5, swampCost: 1 })),
    maxOps: attempt(() => room.findPath(from, P(45, 45), { maxOps: 20 })),
    crossRoom: attempt(() => room.findPath(from, P(25, 25, 'W1N2'), { ignoreCreeps: true })),
    crossRoomMaxRooms: attempt(() => room.findPath(from, P(25, 25, 'W1N2'), { maxRooms: 1 })),
    walledIn: attempt(() => room.findPath(from, P(30, 30))),
    deprecatedOptions: attempt(() => {
      const options = { avoid: [P(12, 12)], ignore: [P(13, 13)] };
      const path = room.findPath(from, P(25, 12), options);
      return [path, Object.keys(options), options.avoid, options.ignore];
    }),
  };
  out.findPathTo = {
    xy: attempt(() => from.findPathTo(25, 12)),
    object: attempt(() => from.findPathTo(Game.getObjectById('drySource'), { ignoreCreeps: true })),
    crossRoom: attempt(() => from.findPathTo(P(25, 25, 'W2N1'))),
  };
  out.closest = {
    sources: attempt(() => P(30, 20).findClosestByPath(FIND_SOURCES)),
    structures: attempt(() => P(30, 20).findClosestByPath(FIND_STRUCTURES, { ignoreCreeps: true })),
    filtered: attempt(() =>
      P(30, 20).findClosestByPath(FIND_STRUCTURES, { filter: { structureType: 'lab' } }),
    ),
    positions: attempt(() => from.findClosestByPath([P(40, 40), P(5, 45), P(30, 33)])),
    unreachable: attempt(() => from.findClosestByPath([P(30, 30)])),
    costCallback: attempt(() =>
      from.findClosestByPath([P(25, 12), P(25, 30)], { costCallback: () => wall }),
    ),
    deprecated: attempt(() => from.findClosestByPath([P(25, 12)], { avoid: [], ignore: [] })),
  };
  const worker = Game.creeps.worker;
  const stationary = Game.creeps.empty;
  out.move = {
    position: describe(worker.pos),
    before: describe(worker.memory._move),
    moveTo: attempt(() => worker.moveTo(25, 12, { reusePath: 10 })),
    after: describe(worker.memory._move),
    visualized: attempt(() =>
      worker.moveTo(P(20, 20), { visualizePathStyle: { stroke: '#f00' }, reusePath: 0 }),
    ),
    reuseBefore: describe(stationary.memory._move),
    reuse: attempt(() => stationary.moveTo(30, 20, { reusePath: 5 })),
    reuseAfter: describe(stationary.memory._move),
    noPathFinding: attempt(() => Game.creeps.broken.moveTo(30, 30, { noPathFinding: true })),
    crossRoom: attempt(() => Game.creeps.noMove.moveTo(P(25, 25, 'W1N2'))),
    serialized: attempt(() => Game.creeps.tired.moveTo(40, 40, { serializeMemory: false })),
    serializedMemory: describe(Game.creeps.tired.memory._move),
  };
  Memory.probe = out;
  console.log('native-paths', global.nativeTicks);
}
