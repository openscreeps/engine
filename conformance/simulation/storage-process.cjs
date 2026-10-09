'use strict';
/*
 * Runs the pinned screeps/storage server unmodified in its own process, as the launcher does
 * (`bin/start.js` → `lib/index.js` `start()`: LokiJS database, lib/db.js, lib/queue.js, lib/pubsub.js
 * served over @screeps/common's RPC). Its Math.random and clock are the real ones, as in production;
 * storage-generated ids are therefore random and normalized by the comparator.
 *
 * Environment: SIMULATION_REFERENCE_ROOT, STORAGE_PORT, STORAGE_HOST, DB_PATH, MODFILE.
 */
const path = require('path');
const Module = require('module');

const REF = process.env.SIMULATION_REFERENCE_ROOT;

// @screeps/common is a launcher-provided peer dependency of storage: use the engine-pinned common.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveForStorage(request, parent, isMain, options) {
  if (request === '@screeps/common' || request.startsWith('@screeps/common/')) {
    const target = path.join(REF, 'common') + request.slice('@screeps/common'.length);
    return originalResolve.call(this, target, parent, isMain, options);
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

// A fresh database holding only an empty `env` collection: `upgradeDb` then returns before any legacy
// migration, and the oracle populates collections through the storage RPC like the backend does.
const loki = require(path.join(REF, 'storage/node_modules/lokijs'));
const seed = new loki(process.env.DB_PATH);
seed.addCollection('env');
seed.saveDatabase((error) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }
  require(path.join(REF, 'storage/lib/index.js')).start();
});

process.on('disconnect', () => process.exit());
