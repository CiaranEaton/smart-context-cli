import { dep, unusedDep } from './dep.js';
import type { Config } from './types.js';

const PREFIX = 'x';

function helper(value: string): string {
  return PREFIX + value + dep;
}

function neverUsed(): number {
  return unusedDep;
}

/** Does something useful. */
export function used(input: string, config?: Config): string {
  return helper(input);
}

export interface Options { verbose: boolean }

export const a = 1, b = a + 1;

class Internal {}

export { Internal as Public, helper };

export default function (): number { return a; }

console.log('lib loaded');
