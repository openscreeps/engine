/*
 * Entry of a supervised worker process (`engine_runnerN` hosting player isolates, or
 * `engine_processorN` processing rooms). It loads the server mod setup module, then serves the
 * pool's requests until the pool disconnects (the driver exits on `disconnect` the same way).
 */

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConstants, runWithConstants, type Constants } from '../constants.ts';
import { getRuntimeBundle } from '../runtime/host/bundle.ts';
import type { TerrainPack } from '../runtime/host/sandbox.ts';
import { LocalSandboxHost } from '../runtime/host/sandbox-host.ts';
import { createPathFinder, executeRoomJob, type RoomJobOutcome } from '../simulation/room-job.ts';
import type { PathFinder } from '../utils/pathfinder.ts';
import type {
  ChildMessage,
  ParentMessage,
  ProcessorJobBody,
  RunnerNotice,
  RunnerRunBody,
  WorkerHost,
  WorkerKind,
  WorkerSetup,
  WorkerSetupFunction,
} from './protocol.ts';

interface Handler {
  request(body: unknown): unknown;
  notice(body: unknown): void;
}

const listeners = new Map<string, Set<(data: unknown) => void>>();
const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextCall = 1;
let handler: Handler | undefined;

function send(message: ChildMessage): void {
  process.send?.(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function createHost(kind: WorkerKind, name: string): WorkerHost {
  return {
    kind,
    name,
    call(method, ...args) {
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const id = nextCall++;
      calls.set(id, { resolve, reject });
      try {
        send({ type: 'call', id, method, args });
      } catch (error) {
        calls.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      return promise;
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
}

async function loadSetup(
  message: Extract<ParentMessage, { type: 'init' }>,
  host: WorkerHost,
): Promise<WorkerSetup> {
  if (!message.setup) {
    return {};
  }
  const { module } = message.setup;
  const specifier =
    module.startsWith('file:') || !isAbsolute(module) ? module : pathToFileURL(module).href;
  // The setup module is selected by the embedding server at run time (server mods).
  const loaded = (await import(specifier)) as { default?: unknown };
  if (typeof loaded.default !== 'function') {
    throw new TypeError(`Worker setup module ${module} has no default export function`);
  }
  const setup = loaded.default as WorkerSetupFunction;
  return setup(message.setup.data, message.kind, host);
}

function createRunner(setup: WorkerSetup, bundle: string | undefined): Handler {
  const source = bundle === undefined ? getRuntimeBundle : () => Promise.resolve(bundle);
  const owners = new Map<
    number,
    { host: LocalSandboxHost; terrain: TerrainPack | undefined; constants: Constants }
  >();
  return {
    request(raw) {
      const body = raw as RunnerRunBody;
      let owner = owners.get(body.owner);
      if (!owner) {
        owner = {
          host: new LocalSandboxHost({ bundle: source, playerSandbox: setup.playerSandbox }),
          terrain: undefined,
          constants: defaultConstants,
        };
        owners.set(body.owner, owner);
      }
      if (body.terrain) {
        owner.terrain = body.terrain;
      }
      if (body.constants !== undefined) {
        owner.constants = body.constants ?? defaultConstants;
      }
      if (!owner.terrain) {
        throw new Error(`Runner received a run of runtime ${String(body.owner)} without terrain`);
      }
      return owner.host.run({
        codeTimestamp: body.codeTimestamp,
        memoryLimitMb: body.memoryLimitMb,
        hardTimeoutMs: body.hardTimeoutMs,
        terrain: owner.terrain,
        constants: owner.constants,
        input: body.input,
      });
    },
    notice(raw) {
      const notice = raw as RunnerNotice;
      const owner = owners.get(notice.owner);
      if (notice.type === 'clear') {
        owner?.host.clear(notice.userId);
      } else {
        owner?.host.dispose();
        owners.delete(notice.owner);
      }
    },
  };
}

function createProcessor(setup: WorkerSetup): Handler {
  const hooks = setup.hooks ?? {};
  let context: { key: string; pathFinder: PathFinder; constants: Constants } | undefined;
  return {
    request(raw): RoomJobOutcome {
      const body = raw as ProcessorJobBody;
      const load = body.load;
      if (load) {
        const constants = load.constants ?? defaultConstants;
        context = {
          key: body.context,
          pathFinder: runWithConstants(constants, () => createPathFinder(load.terrain)),
          constants,
        };
      }
      const current = context;
      if (current?.key !== body.context) {
        throw new Error(`Processor received a room of ${body.context} without its terrain`);
      }
      return runWithConstants(current.constants, () =>
        executeRoomJob(body.job, body.env, body.rngSeed, current.pathFinder, hooks),
      );
    },
    notice() {},
  };
}

async function initialize(message: Extract<ParentMessage, { type: 'init' }>): Promise<void> {
  try {
    const setup = await loadSetup(message, createHost(message.kind, message.name));
    handler =
      message.kind === 'runner' ? createRunner(setup, message.bundle) : createProcessor(setup);
  } catch (error) {
    process.send?.({ type: 'failed', error: errorMessage(error) } satisfies ChildMessage, () => {
      process.exit(1);
    });
    return;
  }
  send({ type: 'ready' });
}

function serve(id: number, body: unknown): void {
  const current = handler;
  if (!current) {
    throw new Error('Worker received a request before it was initialized');
  }
  // A failing request is a defect of the worker: it exits and the pool reports and replaces it.
  Promise.resolve()
    .then(() => current.request(body))
    .then(
      (result) => {
        send({ type: 'response', id, body: result });
      },
      (error: unknown) => {
        console.error(errorMessage(error));
        process.exit(1);
      },
    );
}

process.on('disconnect', () => {
  process.exit(0);
});

process.on('message', (raw) => {
  const message = raw as ParentMessage;
  switch (message.type) {
    case 'init':
      void initialize(message);
      return;
    case 'request':
      serve(message.id, message.body);
      return;
    case 'notice':
      handler?.notice(message.body);
      return;
    case 'event':
      for (const listener of listeners.get(message.event) ?? []) {
        try {
          listener(message.data);
        } catch (error) {
          console.error(errorMessage(error));
        }
      }
      return;
    case 'callResult': {
      const call = calls.get(message.id);
      if (!call) {
        return;
      }
      calls.delete(message.id);
      if (message.ok) {
        call.resolve(message.value);
      } else {
        call.reject(new Error(message.error));
      }
      return;
    }
  }
});
