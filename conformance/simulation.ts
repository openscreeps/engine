#!/usr/bin/env node
/*
 * Differential conformance of the local `Simulation` against the pinned upstream server processes.
 *
 *   node conformance/simulation.ts [--scenario name[,name...]] [--controlled-order] [--full]
 *
 * For every scenario the pinned engine main loop and room processor run in a child process
 * (simulation/oracle.cts) against the pinned screeps/storage server (its own process); the local
 * Simulation runs the same fixture and intents tick by tick with the oracle's runner order. Every
 * tick's world, event logs, map views, room history, room stats, processing errors and random
 * generator state are compared. Prints one JSON report.
 *
 * By default each side derives its own processing order (independent, end-to-end); per-room object order
 * and room order are compared every tick. `--controlled-order` imposes the oracle's order on the local
 * world (diagnostic mode isolating rules from ordering; reported as `controlledProcessingOrder`).
 *
 * Status per scenario: match | mismatch (unexplained difference) | divergent (only differences of a
 * named, asserted divergence; reported separately, not a match) | vacuous (a coverage check failed) |
 * error. Exit code 0 only if every selected scenario matches, unless
 * --allow-known-divergences explicitly accepts the named, two-sided assertions.
 */
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { required } from './assert.ts';
import { referenceRoot, verifyReferences } from './references.ts';
import { createComparator } from './simulation/compare.ts';
import { globalDivergences } from './simulation/divergences.ts';
import { createLocalRunner } from './simulation/local.ts';
import { scenarios } from './simulation/scenarios.ts';
import type {
  CoverageCheck,
  Options,
  OracleResult,
  ProcessingOrder,
  Scenario,
  TickRecord,
  TimedDifference,
} from './simulation/types.ts';
import type { ScenarioReport } from './simulation/report.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCES = ['engine', 'common', 'driver', 'storage'];
const MAX_DIFFERENCES = 30;
const ORACLE_TIMEOUT_MS = 120_000;

const METHOD = {
  executedUpstream: [
    'storage lib/index.js start(): LokiJS db, lib/db.js, lib/queue.js, lib/pubsub.js (separate process, real Math.random/clock)',
    'common lib/storage.js client over lib/rpc.js TCP framing',
    'engine src/main.js main loop (users queue, rooms queue, commit, global stage, game-time increment, notifyRoomsDone)',
    'engine src/processor.js room processor loop and processRoom, all processor/intents, processor/global.js with market and power',
    'engine utils.storeIntents (runner-side intent sanitizing, as driver runtime/make.js) and common lib/system.js',
    'driver lib/index.js (saveUserIntents, getRoomObjects, getInterRoom, bulk*, sendNotification, activateRoom, history, mapViewSave, saveRoomEventLog), lib/bulk.js, lib/queue.js, lib/history.js',
  ],
  replacedOrObserved: [
    "runner: one runner thread saves each selected user's scripted intents (no player code; runtime conformance is separate)",
    'driver native PathFinder addon: stub, search() throws (NPC paths excluded); runtime/user-vm, runtime/make, generic-pool, he: stubs that throw if reached',
    'driver npm dependencies resolved from the engine checkout (q, lodash 3.10.1); @screeps/common resolved to the pinned common checkout',
    'driver.getRoomStatsUpdater wrapped to record increments (the private driver never persists them)',
    'driver.config events processorLoopStage/processObject and mainLoopCustomStage used to record processed rooms, iteration order and to snapshot storage after each tick',
    'Math.random replaced by mulberry32 seeded from world.rngState (draws during module evaluation use a separate stream); Date/Date.now derived from the processed game time',
  ],
  replayedIntoLocal: [
    'users and order of the oracle runner (upstream runner threads race)',
    'only with --controlled-order: per-room object processing order observed in the oracle (storage-defined: Loki adaptive binary index returns most recently inserted/updated documents first); the local order is verified to equal it',
  ],
  normalizations: [
    'storage-generated ids paired by raw id or content (random in screeps/storage)',
    'Loki $loki/meta bookkeeping removed from documents and history objects',
    'processedRooms compared as a set (room order is compared through the per-tick processing order); activeRooms compared in order',
    'rooms without room-stat increments dropped',
  ],
  exclusions: [
    'native PathFinder searches: invader AI and keepers that must walk, findPath-based NPC movement',
    'server-written objectsManual (sim-room genEnergy), stronghold deployment, nuke landing (50000 ticks), intershard portals',
    'player code execution, CPU/memory/segments (runtime conformance)',
    'backend cron jobs (market stats, room activation, NPC world generation)',
    'races between parallel runner threads and processor workers (one sequential interleaving is used)',
  ],
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    only: null,
    full: false,
    controlledOrder: false,
    allowKnownDivergences: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = required(argv[i]);
    if (arg === '--full') options.full = true;
    else if (arg === '--controlled-order') options.controlledOrder = true;
    else if (arg === '--allow-known-divergences') options.allowKnownDivergences = true;
    else if (arg === '--scenario')
      options.only = [...(options.only ?? []), ...required(argv[++i]).split(',')];
    else if (arg.startsWith('--scenario='))
      options.only = [...(options.only ?? []), ...arg.slice(11).split(',')];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function runOracle(scenario: Scenario): Promise<OracleResult> {
  const { promise, resolve: resolvePromise } = Promise.withResolvers<OracleResult>();
  const child = fork(resolve(here, 'simulation/oracle.cts'), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
  });
  let output = '';
  required(child.stdout).on('data', (chunk: Buffer) => (output += chunk.toString()));
  required(child.stderr).on('data', (chunk: Buffer) => (output += chunk.toString()));
  let settled = false;
  const settle = (result: OracleResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise(result);
  };
  const timer = setTimeout(() => {
    child.kill();
    settle({
      error: `oracle timed out after ${String(ORACLE_TIMEOUT_MS)} ms`,
      ticks: [],
      logs: [{ text: output.slice(-4000) }],
    });
  }, ORACLE_TIMEOUT_MS);
  child.on('message', (message) => {
    settle(message as OracleResult);
  });
  child.on('exit', (code) => {
    settle({
      error: `oracle exited with code ${String(code)}`,
      ticks: [],
      logs: [{ text: output.slice(-4000) }],
    });
  });
  child.send({ type: 'run', referenceRoot, scenario });
  return promise;
}

function summarizeValue(value: unknown): unknown {
  const text = JSON.stringify(value) as string | undefined;
  return text !== undefined && text.length > 400 ? `${text.slice(0, 400)}…` : value;
}

function evaluate(check: CoverageCheck, ticks: TickRecord[]): boolean {
  try {
    return ticks.length > 0 && check(ticks) === true;
  } catch {
    return false;
  }
}

/** Rooms whose object processing order differs, and `*rooms*` when the room processing order differs. */
function orderDifferences(oracleOrder: ProcessingOrder, localOrder: ProcessingOrder) {
  const rooms = [];
  if (JSON.stringify(Object.keys(oracleOrder)) !== JSON.stringify(Object.keys(localOrder)))
    rooms.push('*rooms*');
  for (const room of new Set([...Object.keys(oracleOrder), ...Object.keys(localOrder)])) {
    if (JSON.stringify(oracleOrder[room] ?? []) !== JSON.stringify(localOrder[room] ?? []))
      rooms.push(room);
  }
  return rooms;
}

async function runScenario(scenario: Scenario, options: Options): Promise<ScenarioReport> {
  const oracle = await runOracle(scenario);
  const local: TickRecord[] = [];
  const comparator = createComparator(scenario.world);
  const differences: TimedDifference[] = [];
  const orderDiffering: Array<{
    gameTime: number;
    room: string;
    oracle: string[] | undefined;
    local: string[] | undefined;
  }> = [];
  // Tick by tick: the local tick uses the oracle tick's runner order (and, with --controlled-order, its
  // per-room processing order, translating generated ids through the pairing of earlier ticks).
  const localRunner = createLocalRunner(scenario, { controlledOrder: options.controlledOrder });
  for (let i = 0; i < Math.min(scenario.ticks.length, oracle.ticks.length); i++) {
    const oracleTick = required(oracle.ticks[i]);
    const localTick = localRunner.step(i, oracleTick, (id) => comparator.localIdOf(id));
    local.push(localTick);
    const localOrder = comparator.labelOrder(localTick.objectOrder);
    for (const room of orderDifferences(oracleTick.objectOrder, localOrder)) {
      const pick = (order: ProcessingOrder) =>
        room === '*rooms*' ? Object.keys(order) : order[room];
      const entry = {
        gameTime: oracleTick.gameTime,
        room,
        oracle: pick(oracleTick.objectOrder),
        local: pick(localOrder),
      };
      orderDiffering.push(entry);
      // Independent order is itself engine behavior, even when it does not change state.
      if (!options.controlledOrder) {
        differences.push({
          gameTime: entry.gameTime,
          path: `processingOrder.${entry.room}`,
          oracle: entry.oracle,
          local: entry.local,
        });
      }
    }
    for (const difference of comparator.compareTick(oracleTick, localTick)) {
      differences.push({ gameTime: oracleTick.gameTime, ...difference });
    }
  }

  // Named divergences: a difference is attributed when its path matches and `accept` (if declared)
  // holds for its exact values; scenario divergences also require their assertions on both runs.
  const declared = [...globalDivergences, ...(scenario.divergences ?? [])];
  const divergences = declared.map((divergence) => ({
    name: divergence.name,
    kind: divergence.kind,
    reason: divergence.reason,
    assertions: {
      oracle: divergence.oracle ? evaluate(divergence.oracle, oracle.ticks) : 'per-difference',
      local: divergence.local ? evaluate(divergence.local, local) : 'per-difference',
    },
    differences: [] as TimedDifference[],
  }));
  const unexplained: TimedDifference[] = [];
  for (const difference of differences) {
    const index = declared.findIndex(
      (d) =>
        d.paths.some((pattern) => pattern.test(difference.path)) &&
        (!d.accept || d.accept(difference)),
    );
    if (index === -1) unexplained.push(difference);
    else required(divergences[index]).differences.push(difference);
  }
  const brokenDivergences = divergences.filter(
    (d) => d.differences.length && (d.assertions.oracle === false || d.assertions.local === false),
  );

  const checks = Object.entries(scenario.checks ?? {}).map(([name, check]) => ({
    name,
    oracle: evaluate(check, oracle.ticks),
    local: evaluate(check, local),
  }));
  const failedChecks = checks.filter((check) => !check.oracle || !check.local);
  const unexplainedTicks = unexplained.map((d) => d.gameTime);
  // With a controlled order, the replayed processing order must actually have been reproduced.
  const orderNotReproduced = options.controlledOrder && orderDiffering.length > 0;
  const status =
    oracle.error ||
    oracle.ticks.length < scenario.ticks.length ||
    brokenDivergences.length ||
    orderNotReproduced
      ? 'error'
      : unexplained.length
        ? 'mismatch'
        : failedChecks.length
          ? 'vacuous'
          : divergences.some((d) => d.differences.length)
            ? 'divergent'
            : 'match';
  const shown = (list: TimedDifference[]) =>
    (options.full ? list : list.slice(0, MAX_DIFFERENCES)).map((d) => ({
      gameTime: d.gameTime,
      path: d.path,
      oracle: summarizeValue(d.oracle),
      local: summarizeValue(d.local),
    }));
  const report: ScenarioReport = {
    name: scenario.name,
    status,
    description: scenario.description,
    ticks: { planned: scenario.ticks.length, oracle: oracle.ticks.length, compared: local.length },
    coverage: scenario.coverage,
    checks: { passed: checks.length - failedChecks.length, failed: failedChecks },
    processingOrder: {
      controlled: options.controlledOrder,
      roomTicksDiffering: orderDiffering.length,
      firstDiffering: orderDiffering[0] ?? null,
    },
    firstMismatchTick: unexplainedTicks.length ? Math.min(...unexplainedTicks) : null,
    differenceCount: unexplained.length,
    differences: shown(unexplained),
    divergences: divergences
      .filter((d) => d.differences.length)
      .map((d) => ({
        name: d.name,
        kind: d.kind,
        reason: d.reason,
        assertions: d.assertions,
        differenceCount: d.differences.length,
        differences: shown(d.differences),
      })),
    normalization: comparator.stats,
    oracleRoomErrors: oracle.ticks.flatMap((t) =>
      t.roomErrors.map((e) => ({ gameTime: t.gameTime, ...e })),
    ),
    localRoomErrors: local.flatMap((t) =>
      t.roomErrors.map((e) => ({ gameTime: t.gameTime, ...e })),
    ),
  };
  if (oracle.error) {
    report.oracleError = oracle.error;
    report.oracleLogs = (oracle.logs ?? []).map((l) => l.text).slice(0, 10);
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  verifyReferences(REFERENCES);
  const pins = JSON.parse(
    readFileSync(resolve(here, '../reference-versions.json'), 'utf8'),
  ) as Record<string, { commit: string }>;
  if (options.only) {
    const unknown = options.only.filter((name) => !scenarios.some((s) => s.name === name));
    if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  }
  const selected = options.only
    ? scenarios.filter((s) => required(options.only).includes(s.name))
    : scenarios;

  const reports: ScenarioReport[] = [];
  for (const scenario of selected) reports.push(await runScenario(scenario, options));

  const count = (status: string) => reports.filter((r) => r.status === status).length;
  const summary = {
    scenarios: reports.length,
    matched: count('match'),
    mismatched: count('mismatch'),
    divergent: count('divergent'),
    vacuous: count('vacuous'),
    errors: count('error'),
    ticksCompared: reports.reduce((sum, r) => sum + r.ticks.compared, 0),
  };
  const method = options.controlledOrder
    ? {
        ...METHOD,
        exclusions: [
          ...METHOD.exclusions,
          'independent storage ordering: per-room processing order is replayed from the oracle (--controlled-order); run without it for end-to-end order behavior',
        ],
      }
    : METHOD;
  const result = {
    oracle: Object.fromEntries(REFERENCES.map((name) => [name, required(pins[name]).commit])),
    controlledProcessingOrder: options.controlledOrder,
    allowKnownDivergences: options.allowKnownDivergences,
    summary,
    coverage: [...new Set(reports.flatMap((r) => r.coverage))].sort(),
    divergencesDeclared: [
      ...globalDivergences,
      ...scenarios.flatMap((s) => s.divergences ?? []),
    ].map((d) => ({
      name: d.name,
      kind: d.kind,
    })),
    method,
    scenarios: reports,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode =
    summary.mismatched === 0 &&
    summary.errors === 0 &&
    summary.vacuous === 0 &&
    (summary.divergent === 0 || options.allowKnownDivergences)
      ? 0
      : 1;
}

main().catch((error: unknown) => {
  const text =
    error !== null &&
    typeof error === 'object' &&
    'stack' in error &&
    typeof error.stack === 'string'
      ? error.stack
      : String(error);
  process.stderr.write(`${text}\n`);
  process.exitCode = 2;
});
