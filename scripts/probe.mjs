#!/usr/bin/env node
/**
 * Command-line front end for lib/probe.js.
 *
 *   node scripts/probe.mjs --base https://gw.example.com --key-env MY_GATEWAY_KEY
 *   GATEWAY_KEY=sk-... node scripts/probe.mjs --base https://gw.example.com
 *
 * Prefer an environment variable over --key: a key typed on the command line stays
 * in shell history. Exit code 0 = usable gateway, 1 = not usable, 2 = bad arguments.
 */
import { probe } from '../lib/probe.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const baseURL = args.base ?? process.env.GATEWAY_BASE;
const apiKey = args.key ?? (args['key-env'] ? process.env[args['key-env']] : undefined) ?? process.env.GATEWAY_KEY;
if (!baseURL) {
  console.error('usage: node scripts/probe.mjs --base <url> [--key-env <ENV_NAME>]');
  process.exit(2);
}
if (args['key-env'] && !apiKey) console.error(`warning: environment variable ${args['key-env']} is empty; probing without a token`);

try {
  const report = await probe({ baseURL, apiKey });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.usable ? 0 : 1);
} catch (error) {
  console.error(`probe failed: ${error.message}`);
  process.exit(2);
}
