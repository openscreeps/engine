/*
 * First module of the runtime bundle: installs the world's constants (a copy the host places in the
 * `_constants` global before evaluating the bundle, like screeps/driver `user-vm.js`) so every other
 * runtime module, including module-level tables, evaluates with them. Without the global (bare
 * bundle harnesses) the defaults stay active. The global is removed before any player code runs.
 */

import { installConstants, type Constants } from '../../constants.ts';

const constants: unknown = Reflect.get(globalThis, '_constants');
Reflect.deleteProperty(globalThis, '_constants');
if (constants !== undefined) {
  // Trusted host data: an isolate-local copy of the world's constants object.
  installConstants(constants as Constants);
}
