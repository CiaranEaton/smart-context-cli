import { dep } from './dep.js';
import './polyfill.js';

const PREFIX = 'x';

function helper(value: string): string {
  return PREFIX + value + dep;
}

export function used(input: string): string {
  return helper(input);
}

export interface Options { verbose: boolean }

export const a = 1, b = a + 1;

const { p, q: renamed } = { p: 1, q: 2 };

class Internal {}

export { Internal as Public, helper };

export default function (): number { return renamed; }

console.log('boot');
