import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildWorldIndex } from '../src/runtime/host/runtime-data.ts';
import type { MarketOrder, PowerCreepDoc, TransactionDoc } from '../src/simulation/state.ts';
import { harvestingWorld } from './fixtures/world.ts';

function addUnenumerated<T>(record: Record<string, T>, value: T): void {
  Object.setPrototypeOf(record, { inherited: value });
  Object.defineProperty(record, 'hidden', { value, enumerable: false });
}

function order(id: string): MarketOrder {
  return {
    _id: id,
    user: 'u1',
    active: true,
    type: 'sell',
    amount: 10,
    remainingAmount: 20,
    resourceType: 'energy',
    price: 3,
    roomName: 'W1N1',
  };
}

function transaction(id: string, time: number): TransactionDoc {
  return {
    _id: id,
    time,
    sender: 'u1',
    recipient: 'u2',
    resourceType: 'energy',
    amount: 10,
    from: 'W1N1',
    to: 'W2N1',
  };
}

function powerCreep(id: string): PowerCreepDoc {
  return {
    _id: id,
    user: 'u1',
    name: id,
    className: 'operator',
    level: 0,
    hitsMax: 1000,
    store: {},
    storeCapacity: 100,
    spawnCooldownTime: null,
    powers: {},
  };
}

void it('indexes only own enumerable world documents in Object.values order', () => {
  const world = harvestingWorld();
  const controller = world.roomObjects.ctrl1;
  assert.ok(controller);
  world.roomObjects['10'] = { ...controller, _id: 'object10' };
  world.roomObjects['2'] = { ...controller, _id: 'object2' };
  addUnenumerated(world.roomObjects, { ...controller, _id: 'excludedObject' });
  addUnenumerated(world.rooms, { _id: 'E100S100', status: 'normal' });

  for (const key of ['10', '2', 'last']) {
    world.flags[key] = { _id: `flag${key}`, user: 'u1', room: 'W1N1', data: key };
    world.userPowerCreeps[key] = powerCreep(`power${key}`);
    world.marketOrders[key] = order(`order${key}`);
    world.transactions[key] = transaction(`transaction${key}`, 100);
    world.marketStats[key] = {
      _id: `stats${key}`,
      resourceType: 'energy',
      date: key,
      transactions: 1,
      volume: 10,
      avgPrice: 3,
      stddevPrice: 0,
    };
  }
  addUnenumerated(world.flags, { _id: 'excludedFlag', user: 'u1', room: 'W1N1', data: '' });
  addUnenumerated(world.userPowerCreeps, powerCreep('excludedPower'));
  addUnenumerated(world.marketOrders, order('excludedOrder'));
  addUnenumerated(world.transactions, transaction('excludedTransaction', 200));
  addUnenumerated(world.marketStats, {
    _id: 'excludedStats',
    resourceType: 'energy',
    date: 'excluded',
    transactions: 1,
    volume: 10,
    avgPrice: 3,
    stddevPrice: 0,
  });

  const index = buildWorldIndex(world, 100);
  assert.deepEqual(
    index.objectsByRoom.W1N1?.map((object) => object._id),
    ['object2', 'object10', 'ctrl1', 'spawn1', 'src1', 'creep1'],
  );
  assert.deepEqual(
    index.objectsByUser.u1?.map((object) => object._id),
    ['object2', 'object10', 'ctrl1', 'spawn1', 'creep1'],
  );
  assert.deepEqual(
    index.flagsByUser.u1?.map((flag) => flag._id),
    ['flag2', 'flag10', 'flaglast'],
  );
  assert.deepEqual(
    index.powerCreepsByUser.u1?.map((creep) => creep._id),
    ['power2', 'power10', 'powerlast'],
  );
  assert.deepEqual(
    index.ordersByUser.u1?.map((entry) => entry._id),
    ['order2', 'order10', 'orderlast'],
  );
  assert.deepEqual(Object.keys(index.activeOrders.all ?? {}), ['order2', 'order10', 'orderlast']);
  assert.deepEqual(Object.keys(index.activeOrders.energy ?? {}), [
    'order2',
    'order10',
    'orderlast',
  ]);
  assert.deepEqual(
    index.transactionsBySender.u1?.map((entry) => entry._id),
    ['transaction2', 'transaction10', 'transactionlast'],
  );
  assert.deepEqual(index.transactionsByRecipient.u2, index.transactionsBySender.u1);
  assert.deepEqual(
    index.marketHistory.all?.map((entry) => entry.date),
    ['2', '10', 'last'],
  );
  assert.deepEqual(index.marketHistory.energy, index.marketHistory.all);
  assert.equal(index.accessibleRooms, '["W1N1"]');
  assert.equal(index.worldSize, 3);
});

void it('rebuilds groups, views and document order after direct host mutations', () => {
  const world = harvestingWorld();
  const controller = world.roomObjects.ctrl1;
  const spawn = world.roomObjects.spawn1;
  assert.ok(controller);
  assert.ok(spawn);
  const flag = { _id: 'flag', user: 'u1', room: 'W1N1', data: 'before' };
  const power = powerCreep('power');
  const activeOrder = Object.assign(order('active'), { extra: 'preserved', id: 'oldId' });
  const symbol = Symbol('host order field');
  Object.assign(activeOrder, { [symbol]: 'symbol value' });
  const inactiveOrder = { ...order('inactive'), active: false };
  const history = {
    _id: 'history',
    resourceType: 'energy',
    date: '2026-10-10',
    transactions: 1,
    volume: 10,
    avgPrice: 3,
    stddevPrice: 0,
    extra: 'preserved',
  };
  const outgoing = transaction('outgoing', 100);
  world.flags.flag = flag;
  world.userPowerCreeps.power = power;
  world.marketOrders.active = activeOrder;
  world.marketOrders.inactive = inactiveOrder;
  world.marketStats.history = history;
  world.transactions.outgoing = outgoing;
  const first = buildWorldIndex(world, 100);
  const { _id: activeId, ...activeFields } = activeOrder;
  const firstView = first.activeOrders.all?.active;
  assert.ok(firstView);
  assert.deepEqual(firstView, { ...activeFields, id: activeId });
  assert.deepEqual(Object.keys(firstView), Object.keys({ ...activeFields, id: activeId }));
  assert.equal(first.activeOrders.energy?.active, firstView);
  assert.notEqual(firstView, activeOrder);
  firstView.price = 50;
  assert.equal(activeOrder.price, 3);
  const { _id: historyId, ...historyFields } = history;
  assert.equal(historyId, 'history');
  assert.deepEqual(first.marketHistory.all, [historyFields]);
  assert.equal(history._id, 'history');

  controller.user = 'u2';
  controller.room = 'W2N1';
  Reflect.deleteProperty(world.roomObjects, 'spawn1');
  world.roomObjects.spawn1 = spawn;
  flag.user = 'u2';
  flag.data = 'after';
  power.user = 'u2';
  activeOrder.active = false;
  inactiveOrder.active = true;
  inactiveOrder.resourceType = 'power';
  history.resourceType = 'power';
  history.avgPrice = 7;
  outgoing.sender = 'u2';
  outgoing.recipient = 'u1';
  outgoing.time = 200;
  world.rooms.W2N1 = { _id: 'W2N1', status: 'normal' };

  const next = buildWorldIndex(world, 200);
  assert.deepEqual(
    next.objectsByUser.u1?.map((object) => object._id),
    ['creep1', 'spawn1'],
  );
  assert.deepEqual(
    next.objectsByRoom.W1N1?.map((object) => object._id),
    ['src1', 'creep1', 'spawn1'],
  );
  assert.deepEqual(next.objectsByUser.u2, [controller]);
  assert.deepEqual(next.objectsByRoom.W2N1, [controller]);
  assert.equal(next.flagsByUser.u1, undefined);
  assert.deepEqual(next.flagsByUser.u2, [flag]);
  assert.equal(next.flagsByUser.u2[0]?.data, 'after');
  assert.equal(next.powerCreepsByUser.u1, undefined);
  assert.deepEqual(next.powerCreepsByUser.u2, [power]);
  assert.deepEqual(next.ordersByUser.u1, [activeOrder, inactiveOrder]);
  assert.deepEqual(Object.keys(next.activeOrders.all ?? {}), ['inactive']);
  assert.equal(next.activeOrders.energy, undefined);
  assert.equal(next.activeOrders.power?.inactive?.resourceType, 'power');
  assert.equal(next.marketHistory.energy, undefined);
  assert.equal(next.marketHistory.power?.[0]?.avgPrice, 7);
  assert.equal(next.transactionsBySender.u1, undefined);
  assert.equal(next.transactionsByRecipient.u2, undefined);
  assert.deepEqual(next.transactionsBySender.u2, [outgoing]);
  assert.deepEqual(next.transactionsByRecipient.u1, [outgoing]);
  assert.equal(next.accessibleRooms, '["W1N1","W2N1"]');
  assert.equal(next.worldSize, 4);
});

void it('retains the latest hundred transactions with stable equal-time ordering', () => {
  const world = harvestingWorld();
  const tied = Array.from({ length: 105 }, (_, i) => transaction(`t${String(i)}`, 100));
  for (const entry of tied) world.transactions[entry._id] = entry;
  const newest = transaction('newest', 200);
  const oldest = transaction('oldest', 0);
  world.transactions.newest = newest;
  world.transactions.oldest = oldest;
  const documents = Object.values(world.transactions);
  const index = buildWorldIndex(world, 200);
  const expected = [newest, ...tied.slice(0, 99)];
  assert.deepEqual(index.transactionsBySender.u1, expected);
  assert.deepEqual(index.transactionsByRecipient.u2, expected);
  assert.notEqual(index.transactionsBySender.u1, index.transactionsByRecipient.u2);
  assert.deepEqual(Object.values(world.transactions), documents);
  assert.equal(Object.keys(world.transactions).length, 107);
  for (const entry of expected) assert.equal(world.transactions[entry._id], entry);
});

void it('recomputes strict time boundaries, status precedence and edited room identities', () => {
  const world = harvestingWorld();
  world.rooms = {
    W1N1: { _id: 'W1N1', status: 'normal' },
    W2N1: { _id: 'W2N1', status: 'normal', openTime: 0 },
    W3N1: { _id: 'W3N1', status: 'normal', openTime: 100 },
    W4N1: { _id: 'W4N1', status: 'normal', openTime: 101 },
    W5N1: { _id: 'W5N1', status: 'normal', novice: 110, respawnArea: 120, openTime: 130 },
    W6N1: { _id: 'W6N1', status: 'normal', novice: 100, respawnArea: 110, openTime: 130 },
    W7N1: { _id: 'W7N1', status: 'out of borders', openTime: 110 },
    W8N1: { _id: 'W8N1', status: 'out of borders' },
  };
  const first = buildWorldIndex(world, 100);
  assert.equal(first.accessibleRooms, '["W1N1","W2N1"]');
  assert.deepEqual(first.roomStatusData, {
    novice: { W5N1: 110 },
    respawn: { W6N1: 110 },
    closed: { W4N1: 101, W7N1: 110, W8N1: null },
  });
  assert.equal(first.worldSize, 10);
  const boundary = buildWorldIndex(world, 110);
  assert.equal(boundary.accessibleRooms, '["W1N1","W2N1","W3N1","W4N1"]');
  assert.deepEqual(boundary.roomStatusData, {
    novice: {},
    respawn: { W5N1: 120 },
    closed: { W6N1: 130, W7N1: null, W8N1: null },
  });
  world.rooms.W8N1 = { _id: 'E20S20', status: 'normal' };
  const next = buildWorldIndex(world, 131);
  assert.equal(next.accessibleRooms, '["W1N1","W2N1","W3N1","W4N1","W5N1","W6N1","E20S20"]');
  assert.deepEqual(next.roomStatusData, { novice: {}, respawn: {}, closed: { W7N1: null } });
  assert.equal(next.worldSize, 29);
});
