/*
 * Builds the runtime bundle (game API + lodash 3.10.1) that is evaluated inside each player sandbox.
 * Works from TypeScript sources (tests/smoke runs) and from the compiled `dist` output alike.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let bundlePromise: Promise<string> | undefined;

function entryPath(): string {
    for (const candidate of ['../sandbox/entry.ts', '../sandbox/entry.js']) {
        const path = fileURLToPath(new URL(candidate, import.meta.url));
        if (existsSync(path)) {
            return path;
        }
    }
    throw new Error('Runtime sandbox entry (sandbox/entry.ts or sandbox/entry.js) was not found');
}

async function buildBundle(): Promise<string> {
    const result = await build({
        entryPoints: [entryPath()],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'neutral',
        mainFields: ['main', 'module'],
        target: 'es2022',
        legalComments: 'inline',
        logLevel: 'silent',
    });
    const output = result.outputFiles[0];
    if (!output) {
        throw new Error('Runtime bundle build produced no output');
    }
    return output.text;
}

/** The runtime bundle source; built once per process and shared read-only by all sandboxes. */
export function getRuntimeBundle(): Promise<string> {
    bundlePromise ??= buildBundle().catch((error: unknown) => {
        bundlePromise = undefined;
        throw error;
    });
    return bundlePromise;
}
