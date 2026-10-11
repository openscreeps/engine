import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BotRuntime } from '../src/runtime/index.ts';
import type { PlayerSandboxHook } from '../src/runtime/host/sandbox.ts';
import { createWorldState, type WorldState } from '../src/simulation/index.ts';

function world(): WorldState {
  const user = (id: string, username: string) => ({
    _id: id,
    username,
    cpu: 100,
    cpuAvailable: 10000,
    gcl: 0,
    power: 0,
    money: 0,
    rooms: [],
    active: 10000,
  });
  return createWorldState({
    gameTime: 10,
    terrain: { W1N1: '0'.repeat(2500), W2N1: '0'.repeat(2500) },
    rooms: { W1N1: { _id: 'W1N1', status: 'normal' }, W2N1: { _id: 'W2N1', status: 'normal' } },
    roomObjects: {
      controller1: {
        _id: 'controller1',
        type: 'controller',
        room: 'W1N1',
        x: 20,
        y: 20,
        user: 'u1',
        level: 1,
      },
      controller2: {
        _id: 'controller2',
        type: 'controller',
        room: 'W2N1',
        x: 20,
        y: 20,
        user: 'u2',
        level: 1,
      },
    },
    users: { u1: user('u1', 'alice'), u2: user('u2', 'user_to_exclude') },
  });
}

const counterCode = {
  main: `module.exports.loop = function () {
    global.counter = (global.counter || 0) + 1;
    Memory.counter = global.counter;
  };`,
};

void describe('playerSandbox hook', () => {
  void it('keeps the example player-sandbox.js mod semantics across ticks', async () => {
    const hostLog: string[] = [];
    const hookTimes: unknown[] = [];
    // `.reference/launcher/init_dist/example-mods/player-sandbox.js`, host console captured.
    const playerSandbox: PlayerSandboxHook = (sandbox, userId) => {
      sandbox.set('myInValue', 123);
      sandbox.run(`function test() {
        console.log('Current game tick is:', Game.time, 'myInValue:', global.myInValue);
        global.myOutValue = 999;
      }`);
      hostLog.push(`User ${userId} global.myOutValue=${String(sandbox.get('myOutValue'))}`);
      hookTimes.push(sandbox.run('Game.time'), sandbox.get('counter'));
    };
    const state = world();
    using runtime = new BotRuntime({ playerSandbox });
    runtime.setCode('u1', counterCode);

    const first = await runtime.runUser(state, 'u1');
    assert.equal(first?.console.error, undefined);
    runtime.enqueueConsoleCommand('u1', 'test()');
    state.gameTime++;
    const second = await runtime.runUser(state, 'u1');
    assert.equal(second?.console.error, undefined);
    assert.equal(second?.reset, false);
    assert.deepEqual(
      second.console.log.map((entry) => entry.message),
      ['Current game tick is: 11 myInValue: 123'],
    );
    state.gameTime++;
    const third = await runtime.runUser(state, 'u1');
    assert.equal(third?.console.error, undefined);

    assert.deepEqual(hostLog, [
      'User u1 global.myOutValue=undefined',
      'User u1 global.myOutValue=undefined',
      'User u1 global.myOutValue=999',
    ]);
    // The hook sees the prepared Game of the current tick and the globals left by earlier ticks.
    assert.deepEqual(hookTimes, [10, undefined, 11, 1, 12, 2]);
    assert.deepEqual(JSON.parse(runtime.getMemory('u1')), { counter: 3 });
  });

  void it('never exposes host handles to player code', async () => {
    const playerSandbox: PlayerSandboxHook = (sandbox) => {
      assert.equal(typeof sandbox.getIsolate().compileScriptSync, 'function');
      assert.equal(typeof sandbox.getContext().evalClosureSync, 'function');
      assert.equal(typeof sandbox.getGlobal().derefInto, 'function');
      sandbox.set('hostValue', { nested: [1, 2] });
    };
    using runtime = new BotRuntime({ playerSandbox });
    runtime.setCode('u1', {
      main: `module.exports.loop = function () {
        const leaks = [];
        for (const key of Reflect.ownKeys(globalThis)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
          const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
          if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
            for (const name of ['compileScriptSync', 'derefInto', 'applySync', 'evalClosureSync', 'copyInto']) {
              if (name in value) leaks.push(String(key) + '.' + name);
            }
          }
        }
        console.log(JSON.stringify(leaks), typeof _isolate, typeof _context, typeof _ivm,
          Object.getPrototypeOf(hostValue) === Object.prototype, JSON.stringify(hostValue));
      };`,
    });
    const result = await runtime.runUser(world(), 'u1');
    assert.equal(result?.console.error, undefined);
    assert.equal(
      result?.console.log[0]?.message,
      '[] undefined undefined undefined true {"nested":[1,2]}',
    );
  });

  void it('does not bill hook time to the player', async () => {
    const playerSandbox: PlayerSandboxHook = (sandbox) => {
      sandbox.run('{ const start = Date.now(); while (Date.now() - start < 200) {} }');
    };
    using runtime = new BotRuntime({ playerSandbox });
    runtime.setCode('u1', {
      main: `module.exports.loop = function () { console.log(Game.cpu.getUsed() < 100); };`,
    });
    const result = await runtime.runUser(world(), 'u1');
    assert.ok(result);
    assert.equal(result.console.error, undefined);
    assert.equal(result.console.log[0]?.message, 'true');
    assert.ok(result.cpu.used < 100, `hook time billed: ${String(result.cpu.used)}`);
  });

  void it('fails only the affected run when the hook fails and keeps the isolate', async () => {
    let failure: 'throw' | 'syntax' | 'trap' | undefined;
    const playerSandbox: PlayerSandboxHook = (sandbox, userId) => {
      if (userId !== 'u1') {
        return;
      }
      if (failure === 'throw') {
        throw new Error('mod failure');
      }
      if (failure === 'syntax') {
        sandbox.run('function (');
      }
      if (failure === 'trap') {
        sandbox.get('trap');
      }
    };
    const state = world();
    using runtime = new BotRuntime({ playerSandbox, hardTimeoutMs: 1000 });
    runtime.setCode('u1', {
      main: `module.exports.loop = function () {
        global.counter = (global.counter || 0) + 1;
        Memory.counter = global.counter;
        Object.defineProperty(global, 'trap', { get() { while (true) {} }, configurable: true });
      };`,
    });
    runtime.setCode('u2', counterCode);

    const ok = await runtime.runTick(state);
    assert.equal(ok.users.u1?.console.error, undefined);

    for (const [kind, pattern] of [
      ['throw', /mod failure/],
      ['syntax', /SyntaxError/],
      ['trap', /timed out/],
    ] as const) {
      failure = kind;
      state.gameTime++;
      const tick = await runtime.runTick(state);
      assert.match(tick.users.u1?.console.error ?? '', pattern);
      assert.deepEqual(tick.users.u1?.intents, { rooms: {} });
      assert.equal(tick.users.u2?.console.error, undefined);
    }
    assert.deepEqual(JSON.parse(runtime.getMemory('u1')), { counter: 1 });

    failure = undefined;
    state.gameTime++;
    const recovered = await runtime.runTick(state);
    assert.equal(recovered.users.u1?.console.error, undefined);
    assert.equal(recovered.users.u1?.reset, false);
    assert.deepEqual(JSON.parse(runtime.getMemory('u1')), { counter: 2 });
    assert.deepEqual(JSON.parse(runtime.getMemory('u2')), { counter: 5 });
  });

  void it('lets a getAllUsers override exclude eligible users', async () => {
    // `.reference/launcher/init_dist/example-mods/driver-method.js`.
    using runtime = new BotRuntime({
      getAllUsers: (eligible) =>
        eligible.filter((user) => user.username !== 'user_to_exclude').map((user) => user._id),
    });
    runtime.setCode('u1', counterCode);
    runtime.setCode('u2', counterCode);
    const tick = await runtime.runTick(world());
    assert.deepEqual(Object.keys(tick.users), ['u1']);
  });
});
