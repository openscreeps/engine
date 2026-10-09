/*
 * Sandbox `console` with visual buffers (screeps/engine `src/game/console.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { jsString } from '../../utils/js.ts';
import { isString } from '../../utils/lodash.ts';

export interface ConsoleMessage {
  message: string;
  /** `false` for `console.logUnsafe` output (HTML allowed by clients). */
  escape: boolean;
}

export interface SandboxConsole {
  log(...args: unknown[]): void;
  logUnsafe(...args: unknown[]): void;
  commandResult(message: unknown): void;
  addVisual(roomName: string | undefined, data: unknown): void;
  getVisualSize(roomName: string | undefined): number;
  clearVisual(roomName: string | undefined): void;
  getVisual(roomName: string | undefined): string | undefined;
}

let messages: ConsoleMessage[] = [];
let commandResults: string[] = [];
let visual: Record<string, string> = {};

function formatArguments(args: readonly unknown[]): string {
  return args
    .map((i): unknown => {
      if (i) {
        const toString: unknown = Reflect.get(Object(i), 'toString');
        if (toString) {
          return Reflect.apply(toString as (this: unknown) => unknown, i, []);
        }
      }
      if (typeof i === 'undefined') {
        return 'undefined';
      }
      return JSON.stringify(i);
    })
    .join(' ');
}

function log(...args: unknown[]): void {
  messages.push({ message: formatArguments(args), escape: true });
}

function logUnsafe(...args: unknown[]): void {
  messages.push({ message: formatArguments(args), escape: false });
}

function commandResult(message: unknown): void {
  commandResults.push(jsString(message));
}

function addVisual(roomName: string | undefined, data: unknown): void {
  const room = roomName || '';
  if (!data) {
    return;
  }
  const sizeLimit = room == 'map' ? 1000 : 500;
  const existing = visual[room] || '';
  visual[room] = existing;
  const dataString = isString(data) ? jsString(data) : JSON.stringify(data) + '\n';
  if (existing.length + dataString.length > sizeLimit * 1024) {
    if (room == 'map') {
      throw new Error(`MapVisual size has exceeded ${String(sizeLimit)} KB limit`);
    }
    throw new Error(`RoomVisual size in room ${room} has exceeded ${String(sizeLimit)} KB limit`);
  }
  visual[room] = existing + dataString;
}

function getVisualSize(roomName: string | undefined): number {
  const data = visual[roomName || ''];
  return data ? data.length : 0;
}

function clearVisual(roomName: string | undefined): void {
  visual[roomName || ''] = '';
}

function getRoomVisual(roomName: string | undefined): string | undefined {
  return visual[roomName || ''];
}

/** Creates the null-prototype console of a new tick and resets the buffers. */
export function makeConsole(): SandboxConsole {
  messages = [];
  commandResults = [];
  visual = {};
  return Object.create(null, {
    log: { writable: true, configurable: true, value: log },
    logUnsafe: { writable: true, configurable: true, value: logUnsafe },
    commandResult: { value: commandResult },
    addVisual: { value: addVisual },
    getVisualSize: { value: getVisualSize },
    clearVisual: { value: clearVisual },
    getVisual: { value: getRoomVisual },
  }) as SandboxConsole;
}

export function getMessages(): ConsoleMessage[] {
  const result = messages;
  messages = [];
  return result;
}

export function getCommandResults(): string[] {
  const result = commandResults;
  commandResults = [];
  return result;
}

export function getVisual(): Record<string, string> {
  const result = visual;
  visual = {};
  return result;
}
