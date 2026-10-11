/*
 * Worker setup module for the worker pool tests: a trusted `playerSandbox` hook in runner processes
 * and room hooks in processor processes, both reporting the process they run in.
 */

import { existsSync, writeFileSync } from 'node:fs';
import type { WorkerSetupFunction } from '../../src/index.ts';

interface SetupData {
  /** Processor processes exit while processing this room. */
  crashRoom?: string;
  /** With `crashRoom`: exit only while this file does not exist yet (it is created first). */
  crashOnceMarker?: string;
}

const setup: WorkerSetupFunction = (data, kind, host) => {
  const options = (data ?? {}) as SetupData;
  let greeting: unknown = null;
  host.on('greeting', (value) => {
    greeting = value;
  });
  if (kind === 'runner') {
    return {
      playerSandbox(sandbox, userId) {
        sandbox.set('hostPid', process.pid);
        sandbox.set('greeting', greeting);
        host.call('ran', userId, process.pid).catch(() => undefined);
      },
    };
  }
  return {
    hooks: {
      processRoom(scope) {
        scope.stats.inc(`pid${String(process.pid)}`, 'processor', 1);
        if (scope.roomName !== options.crashRoom) {
          return;
        }
        if (options.crashOnceMarker === undefined || !existsSync(options.crashOnceMarker)) {
          if (options.crashOnceMarker !== undefined) {
            writeFileSync(options.crashOnceMarker, String(process.pid));
          }
          process.exit(3);
        }
      },
    },
  };
};

export default setup;
