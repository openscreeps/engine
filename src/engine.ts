import {
  BotRuntime,
  type BotRuntimeOptions,
  type CodeModules,
  type RuntimeSnapshot,
  type TickRunResult,
} from './runtime/index.ts';
import {
  Simulation,
  type SimulationOptions,
  type TickIntents,
  type TickResult,
  type WorldState,
} from './simulation/index.ts';

export interface EngineSnapshot {
  world: WorldState;
  runtime: RuntimeSnapshot;
}

export interface EngineOptions {
  simulation?: SimulationOptions;
  runtime?: BotRuntimeOptions;
}

export interface EngineTickResult {
  simulation: TickResult;
  runtime: TickRunResult;
}

/** A single world with persistent player runtimes, without storage or server dependencies. */
export class Engine implements Disposable {
  readonly #simulation: Simulation;
  readonly #runtime: BotRuntime;
  #running = false;
  #disposed = false;

  constructor(world: WorldState, options: EngineOptions = {}) {
    this.#simulation = new Simulation(world, options.simulation);
    this.#runtime = new BotRuntime(options.runtime);
  }

  static restore(snapshot: EngineSnapshot, options: EngineOptions = {}): Engine {
    return new Engine(snapshot.world, {
      ...options,
      runtime: { ...options.runtime, snapshot: snapshot.runtime },
    });
  }

  setCode(userId: string, modules: CodeModules, branch?: string): void {
    this.#assertIdle();
    this.#runtime.setCode(userId, modules, branch);
  }

  setMemory(userId: string, raw: string): void {
    this.#assertIdle();
    this.#runtime.setMemory(userId, raw);
  }

  getMemory(userId: string): string {
    this.#assertIdle();
    return this.#runtime.getMemory(userId);
  }

  /** Execute player code against this tick's state before resolving all collected intents. */
  async tick(): Promise<EngineTickResult> {
    this.#assertIdle();
    this.#running = true;
    try {
      const runtime = await this.#runtime.runTick(this.#simulation.state);
      const simulation = this.#simulation.tick(runtime.intents);
      return { simulation, runtime };
    } finally {
      this.#running = false;
    }
  }

  /** Resolve explicit intents without running player scripts. */
  processIntents(intents: TickIntents): TickResult {
    this.#assertIdle();
    this.#running = true;
    try {
      return this.#simulation.tick(intents);
    } finally {
      this.#running = false;
    }
  }

  /** Persisted state only: V8 heap/global variables are recreated after restoration. */
  snapshot(): EngineSnapshot {
    this.#assertIdle();
    return { world: this.#simulation.snapshot(), runtime: this.#runtime.snapshot() };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#assertIdle();
    this.#runtime.dispose();
    this.#disposed = true;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error('Engine is disposed');
    if (this.#running) throw new Error('Engine tick is already running');
  }
}
