/**
 * `singularity processors` — deploy and manage Processors.
 *
 * A Processor is a loop you write; we host it and run it on demand, and buyers pay you directly per
 * call. Everything the dashboard does is a wallet-signed HTTP call, so this is the same API, not a
 * reduced one — and an agent can drive it identically.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { api, loadKeypair, die, ok, prompt, type Flags, type Keypair } from './auth.js';
import { bundleProcessor } from './bundle.js';
import { usd, when, coerce } from './format.js';

/**
 * Where the API lives.
 *
 * Overridable for local development, but NOT silently: `--base` and the env var both print a notice,
 * because a publisher who forgot an exported variable and deployed to a local worker would see
 * "deployed" and find nothing live.
 */
const DEFAULT_BASE = 'https://sgl-processors.ivaavimusicproductions.workers.dev';

function resolveBase(flags: Flags): string {
    const override = (typeof flags.base === 'string' && flags.base)
        || process.env.SINGULARITY_PROCESSORS_URL;
    if (override) {
        process.stderr.write(`(using ${override})\n`);
        return String(override).replace(/\/+$/, '');
    }
    return DEFAULT_BASE;
}

/**
 * Caches the slug and invoke token beside the manifest so `run` needs no pasting.
 * Holds a bearer token, so `init` git-ignores it — committing one by accident is the likeliest way
 * to leak it.
 */
const STATE_FILE = '.singularity.json';

/**
 * Defaults that are the DEVELOPER's, not the project's: which keypair to sign with, which base URL.
 * Kept in the home directory rather than the project, because the project file is the one that gets
 * committed, and a keypair path is per-machine anyway.
 */
const CONFIG_FILE = join(homedir(), '.config', 'singularity', 'config.json');

export const HELP = `singularity processors — deploy loops we host and run

  init [slug]              scaffold processor.json + processor.js here
  configure                interactive setup: keypair, defaults
  deploy                   create it (prints the invoke token ONCE)
  update                   push new code or manifest
  run '{"n":10}'           invoke and print the output
  run --get '{"n":10}'     invoke over GET (for methods: ["GET"] processors)
  call -i                  invoke interactively, prompted per input field
  schema [slug]            the input/output schema buyers and agents see
  list                     your processors
  search [query]           the public catalogue
  logs [slug]              recent runs and failure rate
  logs --follow            stream new runs as they happen
  revenue                  sales and compute spend across everything you own
  earnings [slug]          the same, for one processor
  env list | unset KEY     which secrets are set; clear one
  secrets KEY=value ...    set secret values (KEY= also clears)
  pause | resume           stop or restart traffic, keeping the slug
  publish | unpublish      list or unlist publicly (instant, no review)
  rotate                   new invoke token, the old one stops working
  delete --yes             soft delete (the slug is never reusable)

  --keypair <path>         defaults to ~/.config/solana/id.json
  --slug <slug>            when not run from a processor directory
  --json                   machine-readable output, for scripts and agents
  --bundle                 bundle with esbuild: imports and npm packages
  --entry <file>           bundle entry (default: the manifest's $code)`;

interface Manifest {
    $code?: string;
    $entry?: string;
    $bundle?: boolean;
    slug?: string;
    name?: string;
    description?: string;
    lane?: string;
    price_usd?: string;
    input_schema?: JsonSchema;
    output_schema?: JsonSchema;
    methods?: string[];
    secrets?: Array<{ name: string; host?: string }>;
    [k: string]: unknown;
}

interface JsonSchema {
    type?: string;
    properties?: Record<string, JsonSchema & { description?: string; default?: unknown }>;
    required?: string[];
    items?: JsonSchema;
    [k: string]: unknown;
}

const STARTER_MANIFEST = (slug: string): Manifest => ({
    $code: 'processor.js',
    manifest_version: 1,
    slug,
    name: 'My Processor',
    description: 'What this loop does, in one sentence buyers and agents will read.',
    lane: 'managed',
    price_usd: '0.01',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    limits: { timeout_ms: 120000, cpu_ms: 10000, subrequests: 200 },
    // Exact hostnames your loop may call. Wildcards are rejected. An inference provider's host
    // is added for you.
    egress: { allow: [] },
    secrets: [],
});

const STARTER_CODE = `export default {
  async fetch(request) {
    const { input } = await request.json();

    // Your loop goes here. Call APIs and models with fetch() — credentials for the hosts
    // you declared are injected for you, so no keys belong in this file.

    return Response.json({ ok: true, received: input });
  }
}
`;

// ─── Local state and config ────────────────────────────────────────────────

interface State { slug?: string; invoke_token?: string }

const readState = (): State =>
    (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State : {});

/**
 * Write the local state — which HOLDS THE INVOKE TOKEN, so both lines below are protection, not
 * housekeeping.
 *
 * `mode: 0o600` because the default umask leaves it world-readable on most systems, and a token is
 * spendable: it invokes the processor and bills the publisher's runtime credits until they rotate it.
 *
 * The gitignore entry is added HERE rather than only in `init`, which is where it used to live. That
 * was wrong for the common case: someone who clones an example, or runs `deploy` in a project they
 * already had, never called `init` — so the file was created with no ignore rule and the token was
 * one `git add .` from a public commit. Every path that writes a token now ensures the rule.
 *
 * NOTE `mode` only applies when the file is CREATED. An existing file keeps its permissions, so this
 * chmods explicitly — otherwise a file created before this change stays world-readable forever.
 */
const writeState = (patch: State): void => {
    const merged = { ...readState(), ...patch };
    writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(STATE_FILE, 0o600); } catch { /* not all filesystems support it */ }
    if (merged.invoke_token) ensureGitignored();
};

/** Make sure the token file cannot be committed. Silent on failure — this is not a git repo. */
function ensureGitignored(): void {
    try {
        const gi = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';
        if (gi.split(/\r?\n/).some((line) => line.trim() === STATE_FILE)) return;
        appendFileSync('.gitignore', (gi && !gi.endsWith('\n') ? '\n' : '') + `${STATE_FILE}\n`);
    } catch { /* not a git repo; nothing to protect */ }
}

interface Config { keypair?: string; base?: string }

const readConfig = (): Config => {
    try {
        return existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config : {};
    } catch { return {}; }
};

function loadManifest(flags: Flags): Manifest {
    const p = resolve(String(flags.manifest || 'processor.json'));
    if (!existsSync(p)) die(`no manifest at ${p} — run \`singularity processors init\` first`);
    try { return JSON.parse(readFileSync(p, 'utf8')) as Manifest; } catch { return die(`${p} is not valid JSON`); }
}

/** Strip our `$`-prefixed local hints so the server sees a clean manifest. */
const clean = (m: Manifest): Record<string, unknown> =>
    Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('$')));

function resolveSlug(flags: Flags): string | undefined {
    if (typeof flags.slug === 'string' && flags.slug) return flags.slug;
    const fromState = readState().slug;
    if (fromState) return fromState;
    if (existsSync('processor.json')) return loadManifest(flags).slug;
    return undefined;
}

const requireSlug = (flags: Flags): string =>
    resolveSlug(flags) || die('no slug — deploy first, pass --slug, or run from a processor directory');

/** `--json` makes every command machine-readable, which is what an agent driving this needs. */
const emit = (flags: Flags, value: unknown): boolean => {
    if (!flags.json) return false;
    console.log(JSON.stringify(value, null, 2));
    return true;
};

// ─── Source resolution: single file, bundle, or multi-file ─────────────────

interface Source {
    code?: string;
    // `null` is meaningfully different from absent: absent leaves whatever is on the row, null is an
    // explicit clear. JSON.stringify drops undefined keys, so this distinction survives the wire
    // only because null is spelled out.
    bundle?: string | null;
    files?: Record<string, string>;
    bundle_meta?: Record<string, unknown>;
}

/**
 * What to send as the processor's code.
 *
 * THE DEFAULT IS DELIBERATELY THE OLD BEHAVIOUR: one file, sent verbatim as `code`. Bundling is
 * opt-in via `--bundle` or `$bundle: true`, so an existing project keeps deploying byte-identical
 * source and nobody's working processor changes shape because they upgraded the CLI.
 *
 * With `--bundle`, esbuild runs HERE, on the publisher's machine. That is what makes `import` and npm
 * packages work at all: the server never runs `npm install`, because arbitrary postinstall scripts on
 * infrastructure holding platform credentials is not something scanning can make safe. The bundle
 * crosses the boundary; node_modules never does.
 */
async function resolveSource(manifest: Manifest, flags: Flags): Promise<Source> {
    const entryPath = resolve(String(flags.entry || manifest.$entry || manifest.$code || 'processor.js'));
    if (!existsSync(entryPath)) die(`no code at ${entryPath}`);

    const wantsBundle = (flags.bundle === true || manifest.$bundle === true)
        && flags['no-bundle'] !== true;

    if (wantsBundle) {
        process.stderr.write('bundling... ');
        const built = await bundleProcessor({
            entry: entryPath, cwd: process.cwd(), minify: flags.minify === true,
        });
        process.stderr.write(`${(built.meta.bytes / 1024).toFixed(1)} KiB\n`);
        for (const w of built.warnings) process.stderr.write(`  warning: ${w}\n`);

        // `code` IS NOT SENT ALONGSIDE A BUNDLE, and the server refuses the combination outright.
        // The reason is worth stating: load-time precedence is bundle > files > code, so code sent
        // with a bundle is stored and then ignored, and the publisher spends the afternoon editing
        // source that is not running while every reply says the update succeeded.
        return { bundle: built.bundle, files: built.files, bundle_meta: built.meta };
    }

    const code = readFileSync(entryPath, 'utf8');
    // A specific failure here instead of a deploy that "succeeds" and then dies at runtime with a
    // module-resolution error the publisher cannot see — they only get "processor failed", after a
    // buyer has already paid. Comments and strings can contain the word `import`, so this fires only
    // on a line that begins with one.
    if (/^\s*import\s+[^(]/m.test(code) || /^\s*export\s+\*\s+from/m.test(code)) {
        die(`${entryPath} has imports, which need bundling.\n`
            + '  add --bundle (or "$bundle": true in processor.json) and deploy again.');
    }

    // GOING BACK from a bundle to a single file has to be EXPLICIT, because the server will
    // otherwise refuse the update — correctly. A bundle already on the row keeps winning at load
    // time, so plain `code` would never take effect; `--no-bundle` is what says "clear it".
    //
    // `files: {}` is sent with it, since a processor can also be running from files with no bundle
    // at all, and clearing only the bundle would leave those files still winning over code.
    if (flags['no-bundle'] === true) return { code, bundle: null, files: {} };

    return { code };
}

// ─── Interactive input, from the processor's own schema ────────────────────

/**
 * Prompt for each input field a processor declares.
 *
 * The point is that a buyer or a publisher testing an unfamiliar processor should not have to
 * hand-write JSON that matches a schema they have not read. The schema is already published for
 * agents; this uses it for humans.
 *
 * TYPES ARE COERCED FROM THE SCHEMA, not guessed from the text. Typing `10` where the schema says
 * `number` gives 10; where it says `string` it gives "10". Guessing from the input would silently
 * send the wrong type for a numeric id or a zip code with a leading zero.
 */
async function promptForSchema(schema: JsonSchema | undefined): Promise<Record<string, unknown>> {
    const props = schema?.properties;
    if (!props || Object.keys(props).length === 0) {
        const raw = await prompt('input (JSON)', '{}');
        try { return JSON.parse(raw) as Record<string, unknown>; } catch { return die('input must be valid JSON'); }
    }

    const required = new Set(schema?.required ?? []);
    const out: Record<string, unknown> = {};
    ok('');
    for (const [name, spec] of Object.entries(props)) {
        const label = [
            name,
            spec.type ? `(${spec.type})` : '',
            required.has(name) ? '*' : '',
            spec.description ? `— ${spec.description}` : '',
        ].filter(Boolean).join(' ');
        const dflt = spec.default === undefined ? '' : String(spec.default);
        const raw = await prompt(`  ${label}`, dflt);

        if (raw === '') {
            if (required.has(name)) { ok('  (required)'); return promptForSchema(schema); }
            continue;
        }
        out[name] = coerce(raw, spec.type);
    }
    ok('');
    return out;
}

// ─── Invoke, with polling ─────────────────────────────────────────────────

interface RunResult {
    status: string;
    run_id?: string;
    run_token?: string;
    output?: unknown;
    error?: string;
}

/**
 * Flatten an input object into query parameters for a GET run.
 *
 * REFUSES what a query string cannot carry, rather than mangling it. The server reads a GET's input
 * from the query and does NO type coercion — every value arrives as a string — so a nested object
 * would become `[object Object]` and a processor would be charged for failing on garbage. Saying
 * "this input needs POST" is the honest answer.
 *
 * Arrays are allowed and sent as repeated keys, which is what the server reassembles them from.
 */
function toQuery(input: unknown): Record<string, string | number | Array<string | number>> {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) {
        return die('--get needs a JSON object of scalar fields');
    }
    const out: Record<string, string | number | Array<string | number>> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            if (v.some((x) => x !== null && typeof x === 'object')) {
                return die(`--get cannot send nested objects (field "${k}") — drop --get to POST it`);
            }
            // Passed through AS AN ARRAY, which api() turns into repeated keys. Joining into "a,b"
            // would arrive as one string and, for an array-typed field, be delivered as ["a,b"].
            out[k] = v.map((x) => (typeof x === 'number' ? x : String(x)));
            continue;
        }
        if (typeof v === 'object') {
            return die(`--get cannot send nested objects (field "${k}") — drop --get to POST it`);
        }
        out[k] = typeof v === 'number' ? v : String(v);
    }
    return out;
}

/**
 * Invoke and wait.
 *
 * A run is asynchronous by design — the durable object owns it, so a dropped connection never loses
 * a paid run. `run` hides that behind a poll loop, which is what a terminal user wants.
 *
 * The poll uses the RUN TOKEN, not a wallet signature: the token is scoped to exactly this run, so a
 * dropped-and-resumed poll cannot read anything else, and polling never costs another signature.
 */
async function invokeAndWait(
    base: string, slug: string, input: Record<string, unknown> | unknown,
    kp: Keypair, token: string, quiet: boolean, asGet = false,
): Promise<RunResult> {
    // A GET run, for a processor that declares `methods: ["GET"]` — the shape agents and browsers
    // reach for first, and un-runnable from this CLI until now.
    //
    // `signQuery` is REQUIRED here and forbidden everywhere else: the run route hashes `url.search`
    // for a GET, because that is where a GET's input lives. Signing '' would leave the input
    // unauthenticated; signing the query on any OTHER GET route 401s, because those verify against ''.
    let res = asGet
        ? await api<RunResult>(base, 'GET', `/processors/${slug}/run`, {
            query: toQuery(input), kp, bearer: token, signQuery: true,
        })
        : await api<RunResult>(base, 'POST', `/processors/${slug}/run`, {
            body: { input }, kp, bearer: token,
        });

    if (res.status !== 'completed' && res.run_token && res.run_id) {
        if (!quiet) process.stderr.write('running');
        for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            if (!quiet) process.stderr.write('.');
            const p = await api<RunResult>(
                base, 'GET', `/processors/${slug}/runs/${res.run_id}`, { bearer: res.run_token },
            );
            if (p.status === 'completed' || p.status.startsWith('failed')) { res = p; break; }
        }
        if (!quiet) process.stderr.write('\n');
    }
    return res;
}

function reportRun(res: RunResult, flags: Flags): void {
    if (res.status === 'completed') {
        console.log(JSON.stringify(flags.json ? res : res.output, null, 2));
        return;
    }
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else console.error(`${res.status}: ${res.error || 'no output'}`);
    // Non-zero exit, so `singularity processors run ... && next-thing` behaves in a shell script.
    process.exit(1);
}

// ─── Commands ──────────────────────────────────────────────────────────────

export async function run(words: string[], flags: Flags): Promise<void> {
    const sub = words[0];
    const BASE = resolveBase(flags);
    // A keypair configured by `configure` is a default, never an override: an explicit --keypair or
    // an env var still wins, in that order.
    const cfg = readConfig();
    if (!flags.keypair && cfg.keypair) flags = { ...flags, keypair: cfg.keypair };

    switch (sub) {
        case 'init': {
            const slug = words[1] || 'my-processor';
            if (existsSync('processor.json')) die('processor.json already exists');
            writeFileSync('processor.json', JSON.stringify(STARTER_MANIFEST(slug), null, 2) + '\n');
            if (!existsSync('processor.js')) writeFileSync('processor.js', STARTER_CODE);
            ensureGitignored();
            ok('created processor.json and processor.js');
            ok('edit them, then: singularity processors deploy');
            break;
        }

        case 'configure': {
            // Saves the machine-level defaults so the common case needs no flags. Deliberately does
            // NOT store anything secret: the keypair PATH, never its contents, and no invoke tokens.
            // A config file people back up or sync must not be a wallet.
            ok('singularity configure — machine defaults, no secrets stored');
            ok('');
            const kpPath = await prompt('keypair path', cfg.keypair || join(homedir(), '.config/solana/id.json'));
            if (!existsSync(resolve(kpPath.replace(/^~/, homedir())))) {
                ok(`  note: ${kpPath} does not exist yet — create one with: solana-keygen new`);
            }
            const base = await prompt('API base URL', cfg.base || DEFAULT_BASE);

            const next: Config = { keypair: kpPath };
            // Only persisted when it differs from the default. Writing the production URL into a
            // config file means a future change of endpoint silently does not reach anyone who ran
            // configure once, and they get connection errors with no clue why.
            if (base && base !== DEFAULT_BASE) next.base = base;

            mkdirSync(dirname(CONFIG_FILE), { recursive: true });
            writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
            ok('');
            ok(`saved ${CONFIG_FILE}`);
            try { ok(`wallet: ${loadKeypair({ keypair: kpPath }).address}`); } catch { /* reported above */ }
            break;
        }

        case 'deploy': {
            const kp = loadKeypair(flags);
            const manifest = loadManifest(flags);
            const source = await resolveSource(manifest, flags);
            const res = await api<{ slug: string; invoke_token: string }>(BASE, 'POST', '/processors', {
                body: { manifest: clean(manifest), ...source }, kp,
            });
            writeState({ slug: res.slug, invoke_token: res.invoke_token });
            if (emit(flags, res)) break;
            ok(`deployed  ${res.slug}`);
            ok();
            ok(`invoke token (shown once, saved to ${STATE_FILE}):`);
            ok(`  ${res.invoke_token}`);
            ok();
            ok(`try it:   singularity processors run '{"hello":"world"}'`);
            ok('go live:  singularity processors publish');
            break;
        }

        case 'update': {
            const kp = loadKeypair(flags);
            const manifest = loadManifest(flags);
            const slug = String(flags.slug || manifest.slug || die('no slug in processor.json'));
            const source = await resolveSource(manifest, flags);
            const res = await api<{ config_rev: number; note?: string }>(
                BASE, 'PATCH', `/processors/${slug}`, { body: { manifest: clean(manifest), ...source }, kp },
            );
            if (emit(flags, res)) break;
            ok(`updated  ${slug}  (config_rev ${res.config_rev})`);
            if (res.note) ok(res.note);
            break;
        }

        case 'run':
        case 'call': {
            const slug = requireSlug(flags);

            // Two ways in. An AUTHOR signs with their wallet plus the invoke token — owners run
            // their own processors, including unlisted and PAUSED ones (a non-owner gets 404 or
            // 503). A BUYER pays per call with x402 (X-Payment); there is no API-key lane, because
            // buyer payments go straight to the publisher's wallet and never through us.
            const token = String(flags.token || readState().invoke_token || '');
            if (!token) die(`no invoke token in ${STATE_FILE} — run \`singularity processors rotate\``);

            const kp = loadKeypair(flags);
            let input: unknown = {};
            // `call` is the interactive spelling of `run`, so it prompts by default — but an
            // argument still wins, so `call '{"n":1}'` is not suddenly a different command.
            const interactive = flags.interactive === true || sub === 'call';
            if (words[1]) {
                try { input = JSON.parse(words[1]); } catch { die('input must be valid JSON'); }
            } else if (interactive) {
                // The schema is fetched first so the prompts match what this processor actually
                // accepts. Signed, so the publisher's own unlisted processors work too.
                const d = await api<{ manifest?: Manifest; input_schema?: JsonSchema }>(
                    BASE, 'GET', `/processors/${slug}`, { kp },
                );
                input = await promptForSchema(d.manifest?.input_schema ?? d.input_schema);
                ok(`input: ${JSON.stringify(input)}`);
            }
            // `--get` invokes over GET, for a processor that declares methods: ["GET"] — which was
            // otherwise un-runnable from this CLI at all, since every invoke went out as a POST.
            const res = await invokeAndWait(
                BASE, slug, input, kp, token, flags.json === true, flags.get === true,
            );
            reportRun(res, flags);
            break;
        }

        case 'schema': {
            const slug = words[1] || requireSlug(flags);
            // Signed when a keypair is available, so an owner can read their own unlisted
            // processor's schema; unsigned still works for anything listed.
            let kp: Keypair | undefined;
            try { kp = loadKeypair(flags); } catch { kp = undefined; }
            const d = await api<{
                manifest?: Manifest; input_schema?: JsonSchema; output_schema?: JsonSchema;
                name?: string; description?: string; price_usd?: string; price_micro?: number;
            }>(BASE, 'GET', `/processors/${slug}`, kp ? { kp } : {});

            const input = d.manifest?.input_schema ?? d.input_schema;
            const output = d.manifest?.output_schema ?? d.output_schema;
            if (emit(flags, { slug, input_schema: input, output_schema: output })) break;

            ok(`${d.manifest?.name ?? d.name ?? slug}`);
            if (d.manifest?.description ?? d.description) ok(`${d.manifest?.description ?? d.description}`);
            const priceMicro = d.price_micro;
            if (priceMicro != null) ok(`price  $${usd(priceMicro)} per call`);
            ok('');
            ok('input:');
            ok(JSON.stringify(input ?? {}, null, 2));
            ok('');
            ok('output:');
            ok(JSON.stringify(output ?? {}, null, 2));
            break;
        }

        case 'secrets': {
            const kp = loadKeypair(flags);
            const slug = requireSlug(flags);
            const pairs = words.slice(1);
            if (!pairs.length) die('usage: singularity processors secrets KEY=value [KEY2=value2]   (KEY= clears)');

            const values: Record<string, string | null> = {};
            for (const pair of pairs) {
                const eq = pair.indexOf('=');
                if (eq < 1) die(`bad argument "${pair}" — expected KEY=value`);
                const v = pair.slice(eq + 1);
                values[pair.slice(0, eq)] = v === '' ? null : v;
            }
            const res = await api<{ secrets: string[] }>(
                BASE, 'PUT', `/processors/${slug}/secrets`, { body: { values }, kp },
            );
            if (emit(flags, res)) break;
            ok(`secrets set: ${res.secrets.join(', ') || '(none)'}`);
            ok('values are write-only — never returned, injected on egress');
            break;
        }

        case 'env': {
            const kp = loadKeypair(flags);
            const slug = requireSlug(flags);
            const action = words[1] || 'list';

            if (action === 'list') {
                // Which names are DECLARED (from the manifest) and which of those actually have a
                // value. Before this, `secrets set` was the only surface that ever reported the
                // second fact, so anyone who did not save that output had no way to answer "is
                // OPENAI_API_KEY set?" except to set it again and hope.
                const d = await api<{ manifest?: Manifest; secret_keys?: string[] }>(
                    BASE, 'GET', `/processors/${slug}`, { kp },
                );
                const declared = d.manifest?.secrets ?? [];
                const set = new Set(d.secret_keys ?? []);
                if (emit(flags, { declared: declared.map((s) => s.name), set: [...set] })) break;
                if (!declared.length) {
                    ok('no secrets declared — add them to manifest.secrets, then set values');
                    break;
                }
                for (const s of declared) {
                    ok(`${set.has(s.name) ? 'set    ' : 'unset  '} ${s.name.padEnd(28)} ${s.host ? `-> ${s.host}` : ''}`);
                }
                ok('');
                ok('values are never readable, by you or by your code — they are injected on egress');
                break;
            }

            if (action === 'unset') {
                const key = words[2];
                if (!key) die('usage: singularity processors env unset KEY');
                const res = await api<{ secrets: string[] }>(
                    BASE, 'PUT', `/processors/${slug}/secrets`, { body: { values: { [key]: null } }, kp },
                );
                if (emit(flags, res)) break;
                ok(`cleared ${key}`);
                ok(`still set: ${res.secrets.join(', ') || '(none)'}`);
                break;
            }

            die('usage: singularity processors env [list | unset KEY]');
            break;
        }

        case 'list': {
            const kp = loadKeypair(flags);
            const res = await api<{ processors: ProcessorRow[] }>(BASE, 'GET', '/processors', { kp });
            if (emit(flags, res)) break;
            if (!res.processors.length) { ok('no processors yet — singularity processors init'); break; }
            for (const p of res.processors) {
                // Three different states, never collapsed into one word: paused means "answering
                // nobody but me", unlisted means "not in the catalogue but still answering", and
                // suspended is ours, not theirs.
                const state = p.status === 'suspended' ? 'SUSPENDED'
                    : p.paused_at ? 'paused'
                    : p.publicly_invocable ? 'public'
                    : 'private';
                ok(`${state.padEnd(10)} ${p.slug.padEnd(28)} ${String(p.run_count).padStart(6)} runs  `
                    + `$${usd(p.sales_micro)} sales  $${usd(p.runtime_spent_micro)} compute`);
            }
            break;
        }

        case 'search': {
            // The PUBLIC catalogue, and the one command here that needs no wallet at all. Someone
            // evaluating the platform should be able to see what is on it before creating a keypair.
            const q = (words.slice(1).join(' ') || '').toLowerCase();
            const res = await api<{ processors: PublicRow[]; listing_enabled: boolean }>(
                BASE, 'GET', '/processors', { query: { limit: 100 } },
            );
            if (!res.listing_enabled) { ok('the public catalogue is not open yet'); break; }

            // Filtered client-side ON PURPOSE: the catalogue endpoint has no search parameter, and
            // inventing one here that the server ignores would silently return everything while
            // looking like it searched. 100 rows is the whole catalogue at this stage.
            const hit = (p: PublicRow) => !q
                || [p.slug, p.name, p.description, p.listing_category, ...(p.listing_tags ?? [])]
                    .filter(Boolean).some((f) => String(f).toLowerCase().includes(q));
            const found = res.processors.filter(hit);
            if (emit(flags, { query: q, processors: found })) break;

            if (!found.length) { ok(q ? `nothing matching "${q}"` : 'the catalogue is empty'); break; }
            for (const p of found) {
                ok(`${p.slug.padEnd(28)} $${usd(p.price_micro)}  ${String(p.run_count ?? 0).padStart(6)} runs  `
                    + `${p.failure_rate_30d != null ? (Number(p.failure_rate_30d) * 100).toFixed(1) + '% fail' : ''}`);
                if (p.description) ok(`  ${String(p.description).slice(0, 96)}`);
            }
            ok('');
            ok(`${found.length} of ${res.processors.length}   run one with: singularity processors schema <slug>`);
            break;
        }

        case 'logs': {
            const kp = loadKeypair(flags);
            const slug = words[1] || requireSlug(flags);
            const limit = Number(flags.limit || 30);

            if (flags.follow === true) {
                await followLogs(BASE, slug, kp, limit);
                break;
            }

            const res = await api<RunsPage>(
                BASE, 'GET', `/processors/${slug}/runs`,
                { kp, query: { limit, ...(typeof flags.logs === 'string' ? { logs: flags.logs } : {}) } },
            );
            if (emit(flags, res)) break;
            printRunsPage(res);
            // Console output for ONE run, because that is how it is stored and read: per-run, behind
            // an ownership check, scoped to the attempt that actually finalised the run.
            if (res.logs) {
                ok('');
                for (const l of res.logs) {
                    ok(`  ${String(l.time_offset_ms).padStart(6)}ms  ${l.level.padEnd(5)} ${l.message}`
                        + (l.truncated ? ' …(truncated)' : ''));
                }
            }
            break;
        }

        case 'revenue': {
            // ACCOUNT-WIDE, from ONE signature. Every owner read costs a wallet signature, so the
            // obvious implementation — call /earnings once per processor — would prompt N times to
            // print one table. The list route already carries both money views folded in, so this is
            // a client-side roll-up of a single request.
            const kp = loadKeypair(flags);
            const res = await api<{ processors: ProcessorRow[]; owner: string }>(BASE, 'GET', '/processors', { kp });

            let sales = 0n, salesCount = 0n, spent = 0n, held = 0n;
            for (const p of res.processors) {
                sales += BigInt(p.sales_micro ?? 0);
                salesCount += BigInt(p.sales_count ?? 0);
                spent += BigInt(p.runtime_spent_micro ?? 0);
                held += BigInt(p.runtime_held_open_micro ?? 0);
            }
            if (emit(flags, {
                owner: res.owner,
                sales_micro: String(sales), sales_count: String(salesCount),
                runtime_spent_micro: String(spent), runtime_held_open_micro: String(held),
                processors: res.processors.length,
            })) break;

            // TWO STORIES, NEVER NETTED. Sales went straight to the publisher's wallet and are a
            // record of transfers we do not hold; compute is what they spent from credits. Printing
            // one "profit" number would imply we are custodying one side of it, which we never are.
            ok(`wallet   ${res.owner}`);
            ok('');
            ok(`Sales    $${usd(sales)}   ${salesCount} paid runs, sent directly to your wallet`);
            ok(`Compute  $${usd(spent)}   spent from your credit balance`);
            if (held > 0n) ok(`Held     $${usd(held)}   reserved against runs still in flight`);
            ok('');
            for (const p of [...res.processors].sort((a, b) => Number(b.sales_micro ?? 0) - Number(a.sales_micro ?? 0))) {
                if (!p.sales_micro && !p.runtime_spent_micro) continue;
                ok(`  ${p.slug.padEnd(28)} +$${usd(p.sales_micro)}  -$${usd(p.runtime_spent_micro)}`);
            }
            break;
        }

        case 'earnings': {
            const kp = loadKeypair(flags);
            const slug = words[1] || requireSlug(flags);
            const res = await api<EarningsRes>(BASE, 'GET', `/processors/${slug}/earnings`, { kp });
            if (emit(flags, res)) break;

            ok(`Sales      $${usd(res.sales.total_micro)}  (${res.sales.count} paid runs, sent to ${res.sales.paid_to})`);
            ok(`Compute    $${usd(res.runtime.spent_micro)}  spent from your credit balance`);
            if (res.runtime.held_open_micro > 0) {
                ok(`Held       $${usd(res.runtime.held_open_micro)}  reserved for runs still in flight`);
            }
            if (res.sales.recent?.length) {
                ok();
                for (const e of res.sales.recent.slice(0, 20)) {
                    ok(`${when(e.created_at)}  +$${usd(e.price_micro)}  ${e.settle_tx ? e.settle_tx.slice(0, 16) + '...' : ''}`);
                }
            }
            break;
        }

        case 'pause':
        case 'resume': {
            const kp = loadKeypair(flags);
            const slug = requireSlug(flags);
            const paused = sub === 'pause';
            const res = await api<{ paused: boolean; paused_at: string | null; note?: string }>(
                BASE, 'PUT', `/processors/${slug}/pause`, { body: { paused }, kp },
            );
            if (emit(flags, res)) break;
            ok(`${slug}: ${res.paused ? 'paused' : 'running'}`);
            if (res.note) ok(res.note);
            break;
        }

        case 'publish':
        case 'unpublish': {
            const kp = loadKeypair(flags);
            const slug = requireSlug(flags);
            const listed = sub === 'publish';
            const res = await api<{ note?: string }>(
                BASE, 'PUT', `/processors/${slug}/listing`, { body: { listed }, kp },
            );
            if (emit(flags, res)) break;
            ok(res.note || (listed ? 'published' : 'unpublished'));
            break;
        }

        case 'rotate': {
            const kp = loadKeypair(flags);
            const slug = requireSlug(flags);
            const res = await api<{ invoke_token: string }>(
                BASE, 'POST', `/processors/${slug}/rotate-token`, { kp },
            );
            writeState({ slug, invoke_token: res.invoke_token });
            if (emit(flags, res)) break;
            ok(`new invoke token (saved to ${STATE_FILE}):`);
            ok(`  ${res.invoke_token}`);
            ok('the previous token no longer works');
            break;
        }

        case 'delete': {
            const kp = loadKeypair(flags);
            const slug = requireSlug(flags);
            if (!flags.yes) {
                die(`this cannot be undone and the slug "${slug}" can NEVER be reused.\n`
                    + '  to stop traffic without losing the slug:  singularity processors pause\n'
                    + '  to really delete it, re-run with --yes');
            }
            await api(BASE, 'DELETE', `/processors/${slug}`, { kp });
            ok(`deleted ${slug} (the slug stays reserved)`);
            break;
        }

        default:
            ok(HELP);
            process.exit(sub ? 1 : 0);
    }
}

// ─── Types for the API responses this file reads ───────────────────────────

interface ProcessorRow {
    slug: string;
    status: string;
    run_count: number;
    paused_at: string | null;
    publicly_invocable: boolean;
    sales_micro: number;
    sales_count: number;
    runtime_spent_micro: number;
    runtime_held_open_micro: number;
}

interface PublicRow {
    slug: string;
    name?: string;
    description?: string;
    price_micro: number;
    run_count?: number;
    failure_rate_30d?: number | null;
    listing_category?: string | null;
    listing_tags?: string[] | null;
}

interface RunRow {
    id?: string;
    created_at: string;
    status: string;
    run_ms: number | null;
    error: string | null;
}

interface RunsPage {
    runs: RunRow[];
    stats: { total: number; failure_rate: number | null; platform_failures: number };
    logs?: Array<{ level: string; message: string; time_offset_ms: number; truncated: boolean }>;
}

interface EarningsRes {
    sales: {
        total_micro: number; count: number; paid_to: string;
        recent?: Array<{ created_at: string; price_micro: number; settle_tx: string | null }>;
    };
    runtime: { spent_micro: number; held_open_micro: number };
}

function printRunsPage(res: RunsPage): void {
    const s = res.stats;
    ok(`${s.total} runs   failure rate ${s.failure_rate == null ? 'n/a' : (s.failure_rate * 100).toFixed(1) + '%'}`
        + `   platform faults ${s.platform_failures}`);
    ok();
    for (const r of res.runs) {
        ok(`${when(r.created_at)}  ${r.status.padEnd(16)} ${String(r.run_ms ?? '').padStart(6)}ms  `
            + `${r.error ? r.error.slice(0, 60) : ''}`);
    }
}

/**
 * `logs --follow` — print new runs as they appear.
 *
 * POLLED, not streamed, and that is a deliberate limit rather than an oversight: an owner read costs
 * a wallet signature, and there is no server-side stream for a processor's run list. Five seconds is
 * slow enough to be cheap and fast enough to feel live while watching a deploy.
 *
 * DE-DUPED BY RUN ID, not by timestamp. Runs finish out of order, so a "newer than the last
 * created_at" filter drops a run that started earlier and finished later — exactly the slow run
 * someone tailing logs is watching for.
 */
async function followLogs(base: string, slug: string, kp: Keypair, limit: number): Promise<void> {
    const seen = new Set<string>();
    let first = true;
    ok(`following ${slug} — ctrl-c to stop`);
    for (;;) {
        const res = await api<RunsPage>(base, 'GET', `/processors/${slug}/runs`, { kp, query: { limit } });

        // Oldest first, so the terminal reads top-to-bottom like a log file.
        for (const r of [...res.runs].reverse()) {
            // Keyed by run id where there is one. The timestamp fallback is not a substitute — two
            // runs can share a second — but a page without ids is not a shape the API produces, and
            // duplicating a line beats dropping one.
            const key = r.id ?? `${r.created_at}:${r.status}:${r.run_ms}`;
            if (seen.has(key)) continue;
            seen.add(key);
            ok(`${when(r.created_at)}  ${r.status.padEnd(16)} ${String(r.run_ms ?? '').padStart(6)}ms  `
                + `${r.error ? r.error.slice(0, 60) : ''}`);
        }

        // The first page is HISTORY, not news. Unmarked, it reads as a burst of fresh activity the
        // moment you started watching, which is exactly the wrong impression while verifying a fix.
        if (first) { ok('─'.repeat(58) + ' live'); first = false; }

        // The set is bounded, because this loop is meant to be left running. Every id is 36 bytes and
        // an unbounded set on a busy processor grows for as long as the terminal is open. Runs are
        // only ever re-seen within a page, so keeping several pages' worth is ample.
        if (seen.size > 5000) {
            for (const k of [...seen].slice(0, seen.size - 1000)) seen.delete(k);
        }

        await new Promise((r) => setTimeout(r, 5000));
    }
}
