/**
 * `singularity sandbox`: the parts that can be wrong with no network involved. The HTTP and the
 * terminal socket were proven against production on a test sandbox (see the PR), not mocked here.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { parseArgs, bs58 } from './auth.js';
import {
    computeAuthHeaders, parseApiError, pickSandbox, splitRef, makeEscapeFilter, closeMessage, checkUpload, explain, ApiError, MAX_PUT_BYTES,
} from './sandbox.js';

describe('parseArgs: a bare -- ends the options', () => {
    it('keeps everything after -- verbatim and records where it fell', () => {
        const { words, flags } = parseArgs(['sandbox', 'exec', '99a7', '--timeout', '30', '--', 'ls', '-la', '--color']);
        expect(words).toEqual(['sandbox', 'exec', '99a7', 'ls', '-la', '--color']);
        expect(flags).toEqual({ timeout: '30', '--': '3' });
    });
    it('works with no sandbox before it', () => {
        const { words, flags } = parseArgs(['sandbox', 'exec', '--', 'echo', 'hi']);
        expect(words).toEqual(['sandbox', 'exec', 'echo', 'hi']);
        expect(flags['--']).toBe('2');
    });
});

describe('which sandbox', () => {
    const rows = [
        { id: '99a715f9-eead-42ff-9d5e-cb43178e0016', name: 'main', status: 'active' },
        { id: '99b00000-0000-4000-8000-000000000000', name: 'scratch', status: 'active' },
    ];
    it('one sandbox needs no name; none or many say so', () => {
        expect(pickSandbox(rows.slice(0, 1), undefined)).toEqual({ id: rows[0]!.id });
        expect(pickSandbox([], undefined)).toHaveProperty('error');
        expect((pickSandbox(rows, undefined) as any).error).toMatch(/2 sandboxes/);
    });
    it('by name, by unique prefix; an ambiguous prefix is refused, never guessed', () => {
        expect(pickSandbox(rows, 'scratch')).toEqual({ id: rows[1]!.id });
        expect(pickSandbox(rows, '99a7')).toEqual({ id: rows[0]!.id });
        expect((pickSandbox(rows, '99')).hasOwnProperty('error')).toBe(true);
        expect((pickSandbox(rows, 'nope') as any).error).toMatch(/no Coding sandbox/);
    });
    it('splits an optional leading sandbox from a command\'s own words', () => {
        expect(splitRef(['notes.md'], 2)).toEqual([undefined, ['notes.md']]);
        expect(splitRef(['notes.md', 'local.md'], 2)).toEqual([undefined, ['notes.md', 'local.md']]);
        expect(splitRef(['99a7', 'notes.md'], 2)).toEqual(['99a7', ['notes.md']]);
        expect(splitRef(['main', 'notes.md', 'out.md'], 2)).toEqual(['main', ['notes.md', 'out.md']]);
        expect(splitRef(['notes.md'], 2, 'main')).toEqual(['main', ['notes.md']]);
        // exec takes any number of words: only a plain id is read as the sandbox
        expect(splitRef(['ls', '-la'], Infinity)).toEqual([undefined, ['ls', '-la']]);
        expect(splitRef(['99a715f9', 'ls', '-la'], Infinity)).toEqual(['99a715f9', ['ls', '-la']]);
        expect(splitRef(['cafe.txt', 'x'], Infinity)).toEqual([undefined, ['cafe.txt', 'x']]);
    });
});

describe('compute auth', () => {
    it('a key is only X-API-Key', () => {
        expect(computeAuthHeaders({ apiKey: 'x402c_abc' }, 'POST', '/pods/x/coding/terminal', '')).toEqual({ 'X-API-Key': 'x402c_abc' });
    });
    it('a keypair signs the exact compute message, which verifies with its public key', () => {
        const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const kp = { secretKey: pair.secretKey, address: bs58(pair.publicKey) };
        const body = '{"command":"ls"}';
        const h = computeAuthHeaders({ kp }, 'post', '/pods/v1/pods/abc/files?path=a.txt', body, 1795242435000, 'n0nce');
        const msg = ['X402-COMPUTE-AUTH', 'v1', 'solana', kp.address, 'POST', '/pods/v1/pods/abc/files?path=a.txt',
            createHash('sha256').update(body).digest('hex'), '1795242435000', 'n0nce'].join('\n');
        expect(h['X-Auth-Sig-Encoding']).toBe('base64');
        expect(h['X-Auth-Timestamp']).toBe('1795242435000');
        expect(nacl.sign.detached.verify(new TextEncoder().encode(msg), Buffer.from(h['X-Auth-Signature']!, 'base64'), pair.publicKey)).toBe(true);
    });
});

describe('errors from both API shapes', () => {
    it('dashboard shape { error, code }', () => {
        const e = parseApiError(503, JSON.stringify({ error: 'Your sandbox is waking up.', code: 'waking', retry_after_seconds: 5 }));
        expect(e.message).toBe('Your sandbox is waking up.');
        expect(e.code).toBe('waking');
        expect(e.retryAfter).toBe(5);
    });
    it('pod API shape { error: { code, message, details } }', () => {
        const e = parseApiError(403, JSON.stringify({ error: { code: 'forbidden', message: 'needs pods:control:write', details: { required_scope: 'pods:control:write' } } }));
        expect(e.message).toBe('needs pods:control:write');
        expect(explain(e)).toMatch(/Settings > API keys/);
        const asleep = parseApiError(409, JSON.stringify({ error: { code: 'conflict', message: 'Your sandbox is waking up.', details: { reason: 'waking', retry_after_seconds: 5 } } }));
        expect(asleep.code).toBe('waking');
    });
    it('an account key refused by the pod API points at connect', () => {
        const e = parseApiError(403, JSON.stringify({ error: 'This needs a wallet. Use a wallet-owned key for it.', details: { code: 'wallet_required' } }));
        expect(e.code).toBe('wallet_required');
        expect(explain(e)).toMatch(/sandbox connect/);
    });
    it('non-JSON bodies still give a message', () => {
        expect(parseApiError(502, 'Bad gateway').message).toBe('Bad gateway');
        expect(explain(new ApiError(401, 'Invalid API key', '', {}))).toMatch(/SGL_API_KEY/);
    });
});

describe('terminal', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    it('~. at the start of a line disconnects; mid-line it is just text', () => {
        const f = makeEscapeFilter();
        expect(f(enc('echo a~.b')).disconnect).toBe(false);
        expect(dec(f(enc('\r')).send)).toBe('\r');
        const r = f(enc('~.'));
        expect(r.disconnect).toBe(true);
        expect(r.send.length).toBe(0);
    });
    it('the escape works at the very start and across chunks; ~~ sends one ~; ~x sends both', () => {
        const f = makeEscapeFilter();
        expect(f(enc('~')).send.length).toBe(0);
        expect(f(enc('.')).disconnect).toBe(true);
        const g = makeEscapeFilter();
        expect(dec(g(enc('~~')).send)).toBe('~');
        const h = makeEscapeFilter();
        expect(dec(h(enc('~x')).send)).toBe('~x');
        // Ctrl-C passes through untouched
        expect(Array.from(makeEscapeFilter()(new Uint8Array([3])).send)).toEqual([3]);
    });
    it('close codes read as plain sentences', () => {
        expect(closeMessage(1000, '')).toEqual({ text: 'Connection closed.', exit: 0 });
        expect(closeMessage(4006, '').text).toMatch(/idle/);
        expect(closeMessage(1006, '').exit).toBe(1);
    });
});

describe('put takes text files only', () => {
    it('refuses binary, non-UTF-8 and oversized files', () => {
        expect(checkUpload(Buffer.from('hello\n'))).toBeNull();
        expect(checkUpload(Buffer.from([0x68, 0x00, 0x69]))).toMatch(/binary/);
        expect(checkUpload(Buffer.from([0xff, 0xfe, 0x41]))).toMatch(/UTF-8/);
        expect(checkUpload(Buffer.alloc(MAX_PUT_BYTES + 1, 0x61))).toMatch(/KB/);
    });
});
