'use strict';
/*
 * Runs the pinned screeps/storage server unmodified in its own process, as the launcher does
 * (`bin/start.js` → `lib/index.js` `start()`: LokiJS database, lib/db.js, lib/queue.js, lib/pubsub.js
 * served over @screeps/common's RPC). Its Math.random and clock are the real ones, as in production;
 * storage-generated ids are therefore random and normalized by the comparator.
 *
 * Environment: SIMULATION_REFERENCE_ROOT, STORAGE_PORT, STORAGE_HOST, DB_PATH, MODFILE.
 */
import type { ModuleInternals } from './upstream.ts';
import type * as Path from 'node:path';
import type ModuleType from 'node:module';
import type * as AssertHelpers from '../assert.ts';
const { required } = require('../assert.ts') as typeof AssertHelpers;
const path = require('node:path') as typeof Path;
const Module = require('node:module') as typeof ModuleType & ModuleInternals;

const REF = required(process.env.SIMULATION_REFERENCE_ROOT);

// @screeps/common is a launcher-provided peer dependency of storage: use the engine-pinned common.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveForStorage(
  this: typeof Module,
  request,
  parent,
  isMain,
  options,
) {
  if (request === '@screeps/common' || request.startsWith('@screeps/common/')) {
    const target = path.join(REF, 'common') + request.slice('@screeps/common'.length);
    return originalResolve.call(this, target, parent, isMain, options);
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

// A fresh database holding only an empty `env` collection: `upgradeDb` then returns before any legacy
// migration, and the oracle populates collections through the storage RPC like the backend does.
interface LokiDatabase {
  addCollection(name: string): unknown;
  saveDatabase(callback: (error?: Error | null) => void): void;
}
const Loki = require(path.join(REF, 'storage/node_modules/lokijs')) as new (
  filename: string,
) => LokiDatabase;
const seed = new Loki(required(process.env.DB_PATH));
seed.addCollection('env');
seed.saveDatabase((error) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const storage = require(path.join(REF, 'storage/lib/index.js')) as { start(): void };
  storage.start();
});

process.on('disconnect', () => process.exit());
