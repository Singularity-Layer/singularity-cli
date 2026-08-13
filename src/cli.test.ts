/**
 * Tests for the CLI's pure logic.
 *
 * Deliberately NOT tests of the subcommands: those are signed HTTP calls, and mocking them would
 * assert that the mock matches my belief about the API rather than that the API works. What IS tested
 * here is everything that can be wrong without any network involved — argument parsing, money
 * formatting, schema-driven coercion, and the bundler — because each of those has a plausible wrong
 * version that looks right in a terminal.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, bs58, prompt } from './auth.js';
import { usd, coerce } from './format.js';
import { bundleProcessor } from './bundle.js';
import { checkPayoutAddress } from './processors.js';

// ─── Argument parsing ──────────────────────────────────────────────────────

describe('parseArgs', () => {
    it('separates words from flags', () => {
        const { words, flags } = parseArgs(['processors', 'deploy', '--slug', 'my-proc']);
        expect(words).toEqual(['processors', 'deploy']);
        expect(flags).toEqual({ slug: 'my-proc' });
    });

    it('treats a trailing flag as boolean', () => {
        // The bug this pins: without the "nothing follows" case, a trailing --yes parsed as
        // undefined, so the delete confirmation could never be satisfied and the command was
        // impossible to run.
        expect(parseArgs(['delete', '--yes']).flags).toEqual({ yes: true });
        expect(parseArgs(['delete', '--yes', '--json']).flags).toEqual({ yes: true, json: true });
    });

    it('maps known short flags and leaves everything else positional', () => {
        expect(parseArgs(['call', '-i']).flags).toEqual({ interactive: true });
        expect(parseArgs(['logs', '-f']).flags).toEqual({ follow: true });
        expect(parseArgs(['delete', '-y']).flags).toEqual({ yes: true });
        // An unknown short flag is NOT invented into existence — it stays a word, so a typo surfaces
        // as an unknown subcommand rather than silently enabling nothing.
        expect(parseArgs(['logs', '-z']).words).toEqual(['logs', '-z']);
        // Multi-letter dash tokens are not short flags either.
        expect(parseArgs(['logs', '-abc']).words).toEqual(['logs', '-abc']);
    });

    it('does not let a short flag swallow the next argument', () => {
        // The reason short flags are boolean-only. With the long-flag rule applied to `-i`, the JSON
        // input would have become the VALUE of -i and the run would have been sent an empty input.
        const { words, flags } = parseArgs(['run', '-i', '{"n":1}']);
        expect(flags).toEqual({ interactive: true });
        expect(words).toEqual(['run', '{"n":1}']);
    });

    it('keeps JSON positional arguments intact', () => {
        const { words } = parseArgs(['run', '{"a":1,"b":"--x"}']);
        expect(words[1]).toBe('{"a":1,"b":"--x"}');
    });
});

// ─── Money ─────────────────────────────────────────────────────────────────

describe('usd', () => {
    it('formats micro-USDC exactly, with no floating point anywhere', () => {
        expect(usd(0)).toBe('0.000000');
        expect(usd(1)).toBe('0.000001');
        expect(usd(10_000)).toBe('0.010000');
        expect(usd(1_000_000)).toBe('1.000000');
        expect(usd(1_234_567)).toBe('1.234567');
    });

    it('agrees with the integer ledger at values where a float would not', () => {
        // 0.07 is unrepresentable in binary floating point. `70000 / 1e6` gives 0.07000000000000001,
        // and a publisher reconciling that against an on-chain transfer sees two numbers that should
        // be identical and are not.
        expect(usd(70_000)).toBe('0.070000');
        expect(usd(29_999_999)).toBe('29.999999');
        // Beyond Number.MAX_SAFE_INTEGER, which a lifetime sales total could reach in micro units.
        expect(usd('9007199254740993')).toBe('9007199254.740993');
    });

    it('handles negatives and absent values', () => {
        expect(usd(-1)).toBe('-0.000001');
        expect(usd(-1_500_000)).toBe('-1.500000');
        expect(usd(null)).toBe('0.000000');
        expect(usd(undefined)).toBe('0.000000');
    });
});

// ─── Schema-driven coercion ────────────────────────────────────────────────

describe('coerce', () => {
    it('obeys the declared type instead of guessing from the text', () => {
        // The whole point. A numeric-looking string stays a string when the schema says string —
        // otherwise an account number loses precision and a zip code loses its leading zero.
        expect(coerce('02134', 'string')).toBe('02134');
        expect(coerce('02134', undefined)).toBe('02134');
        expect(coerce('42', 'number')).toBe(42);
        expect(coerce('42', 'string')).toBe('42');
    });

    it('truncates for integer and keeps precision for number', () => {
        expect(coerce('2.7', 'integer')).toBe(2);
        expect(coerce('2.7', 'number')).toBe(2.7);
        expect(coerce('-3.9', 'integer')).toBe(-3);
    });

    it('accepts the spellings people actually type for booleans', () => {
        for (const yes of ['true', 'TRUE', 'yes', 'y', '1']) expect(coerce(yes, 'boolean')).toBe(true);
        for (const no of ['false', 'FALSE', 'no', 'n', '0']) expect(coerce(no, 'boolean')).toBe(false);
    });

    it('parses arrays and objects as JSON', () => {
        expect(coerce('[1,2,3]', 'array')).toEqual([1, 2, 3]);
        expect(coerce('{"a":1}', 'object')).toEqual({ a: 1 });
    });
});

// ─── Base58 ────────────────────────────────────────────────────────────────

describe('bs58', () => {
    it('encodes leading zero bytes as leading 1s', () => {
        // A Solana address with a zero-byte prefix loses that prefix if leading zeros are dropped,
        // which produces a DIFFERENT, valid-looking address. Funds go to the wrong place.
        expect(bs58(new Uint8Array([0, 0, 1]))).toBe('112');
        expect(bs58(new Uint8Array([0]))).toBe('1');
    });

    it('round-trips a known vector', () => {
        expect(bs58(new Uint8Array([1]))).toBe('2');
        expect(bs58(new Uint8Array([255]))).toBe('5Q');
    });
});

// ─── The bundler ───────────────────────────────────────────────────────────

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'sglproc-'));
    for (const [path, body] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, body);
    }
    return dir;
}

describe('bundleProcessor', () => {
    it('bundles TypeScript with relative imports into one module', async () => {
        const dir = project({
            'lib/math.ts': 'export const double = (n: number): number => n * 2;\n',
            'processor.ts': `import { double } from './lib/math.js';
export default { async fetch() { return Response.json({ n: double(21) }); } };
`,
        });
        const r = await bundleProcessor({ entry: join(dir, 'processor.ts'), cwd: dir });
        expect(r.bundle).toContain('export');
        // Types are stripped and the import is inlined — no module resolution left to fail at runtime.
        expect(r.bundle).not.toContain('./lib/math');
        expect(r.bundle).not.toContain(': number');
        expect(r.meta.entry).toBe('processor.ts');
        expect(Object.keys(r.meta.sources).sort()).toEqual(['lib/math.ts', 'processor.ts']);
    });

    it('hashes every source file, so what ran can be checked later', async () => {
        const dir = project({ 'processor.js': 'export default { async fetch() {} };\n' });
        const r = await bundleProcessor({ entry: join(dir, 'processor.js'), cwd: dir });
        expect(r.meta.sources['processor.js']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses Node built-ins the isolate does not have, naming the importer', async () => {
        // Caught HERE, on the publisher's terminal, rather than as a module-evaluation error inside a
        // paid run where they see "processor failed" and the buyer has already paid.
        const dir = project({
            'processor.js': "import { readFileSync } from 'node:fs';\nexport default { async fetch() { readFileSync('/x'); } };\n",
        });
        await expect(bundleProcessor({ entry: join(dir, 'processor.js'), cwd: dir }))
            .rejects.toThrow(/not available in a processor/);
    });

    it('uploads ONLY what was compiled, not whatever happens to be in the directory', async () => {
        // THE SECURITY PROPERTY OF THIS FUNCTION. `files` is uploaded to the platform. The first
        // implementation walked the directory and kept every .json, which would have shipped
        // credentials sitting next to a processor. Provenance is now the compiler's input list.
        const dir = project({
            'processor.js': 'export default { async fetch() {} };\n',
            'package.json': '{"name":"x"}',
            'package-lock.json': '{"lockfileVersion":3}',
            '.singularity.json': '{"invoke_token":"sglproc_SECRET_TOKEN"}',
            'credentials.json': '{"private_key":"SECRET_SERVICE_ACCOUNT"}',
            'notes/scratch.js': 'const unused = "NOT_COMPILED";\n',
        });
        const r = await bundleProcessor({ entry: join(dir, 'processor.js'), cwd: dir });
        expect(Object.keys(r.files)).toEqual(['processor.js']);
        const serialized = JSON.stringify(r.files) + JSON.stringify(r.meta.sources);
        expect(serialized).not.toContain('SECRET_TOKEN');
        expect(serialized).not.toContain('SECRET_SERVICE_ACCOUNT');
        expect(serialized).not.toContain('NOT_COMPILED');
    });

    it('never follows a symlink, even one that was imported', async () => {
        // The exfiltration path adversarial review found: a link to a wallet keypair, read and
        // uploaded as provenance. esbuild resolves through the link to compile, so the bundle works
        // — but the LINK ITSELF is not uploaded as a file, which is what stops the read.
        const dir = project({
            'secret-elsewhere.js': 'export const key = "WALLET_KEYPAIR_BYTES";\n',
            'processor.js': "import { key } from './linked.js';\nexport default { async fetch() { return Response.json({ key }); } };\n",
        });
        symlinkSync(join(dir, 'secret-elsewhere.js'), join(dir, 'linked.js'));
        const r = await bundleProcessor({ entry: join(dir, 'processor.js'), cwd: dir });
        expect(Object.keys(r.files)).not.toContain('linked.js');
        // The real file is inside the project and WAS compiled, so it is legitimate provenance.
        // What matters is that the path recorded is the resolved one, never the link.
        for (const p of Object.keys(r.files)) expect(p).not.toBe('linked.js');
    });

    it('refuses a compiled file that resolves outside the project', async () => {
        // A processor importing '../../.ssh/config'-style paths must not turn provenance into an
        // arbitrary-file read of the publisher's machine.
        const outer = project({ 'outside.js': 'export const x = "OUTSIDE_THE_PROJECT";\n' });
        const inner = join(outer, 'app');
        mkdirSync(inner, { recursive: true });
        writeFileSync(join(inner, 'processor.js'),
            "import { x } from '../outside.js';\nexport default { async fetch() { return Response.json({ x }); } };\n");
        const r = await bundleProcessor({ entry: join(inner, 'processor.js'), cwd: inner });
        // Compiled and inlined — the code still runs...
        expect(r.bundle).toContain('OUTSIDE_THE_PROJECT');
        // ...but the file's CONTENTS are never uploaded, because it is outside the project root.
        expect(Object.keys(r.files)).toEqual(['processor.js']);
        expect(JSON.stringify(r.files)).not.toContain('OUTSIDE_THE_PROJECT');
    });

    it('inlines a dependency without uploading node_modules', async () => {
        const dir = project({
            'node_modules/dep/package.json': '{"name":"dep","version":"1.0.0","main":"index.js"}',
            'node_modules/dep/index.js': 'export const marker = "FROM_DEP";\n',
            'processor.js': "import { marker } from 'dep';\nexport default { async fetch() { return Response.json({ marker }); } };\n",
        });
        const r = await bundleProcessor({ entry: join(dir, 'processor.js'), cwd: dir });
        // The dependency's CODE crosses the boundary, inlined into the bundle...
        expect(r.bundle).toContain('FROM_DEP');
        // ...but node_modules itself never does.
        expect(Object.keys(r.files).some((p) => p.includes('node_modules'))).toBe(false);
    });

    it('fails on a missing entry rather than uploading nothing', async () => {
        const dir = project({ 'other.js': '' });
        await expect(bundleProcessor({ entry: join(dir, 'processor.js'), cwd: dir }))
            .rejects.toThrow(/no entry file/);
    });
});

// ─── Interactive input ─────────────────────────────────────────────────────

/**
 * prompt() must survive MORE THAN ONE LINE ARRIVING AT ONCE.
 *
 * THE BUG: a chunk of stdin can hold several lines. Typing interactively you get one line per chunk
 * and never see it, but `printf 'world\n4\n' | singularity processors call -i` — or pasting two lines —
 * delivers both in a single chunk. The first version resolved with line one and THREW THE REST AWAY,
 * so the second question waited forever for data that had already arrived. The command hung with two
 * prompts printed on one line. Found by piping into it, not by any test.
 */
describe('prompt', () => {
    /** Feed a fake stdin, capture what is written, and restore everything afterwards. */
    async function withStdin<T>(chunks: string[], isTTY: boolean, fn: () => Promise<T>): Promise<{ result: T; out: string }> {
        const { PassThrough } = await import('node:stream');
        const stream = new PassThrough();
        const fake = stream as unknown as NodeJS.ReadStream & { isTTY?: boolean };
        fake.isTTY = isTTY;
        (fake as unknown as { unref: () => void }).unref = () => {};
        const realIn = process.stdin;
        const realWrite = process.stdout.write.bind(process.stdout);
        let out = '';
        Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
        process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
        try {
            const p = fn();
            // Deliver every chunk as ONE write, which is what reproduces the bug.
            for (const c of chunks) stream.write(c);
            const result = await p;
            return { result, out };
        } finally {
            process.stdout.write = realWrite;
            Object.defineProperty(process, 'stdin', { value: realIn, configurable: true });
        }
    }

    it('reads two answers out of a SINGLE chunk', async () => {
        const { result } = await withStdin(['world\n4\n'], false, async () => {
            const a = await prompt('name');
            const b = await prompt('times');
            return [a, b];
        });
        expect(result).toEqual(['world', '4']);
    });

    it('handles a line split ACROSS chunks', async () => {
        const { result } = await withStdin(['wor', 'ld\n'], false, () => prompt('name'));
        expect(result).toBe('world');
    });

    it('falls back to the default on an empty answer', async () => {
        const { result } = await withStdin(['\n'], false, () => prompt('times', '2'));
        expect(result).toBe('2');
    });

    it('echoes a piped answer but not a typed one', async () => {
        // A terminal already echoes what you type; echoing again doubles every character. A pipe
        // echoes nothing, so without this a transcript reads as a question nobody answered.
        const piped = await withStdin(['hello\n'], false, () => prompt('name'));
        expect(piped.out).toContain('hello\n');
        const typed = await withStdin(['hello\n'], true, () => prompt('name'));
        expect(typed.out).toBe('name: ');
    });
});

// ─── Payout addresses: the one field where a typo is unrecoverable ──────────

describe('payout address checks', () => {
    it('accepts a base58 Solana address and a checksummed EVM address', () => {
        expect(checkPayoutAddress('solana', '3TeWgRN8ZpZ2y36rfMBxZuyah116KSTZrAmK5ttdScjJ')).toBeNull();
        expect(checkPayoutAddress('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBeNull();
        expect(checkPayoutAddress('robinhood', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBeNull();
    });

    it('rejects the wrong address shape for the chain', () => {
        expect(checkPayoutAddress('solana', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBeTruthy();
        expect(checkPayoutAddress('base', '3TeWgRN8ZpZ2y36rfMBxZuyah116KSTZrAmK5ttdScjJ')).toBeTruthy();
    });

    it('rejects the zero address, which would burn every sale silently', () => {
        expect(checkPayoutAddress('base', `0x${'0'.repeat(40)}`)).toBeTruthy();
    });

    it('rejects empty and non-string values rather than deploying them', () => {
        for (const bad of ['', '   ', null, undefined, 42, {}]) {
            expect(checkPayoutAddress('base', bad), String(bad)).toBeTruthy();
        }
    });

    it('accepts an all-lowercase EVM address, which carries no checksum to fail', () => {
        // EIP-55 is enforced server-side; the CLI has no keccak256 and says so rather than pretending.
        expect(checkPayoutAddress('base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBeNull();
    });
});
