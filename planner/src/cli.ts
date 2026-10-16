/**
 * tsx src/cli.ts plan <input.json>             print the plan as JSON; exit 0 dispatchable, 2 not, 1 invalid input
 * tsx src/cli.ts render <template-id> <fields.json>   print one rendered template, for a person to read
 *
 * Neither command touches the network or writes a file.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { plan } from './plan.js';
import { loadTemplate, renderTemplate, type Fields } from './templates.js';

const USAGE = 'usage: tsx src/cli.ts plan <input.json>\n       tsx src/cli.ts render <template-id> <fields.json>';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export function main(argv: string[], io: CliIo = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }): number {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'plan' && args.length === 1) {
      const p = plan(readJson(args[0]!) as Parameters<typeof plan>[0]);
      io.out(`${JSON.stringify(p, null, 2)}\n`);
      if (!p.dispatchable) io.err(`not dispatchable:\n${p.reasons.map((r) => `  - ${r}`).join('\n')}\n`);
      return p.dispatchable ? 0 : 2;
    }
    if (cmd === 'render' && args.length === 2) {
      const fields = readJson(args[1]!);
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields) || Object.values(fields).some((v) => typeof v !== 'string')) {
        throw new Error('fields.json must be an object of string values');
      }
      const r = renderTemplate(loadTemplate(args[0]!), fields as Fields);
      io.out(`${r.summary === undefined ? '' : `Summary: ${r.summary}\n\n`}${r.body}\n`);
      return 0;
    }
    io.err(`${USAGE}\n`);
    return 1;
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
