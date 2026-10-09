// Builds and loads the authentic native path finder of the pinned screeps/driver checkout.
//
// Only the addon's build toolchain (nan + node-gyp, at the exact versions and integrity hashes of the
// pinned driver package-lock.json) is installed, into `.reference/driver-native-tools`, outside the driver
// checkout; the rest of the driver dependency tree (isolated-vm fork, webpack, ...) is never installed.
// node-gyp then compiles the pinned `native/` sources in place; its `native/build` output directory is
// ignored by the upstream checkout, so tracked reference files stay untouched (re-verified afterwards).
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceRoot, verifyReferences } from './references.mjs';

const driverRoot = resolve(referenceRoot, 'driver');
const nativeRoot = resolve(driverRoot, 'native');
/**
 * The compiled addon. Upstream user-vm.js loads this same file into player isolates with
 * `new ivm.NativeModule(path).create(context)` (exposed as `_nativeMod`); terrain loaded through the
 * host-side addon (`loadNativePathFinder()` + driver `lib/path-finder.js` `init`) is process-global
 * and therefore visible to those isolate instances. Call `loadNativePathFinder()` first to fail closed.
 */
export const nativePathFinderAddonPath = resolve(nativeRoot, 'build', 'Release', 'native.node');
const addonPath = nativePathFinderAddonPath;
const stampPath = resolve(nativeRoot, 'build', 'openscreeps-native.json');
const toolsRoot = resolve(referenceRoot, 'driver-native-tools');
const toolPackages = ['nan', 'node-gyp'];
const expectedVersion = 11;
const require = createRequire(import.meta.url);

/** Dependency closure of `names` from an npm v2/v3 lockfile, following npm's nested-then-hoisted lookup. */
function lockSubset(lock, names) {
  const packages = lock.packages;
  const selected = {};
  const resolveFrom = (from, name) => {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return undefined;
      const index = base.lastIndexOf('/node_modules/');
      base = index === -1 ? '' : base.slice(0, index);
    }
  };
  const visit = (from, name, optional) => {
    const key = resolveFrom(from, name);
    if (!key) {
      if (optional) return;
      throw new Error(
        `driver package-lock.json has no entry for ${name} (required from ${from || '<root>'})`,
      );
    }
    if (selected[key]) return;
    selected[key] = packages[key];
    const entry = packages[key];
    for (const dependency of Object.keys(entry.dependencies ?? {})) visit(key, dependency, false);
    for (const dependency of Object.keys(entry.optionalDependencies ?? {}))
      visit(key, dependency, true);
    for (const [dependency] of Object.entries(entry.peerDependencies ?? {}))
      if (!entry.peerDependenciesMeta?.[dependency]?.optional) visit(key, dependency, false);
  };
  for (const name of names) visit('', name, false);
  return selected;
}

function toolchainManifest() {
  const lock = JSON.parse(readFileSync(resolve(driverRoot, 'package-lock.json'), 'utf8'));
  const dependencies = {};
  for (const name of toolPackages) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry) throw new Error(`driver package-lock.json does not pin ${name}`);
    dependencies[name] = entry.version;
  }
  const manifest = {
    name: 'openscreeps-driver-native-tools',
    version: '0.0.0',
    private: true,
    dependencies,
  };
  const subset = lockSubset(lock, toolPackages);
  const packageLock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: manifest.name, version: manifest.version, dependencies }, ...subset },
  };
  return { manifest, packageLock };
}

function installToolchain() {
  const { manifest, packageLock } = toolchainManifest();
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const lockText = `${JSON.stringify(packageLock, null, 2)}\n`;
  const installed = toolPackages.every((name) => {
    const path = resolve(toolsRoot, 'node_modules', name, 'package.json');
    return (
      existsSync(path) &&
      JSON.parse(readFileSync(path, 'utf8')).version === manifest.dependencies[name]
    );
  });
  const current =
    existsSync(resolve(toolsRoot, 'package.json')) &&
    readFileSync(resolve(toolsRoot, 'package.json'), 'utf8') === manifestText &&
    existsSync(resolve(toolsRoot, 'package-lock.json')) &&
    readFileSync(resolve(toolsRoot, 'package-lock.json'), 'utf8') === lockText;
  if (installed && current) return manifest.dependencies;
  mkdirSync(toolsRoot, { recursive: true });
  writeFileSync(resolve(toolsRoot, 'package.json'), manifestText);
  writeFileSync(resolve(toolsRoot, 'package-lock.json'), lockText);
  execSync('npm ci --ignore-scripts --no-audit --no-fund', { cwd: toolsRoot, stdio: 'inherit' });
  return manifest.dependencies;
}

function buildStamp(tools) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: driverRoot,
    encoding: 'utf8',
  }).trim();
  return {
    driver: commit,
    tools,
    node: process.version,
    modules: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  };
}

function readStamp() {
  return existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : undefined;
}

/**
 * Compiles `.reference/driver/native` (pinned driver) with the pinned nan/node-gyp toolchain unless an
 * up-to-date build for this Node ABI already exists. Requires network access (node headers) and a C++20
 * toolchain (MSVC on Windows; python3, make and g++ elsewhere).
 */
export function prepareNativePathFinder() {
  verifyReferences(['driver']);
  const tools = installToolchain();
  const stamp = `${JSON.stringify(buildStamp(tools), null, 2)}\n`;
  if (readStamp() !== stamp || !existsSync(addonPath)) {
    rmSync(stampPath, { force: true });
    const toolModules = resolve(toolsRoot, 'node_modules');
    execFileSync(
      process.execPath,
      [resolve(toolModules, 'node-gyp', 'bin', 'node-gyp.js'), 'rebuild', '-C', nativeRoot],
      {
        cwd: nativeRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_PATH: [toolModules, process.env.NODE_PATH].filter(Boolean).join(delimiter),
        },
      },
    );
    writeFileSync(stampPath, stamp);
  }
  verifyReferences(['driver']);
  loadNativePathFinder();
}

/**
 * Loads the pinned driver's native path finder addon; throws (never falls back) when the pinned checkout,
 * the build, or its ABI stamp is missing or stale.
 */
export function loadNativePathFinder() {
  verifyReferences(['driver']);
  const hint =
    'run `npm run conformance:setup` (needs node-gyp prerequisites: C++ toolchain and python3)';
  if (!existsSync(addonPath))
    throw new Error(`native path finder is not built at ${addonPath}; ${hint}`);
  const stamp = readStamp();
  if (!stamp)
    throw new Error(`native path finder build at ${addonPath} has no build stamp; ${hint}`);
  const recorded = JSON.parse(stamp);
  const expected = buildStamp(recorded.tools);
  for (const key of ['driver', 'modules', 'platform', 'arch'])
    if (recorded[key] !== expected[key])
      throw new Error(
        `native path finder was built for ${key}=${recorded[key]}, current ${key}=${expected[key]}; ${hint}`,
      );
  const addon = require(addonPath);
  if (
    addon.version !== expectedVersion ||
    typeof addon.search !== 'function' ||
    typeof addon.loadTerrain !== 'function'
  )
    throw new Error(
      `unexpected native path finder binary (version ${addon.version}) at ${addonPath}`,
    );
  return addon;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareNativePathFinder();
