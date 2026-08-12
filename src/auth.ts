/**
 * Wallet signing and the signed HTTP client.
 *
 * Shared by every subcommand, so the signature scheme lives in exactly one place. Getting it subtly
 * wrong produces a 401 with no explanation, which is miserable to debug from a terminal.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import nacl from 'tweetnacl';

/**
 * EXPLICITLY ANNOTATED ON THE DECLARATION, not just on the arrow.
 *
 * TypeScript only narrows after a never-returning call when the *declaration* carries the type. With
 * the annotation on the arrow alone, `if (!key) die(...)` did not narrow `key`, so every guarded use
 * afterwards needed a redundant non-null assertion — and an assertion is exactly the thing that
 * silently survives a later refactor that removes the guard.
 */
export const die: (msg: string) => never = (msg) => {
    console.error(`error: ${msg}`);
    process.exit(1);
};
export const ok = (msg = ''): void => console.log(msg);

export interface Keypair {
    secretKey: Uint8Array;
    address: string;
}

export type Flags = Record<string, string | boolean>;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Base58 (Bitcoin alphabet), which is how Solana addresses are written.
 *
 * TWO PARTS, AND BOTH ARE LOAD-BEARING: the leading zero BYTES become leading '1' characters, and the
 * remaining bytes become a base-58 number. Base58 has no digit for a leading zero, so dropping those
 * bytes silently yields a shorter, still-valid-looking address — a different account. That is a
 * fund-safety property, not a formatting nicety.
 *
 * THE ZERO CASE WAS WRONG AND A TEST FOUND IT. The value part was seeded as `[0]` and always emitted
 * at least one digit, so an all-zero input produced one character too many: bs58([0]) returned '11'
 * instead of '1'. Every byte was already accounted for as a leading zero, and then the zero VALUE was
 * printed on top of them. Unreachable from a real keypair — no keypair derives an all-zero pubkey —
 * but the fix is to stop converting the leading zeros twice, which is also what makes the encoder
 * match every other base58 implementation on every input rather than merely on the likely ones.
 */
export function bs58(bytes: Uint8Array): string {
    // Leading zero bytes are positional, not numeric: they are emitted directly as '1's and excluded
    // from the number below.
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

    const digits: number[] = [];   // little-endian base-58 digits; empty means the value is zero
    for (let k = zeros; k < bytes.length; k++) {
        let carry = bytes[k] as number;
        for (let i = 0; i < digits.length; i++) {
            carry += (digits[i] as number) << 8;
            digits[i] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }

    let out = '1'.repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i] as number];
    return out;
}

/**
 * Load a Solana keypair.
 *
 * Defaults to the Solana CLI's location so most people need no configuration. The key never leaves
 * the machine — only a signature is sent.
 */
export function loadKeypair(flags: Flags = {}): Keypair {
    const path = String(
        flags.keypair
        || process.env.SINGULARITY_KEYPAIR
        || process.env.SGLPROC_KEYPAIR
        || join(homedir(), '.config/solana/id.json'),
    );
    if (!existsSync(path)) {
        die(`no keypair at ${path}\n  pass --keypair <path>, set SINGULARITY_KEYPAIR, or create one:\n  solana-keygen new`);
    }
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { die(`${path} is not a valid keypair file`); }
    if (!Array.isArray(raw) || (raw.length !== 64 && raw.length !== 32)) {
        die(`${path} does not look like a Solana keypair (expected a 64-byte array)`);
    }
    const arr = raw as number[];
    const secret = arr.length === 64
        ? Uint8Array.from(arr)
        : nacl.sign.keyPair.fromSeed(Uint8Array.from(arr)).secretKey;
    const pair = nacl.sign.keyPair.fromSecretKey(secret);
    return { secretKey: pair.secretKey, address: bs58(pair.publicKey) };
}

async function sha256Hex(input: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ApiOpts {
    body?: unknown;
    kp?: Keypair;
    bearer?: string;
    /**
     * Query parameters. An ARRAY value becomes REPEATED keys (`?tag=a&tag=b`), which is exactly what
     * the server reassembles an array input from. Joining them into `a,b` instead would arrive as one
     * string and, for a field whose schema says array, be delivered as `["a,b"]` — a paid run failing
     * on input the caller sent correctly.
     */
    query?: Record<string, string | number | Array<string | number>>;
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    /**
     * Sign the QUERY STRING as the body. GET run route ONLY — see the note in api().
     *
     * Not a preference. It must match, exactly, which raw string the server hashes for the route
     * being called; getting it wrong produces a 401 with no explanation.
     */
    signQuery?: boolean;
}

/**
 * Signed request against a Singularity service.
 *
 * The signature covers METHOD, PATH and a hash of the BODY, so it authorizes ONE exact request and
 * cannot be replayed against another route or with altered content.
 *
 * THREE THINGS HERE ARE STRUCTURAL, NOT STYLE:
 *
 *  1. The body is serialized ONCE into `raw`, and that same string is both hashed and sent.
 *     Serializing twice would let key order or whitespace differ, producing a valid-looking
 *     signature the server rejects as an unexplained 401.
 *
 *  2. `query` is kept SEPARATE from `path`. The server signs `new URL(url).pathname`, which excludes
 *     the query string — folding `?limit=50` into the path would 401 every time.
 *
 *  3. A GET signs the EMPTY STRING — except on the run route, where `signQuery` is set.
 *
 *     This asymmetry is the server's, and it is mandatory rather than chosen. The run route hashes
 *     `url.search` for a GET, because a GET run's INPUT lives in the query and signing '' would leave
 *     it unauthenticated. Every other owner GET route (list, detail, runs, earnings) verifies against
 *     '' and always has — as does the live dashboard, which signs '' for GET regardless of query. So
 *     "sign the query on every GET" is the version that looks more secure and 401s in production:
 *     `logs --limit 30` would sign `?limit=30` while the server hashed ''.
 *
 *     Found by adversarial review after I had written exactly that. The rule is: match the route.
 */
export async function api<T = unknown>(
    base: string,
    method: NonNullable<ApiOpts['method']>,
    path: string,
    { body, kp, bearer, query, signQuery }: ApiOpts = {},
): Promise<T> {
    let qs = '';
    if (query) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
            else params.append(k, String(v));
        }
        const encoded = params.toString();
        if (encoded) qs = '?' + encoded;
    }

    // See point 3. A GET has no body to send, and what it SIGNS depends on the route.
    const signedRaw = method === 'GET'
        ? (signQuery ? qs : '')
        : (body === undefined ? '' : JSON.stringify(body));
    const sentRaw = method === 'GET' ? undefined : (body === undefined ? undefined : signedRaw);

    const headers: Record<string, string> = {};
    if (sentRaw) headers['content-type'] = 'application/json';
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    if (kp) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = [...nacl.randomBytes(12)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const msg = `sgl-processor-auth:${method}:${path}:${await sha256Hex(signedRaw)}:${kp.address}:${timestamp}:${nonce}`;
        const sig = nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey);
        Object.assign(headers, {
            'X-Auth-Address': kp.address,
            'X-Auth-Chain': 'solana',
            'X-Auth-Signature': Buffer.from(sig).toString('base64'),
            'X-Auth-Timestamp': timestamp,
            'X-Auth-Nonce': nonce,
        });
    }

    let res: Response;
    try {
        res = await fetch(`${base}${path}${qs}`, { method, headers, body: sentRaw });
    } catch (e) {
        return die(`could not reach ${base} — ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (!res.ok) {
        const p = (parsed ?? {}) as { detail?: string; error?: string };
        return die(`${res.status} ${p.detail || p.error || text.slice(0, 300)}`);
    }
    return parsed as T;
}

/**
 * Short flags, mapped to their long names.
 *
 * DELIBERATELY A FIXED, BOOLEAN-ONLY SET. The general rule for long flags — "take the next token as
 * the value unless it looks like a flag" — cannot be applied to short ones here, because
 * `run -i '{"n":1}'` would swallow the JSON as the value of `-i`. Every short flag is therefore a
 * switch, and anything taking a value must be spelled out in full.
 */
const SHORT_FLAGS: Record<string, string> = {
    i: 'interactive',
    f: 'follow',
    y: 'yes',
    j: 'json',
};

/**
 * Parse argv into subcommand path, positional args, and flags.
 *
 * A flag is boolean when nothing follows it OR the next token is another flag. Missing the "nothing
 * follows" case made a trailing `--yes` parse as undefined, so a confirmation guard could never be
 * dismissed — found by actually running it.
 */
export function parseArgs(argv: string[]): { words: string[]; flags: Flags } {
    const flags: Flags = {};
    const words: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i] as string;

        if (tok.startsWith('--')) {
            const name = tok.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('-')) flags[name] = true;
            else { flags[name] = next; i++; }
            continue;
        }

        // A single-dash token is a short flag only if it is exactly one known letter. Anything else
        // starting with `-` stays a positional argument, so a negative number or a lone `-` is not
        // silently eaten.
        const short = /^-([a-zA-Z])$/.exec(tok);
        if (short && SHORT_FLAGS[short[1] as string]) {
            flags[SHORT_FLAGS[short[1] as string] as string] = true;
            continue;
        }

        words.push(tok);
    }
    return { words, flags };
}

/**
 * Leftover stdin, kept ACROSS prompt() calls.
 *
 * This buffer is the whole point, and its absence was a real bug: a chunk of stdin can contain more
 * than one line. Typing interactively you get one line per chunk and never notice, but piping
 * (`printf 'world\n4\n' | singularity processors call -i`) or pasting several lines delivers them in a
 * SINGLE chunk. The first version resolved with the first line and DISCARDED the rest, so the second
 * question's listener waited for data that had already arrived and been thrown away — the command hung
 * with two prompts printed on one line and no answer. Found by actually piping into it.
 */
let stdinRest = '';

/**
 * Read a line from the terminal. Used by the interactive `configure` and `call -i`.
 *
 * UNREFS STDIN WHEN DONE, which is not decoration. `resume()` adds a libuv reference, so a process
 * that has finished its work still has a live handle nothing will ever read from, and the command
 * prints its result and then hangs. Unrefing lets the loop drain and exit naturally — the
 * alternative, calling process.exit(), truncates piped stdout.
 */
export async function prompt(question: string, fallback = ''): Promise<string> {
    process.stdout.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);

    /** Take one line out of the buffer, leaving the remainder for the next question. */
    const takeLine = (): string | null => {
        const nl = stdinRest.indexOf('\n');
        if (nl < 0) return null;
        const line = stdinRest.slice(0, nl);
        stdinRest = stdinRest.slice(nl + 1);
        return line;
    };

    /**
     * Echo the answer only when stdin is NOT a terminal.
     *
     * A terminal echoes what the user types, so echoing again would double every character. A pipe
     * echoes nothing, so without this the transcript reads as a question nobody answered — which is
     * exactly how the piped run looked while I was verifying it.
     */
    const echo = (line: string) => {
        if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
    };

    // A line may already be buffered from a previous chunk.
    const buffered = takeLine();
    if (buffered !== null) {
        echo(buffered);
        return buffered.trim() || fallback;
    }

    const answer = await new Promise<string>((resolve) => {
        const onData = (chunk: Buffer) => {
            stdinRest += chunk.toString('utf8');
            const line = takeLine();
            if (line === null) return;    // partial line; wait for the rest
            process.stdin.off('data', onData);
            process.stdin.pause();
            process.stdin.unref();
            echo(line);
            resolve(line);
        };
        const onEnd = () => {
            // stdin closed with no trailing newline — treat what is left as the answer rather than
            // hanging forever on a line terminator that will never come.
            process.stdin.off('data', onData);
            const line = stdinRest;
            stdinRest = '';
            resolve(line);
        };
        process.stdin.once('end', onEnd);
        process.stdin.resume();
        process.stdin.on('data', onData);
    });
    return answer.trim() || fallback;
}
