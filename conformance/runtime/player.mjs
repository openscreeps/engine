// These functions are serialized verbatim as player modules for BOTH engines. All observation
// construction happens inside the player realm; the adapter cannot manufacture API results.
export function playerModules(loop) {
  return {
    main: `let state = 123456789; Math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }; Date.now = () => 1700000000000; module.exports.loop = ${loop.toString()};`,
    helper: 'global.helperLoads = (global.helperLoads || 0) + 1; module.exports = {answer: 42};',
    binary: { binary: 'AAECA/8=' },
  };
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
