/*
 * Validation of untrusted sandbox output. Player code shares the realm that produced the message,
 * so every field is checked before the host uses it.
 */

import { isPlainObject } from '../game/compat.ts';
import type { ConsoleMessage } from '../game/console.ts';
import type { IntentList } from '../game/intents.ts';
import type { ActiveForeignSegment } from '../game/raw-memory.ts';
import type { SandboxResultMessage, SandboxRunMessage } from '../protocol.ts';

const SEGMENT_LIMIT = 100 * 1024;
const INTER_SHARD_LIMIT = 100 * 1024;

class InvalidMessage extends Error {}
function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new InvalidMessage(`${field} is not an object`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidMessage(`${field} is not a finite number`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidMessage(`${field} is not a string`);
  }
  return value;
}

function segmentId(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 99) {
    throw new InvalidMessage(`${field} is not a segment id`);
  }
  return value;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const record = requireRecord(value, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    result[key] = requireString(item, `${field}.${key}`);
  }
  return result;
}

function intentList(value: unknown): IntentList {
  const record = requireRecord(value, 'intentsList');
  const result: IntentList = {};
  for (const [key, entry] of Object.entries(record)) {
    if (Array.isArray(entry)) {
      result[key] = entry;
    } else {
      result[key] = requireRecord(entry, `intentsList.${key}`);
    }
  }
  return result;
}

function consoleMessages(value: unknown): ConsoleMessage[] {
  if (!Array.isArray(value)) {
    throw new InvalidMessage('console.log is not an array');
  }
  return value.map((item: unknown, index) => {
    const message = requireRecord(item, `console.log.${String(index)}`);
    if (typeof message.escape !== 'boolean') {
      throw new InvalidMessage('console message escape flag is invalid');
    }
    return { message: requireString(message.message, 'console message'), escape: message.escape };
  });
}

function runMessage(record: Record<string, unknown>, type: 'done' | 'error'): SandboxRunMessage {
  const consoleOutput = requireRecord(record.console, 'console');
  const results = consoleOutput.results;
  if (!Array.isArray(results)) {
    throw new InvalidMessage('console.results is not an array');
  }
  const message: SandboxRunMessage = {
    type,
    intentsList: intentList(record.intentsList),
    intentsCpu: finiteNumber(record.intentsCpu, 'intentsCpu'),
    memory: requireString(record.memory, 'memory'),
    console: {
      log: consoleMessages(consoleOutput.log),
      results: results.map((item: unknown) => requireString(item, 'console result')),
    },
  };
  if (record.error !== undefined) {
    message.error = requireString(record.error, 'error');
  }
  if (record.memorySegments !== undefined) {
    const segments = stringRecord(record.memorySegments, 'memorySegments');
    const keys = Object.keys(segments);
    if (keys.length > 10) {
      throw new InvalidMessage('too many memory segments');
    }
    const result: Record<number, string> = {};
    for (const key of keys) {
      const data = segments[key] ?? '';
      if (data.length > SEGMENT_LIMIT) {
        throw new InvalidMessage('memory segment exceeds 100 KB');
      }
      result[segmentId(Number(key), 'memorySegments key')] = data;
    }
    message.memorySegments = result;
  }
  if (record.visual !== undefined) {
    message.visual = stringRecord(record.visual, 'visual');
  }
  if (record.activeSegments !== undefined) {
    if (!Array.isArray(record.activeSegments) || record.activeSegments.length > 10) {
      throw new InvalidMessage('activeSegments is invalid');
    }
    message.activeSegments = record.activeSegments.map((id: unknown) =>
      segmentId(id, 'activeSegments'),
    );
  }
  if (record.activeForeignSegment !== undefined) {
    if (record.activeForeignSegment === null) {
      message.activeForeignSegment = null;
    } else {
      const foreign = requireRecord(record.activeForeignSegment, 'activeForeignSegment');
      const selection: ActiveForeignSegment = {
        username: requireString(foreign.username, 'activeForeignSegment.username'),
        id: foreign.id === undefined ? undefined : segmentId(foreign.id, 'activeForeignSegment.id'),
      };
      message.activeForeignSegment = selection;
    }
  }
  if (record.defaultPublicSegment !== undefined) {
    message.defaultPublicSegment =
      record.defaultPublicSegment === null
        ? null
        : segmentId(record.defaultPublicSegment, 'defaultPublicSegment');
  }
  if (record.publicSegments !== undefined) {
    const publicSegments = requireString(record.publicSegments, 'publicSegments');
    for (const id of publicSegments.split(',')) {
      segmentId(Number(id), 'publicSegments');
    }
    message.publicSegments = publicSegments;
  }
  if (record.interShardLocal !== undefined) {
    const data = requireString(record.interShardLocal, 'interShardLocal');
    if (data.length > INTER_SHARD_LIMIT) {
      throw new InvalidMessage('interShardLocal exceeds 100 KB');
    }
    message.interShardLocal = data;
  }
  if (record.interShardSegment !== undefined) {
    const data = requireString(record.interShardSegment, 'interShardSegment');
    if (data.length > INTER_SHARD_LIMIT) {
      throw new InvalidMessage('interShardSegment exceeds 100 KB');
    }
    message.interShardSegment = data;
  }
  if (record.shardLimits !== undefined) {
    const limits = requireRecord(record.shardLimits, 'shardLimits');
    const result: Record<string, number> = {};
    for (const [shard, value] of Object.entries(limits)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new InvalidMessage('shardLimits value is invalid');
      }
      result[shard] = value;
    }
    message.shardLimits = result;
  }
  return message;
}

/**
 * Validates the result structure copied out of a sandbox. Returns the error description instead of
 * the message when the output is malformed.
 */
export function parseSandboxResult(value: unknown): SandboxResultMessage | { invalid: string } {
  try {
    const record = requireRecord(value, 'result');
    if (record.type === 'fatal') {
      return { type: 'fatal', error: requireString(record.error, 'error') };
    }
    if (record.type !== 'done' && record.type !== 'error') {
      throw new InvalidMessage('result type is invalid');
    }
    return runMessage(record, record.type);
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : 'unparseable result' };
  }
}
