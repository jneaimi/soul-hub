// Soul Hub CLI entry — ADR-001 (soul-hub-cli), Phase 1.
// Dispatch shape: soul <noun> <verb> [args]. Dumb pipe to /api/*.

import { parseArgs } from 'node:util';
import { fail, type OutputOpts } from './output.ts';
import * as vault from './verbs/vault.ts';
import * as project from './verbs/project.ts';
import * as adr from './verbs/adr.ts';
import * as crm from './verbs/crm.ts';
import * as scheduler from './verbs/scheduler.ts';
import * as intent from './verbs/intent.ts';
import { doctor } from './verbs/doctor.ts';

const HELP = `soul — Soul Hub CLI (ADR-001, Phase 1 read verbs)

USAGE
  soul vault search [-q QUERY] [--zone Z] [--project P] [--type T] [--limit N]
  soul vault get   PATH
  soul vault recent [--limit N]
  soul project list
  soul project get   SLUG
  soul adr list   --project SLUG [--status STATUS]
  soul crm find   [-q QUERY] [--stage S] [--limit N]
  soul crm followups
  soul scheduler tasks
  soul intent metrics
  soul doctor
  soul --help | -h | --version

GLOBAL FLAGS
  --json     Emit raw API JSON (composable with jq).
  --base URL Override Soul Hub URL (default http://localhost:2400 or $SOUL_HUB_URL).

EXAMPLES
  soul vault search -q "adr-046" --type decision
  soul project get soul-hub-cli
  soul adr list --project soul-hub-cli --status accepted
  soul vault search --project soul-hub --json | jq -r '.results[].path'

Backed by the Soul Hub HTTP API. Governance + chokepoints (ADR-046/047/048/050)
fire at the API layer; this CLI is a dumb pipe. Errors surface verbatim.
`;

interface Dispatch { [noun: string]: { [verb: string]: (args: Record<string, string | undefined>, opts: OutputOpts) => Promise<void> }; }

const dispatch: Dispatch = {
  vault:     { search: vault.search, get: vault.get, recent: vault.recent },
  project:   { list: project.list, get: project.get },
  adr:       { list: adr.list },
  crm:       { find: crm.find, followups: crm.followups },
  scheduler: { tasks: scheduler.tasks },
  intent:    { metrics: intent.metrics },
};

function splitGlobals(argv: string[]): { rest: string[]; opts: OutputOpts; base?: string } {
  const rest: string[] = [];
  const opts: OutputOpts = { json: false };
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--base') { base = argv[++i]; continue; }
    if (a.startsWith('--base=')) { base = a.slice('--base='.length); continue; }
    rest.push(a);
  }
  return { rest, opts, base };
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === '-h' || raw[0] === '--help' || raw[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (raw[0] === '--version' || raw[0] === '-V') {
    process.stdout.write('soul 0.1.0\n');
    return;
  }

  const { rest, opts, base } = splitGlobals(raw);
  if (base) process.env.SOUL_HUB_URL = base;

  // doctor is a top-level verb (no noun).
  if (rest[0] === 'doctor') {
    await doctor({}, opts);
    return;
  }

  const [noun, verb, ...tail] = rest;
  if (!noun || !dispatch[noun]) fail(`unknown noun "${noun ?? ''}". Run \`soul --help\`.`);
  if (!verb || !dispatch[noun][verb]) fail(`unknown verb "${noun} ${verb ?? ''}". Run \`soul --help\`.`);

  // Parse remaining flags. Unknown short forms (-q etc.) become explicit.
  const parsed = parseArgs({
    args: tail,
    options: {
      q:        { type: 'string', short: 'q' },
      zone:     { type: 'string' },
      project:  { type: 'string' },
      type:     { type: 'string' },
      limit:    { type: 'string' },
      status:   { type: 'string' },
      stage:    { type: 'string' },
      slug:     { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const args: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(parsed.values)) args[k] = v as string | undefined;
  if (parsed.positionals.length > 0) args._ = parsed.positionals.join('/');

  try {
    await dispatch[noun][verb](args, opts);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 1);
  }
}

main();
