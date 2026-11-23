/**
 * `singularity sandbox`: use a Coding sandbox from your own terminal.
 *
 * Every command here is the SAME API the browser uses, nothing new is exposed:
 *   connect   POST /pods/<id>/coding/terminal gives a single-use, 60-second ticket; the terminal is
 *             a WebSocket to /pods/screen/<ticket>, relayed by the sandbox's own outbound tunnel.
 *             No SSH, no open port. Text frame {cols, rows} = resize, binary = keystrokes/output.
 *   exec      POST /pods/v1/pods/<id>/exec
 *   files     GET/PUT /pods/v1/pods/<id>/files
 *   key       an OpenAI-compatible key for https://compute.x402layer.cc/pods/<id>/v1
 *
 * Auth: a compute API key (SGL_API_KEY) or a Solana keypair, signed per request with the compute
 * scheme (not the processors one: the two services verify different messages). The terminal, exec
 * and files need a key with the pods:control:write permission, because each one is a shell.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { loadCreds, die, ok, type Flags, type Creds } from './auth.js';
import { sshProxy, sshConfigCommand, sshCommand, savedApiKey, keyPath } from './ssh.js';

const DEFAULT_COMPUTE = 'https://compute.x402layer.cc';
/** The sandbox file API takes text up to this size (the request body cap is 128 KiB, JSON-escaped). */
export const MAX_PUT_BYTES = 100 * 1024;

export const HELP = `singularity sandbox: use your Coding sandbox from your own terminal

usage: singularity sandbox <subcommand> [sandbox] [options]

  list                          your Coding sandboxes
  status [sandbox]              state, harness, awake hours this month
  connect [sandbox]             open the sandbox's terminal here (a full shell)
                                type ~. at the start of a line to disconnect
  ssh-config [sandbox]          set up real SSH: ssh, scp, sftp, port forwarding, and
                                VS Code / Cursor Remote-SSH (writes a Host entry in ~/.ssh/config)
       --host <name>            the name to use with ssh (default sgl-<sandbox name>)
       --print | --remove       show the entry instead of writing it | take it out again
  ssh [sandbox] [-- ssh args]   ssh into the sandbox now (no config needed), e.g. -- -L 3000:localhost:3000
  ssh-proxy <sandbox>           the ProxyCommand ssh-config uses (you do not run this yourself)
  exec [sandbox] -- <command>   run one command, print its output, exit with its code
       --timeout <seconds>      1 to 300 (default 60)
  files [sandbox]               list the files in the workspace
  get [sandbox] <path> [local]  print a workspace file, or save it to <local>
  put [sandbox] <local> [path]  upload a text file (up to 100 KB) into the workspace
  wake [sandbox] | sleep [sandbox]
  key [sandbox] [--name <n>]    create an OpenAI-compatible key for the sandbox's coding agent
  keys [sandbox]                list those keys
  revoke-key [sandbox] <key-id>

[sandbox] is the sandbox id, the start of it, or its name (or pass --sandbox <it>).
Leave it out if you have only one.

auth:  SGL_API_KEY=x402c_...   a compute API key from Settings > API keys. connect, ssh, exec,
                                files and key need Compute "Extend, resize, destroy"
                                (compute:write) and Agent Pods "Read and write pod files,
                                install skills, create and restore backups" (pods:control:write). ssh-config saves the key it was run with to
                                ~/.singularity/credentials.json (mode 600) so editors can connect.
       --keypair <path>         or sign with a Solana keypair (default ~/.config/solana/id.json)
       --compute-url <url>      another API base (default ${DEFAULT_COMPUTE})
       --json                   machine-readable output

OpenAI-compatible address: after 'key', point any OpenAI client at the printed base URL with
model "agent-pod". Each request is one turn of the sandbox's coding agent.`;

// ─── HTTP ───────────────────────────────────────────────────────────────────

/**
 * Credentials for sandbox commands: --api-key, then SGL_API_KEY, then an explicit --keypair, then
 * the key ssh-config saved (editors run ssh-proxy without your shell's environment), then the
 * default Solana keypair.
 */
export function loadSandboxCreds(flags: Flags, saved: () => string | null = savedApiKey, useSaved = false): Creds {
    const envKey = (process.env.SGL_API_KEY || process.env.SINGULARITY_API_KEY || '').trim();
    // The saved key is for ssh-proxy only (an editor runs it without your environment); every
    // other command keeps the usual order, so nothing silently switches account.
    if (!useSaved || 'api-key' in flags || envKey || typeof flags.keypair === 'string') return loadCreds(flags);
    const k = saved();
    return k ? { apiKey: k } : loadCreds(flags);
}

export function computeBase(flags: Flags): string {
    const override = (typeof flags['compute-url'] === 'string' && flags['compute-url']) || process.env.SINGULARITY_COMPUTE_URL;
    if (override) {
        // Your key (or a replayable signature) goes to this host: https only, except your own machine.
        let u: URL;
        try { u = new URL(String(override)); } catch { return die(`--compute-url is not a URL: ${override}`); }
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
        if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) die('--compute-url must be https (http only for localhost)');
        process.stderr.write(`(using ${override})\n`);
        return String(override).replace(/\/+$/, '');
    }
    return DEFAULT_COMPUTE;
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Auth headers for one compute request.
 *
 * A key is sent as X-API-Key. A keypair signs the compute message: prefix, version, chain, address,
 * METHOD, path WITH its query string, sha256 of the exact body text, timestamp in ms, nonce. Any
 * byte off gives a bare 401, so the body string signed here is the one sent.
 */
export function computeAuthHeaders(creds: Creds, method: string, pathAndQuery: string, bodyText: string, now = Date.now(), nonce = randomBytes(16).toString('hex')): Record<string, string> {
    if (creds.apiKey) return { 'X-API-Key': creds.apiKey };
    const kp = creds.kp;
    if (!kp) return die('no credential');
    const message = ['X402-COMPUTE-AUTH', 'v1', 'solana', kp.address, method.toUpperCase(), pathAndQuery, sha256Hex(bodyText), String(now), nonce].join('\n');
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    return {
        'X-Auth-Address': kp.address,
        'X-Auth-Chain': 'solana',
        'X-Auth-Signature': Buffer.from(sig).toString('base64'),
        'X-Auth-Sig-Encoding': 'base64',
        'X-Auth-Timestamp': String(now),
        'X-Auth-Nonce': nonce,
    };
}

export class ApiError extends Error {
    constructor(public status: number, message: string, public code: string, public details: Record<string, unknown>) { super(message); }
    get retryAfter(): number { return Number(this.details.retry_after_seconds) || 0; }
}

/**
 * The compute API answers errors in two shapes: `{ error: "text", code }` (dashboard routes) and
 * `{ error: { code, message, details } }` (the /pods/v1 partner API). Both become one ApiError.
 */
export function parseApiError(status: number, text: string): ApiError {
    let p: any;
    try { p = JSON.parse(text); } catch { p = null; }
    if (p && typeof p.error === 'object' && p.error) {
        const details = (p.error.details && typeof p.error.details === 'object') ? p.error.details : {};
        return new ApiError(status, String(p.error.message || p.error.code || `HTTP ${status}`), String(details.code || details.reason || p.error.code || ''), details);
    }
    if (p && typeof p === 'object') {
        const details = (p.details && typeof p.details === 'object') ? { ...p, ...p.details } : p;
        return new ApiError(status, String(p.error || p.message || `HTTP ${status}`), String(p.code || details.code || ''), details);
    }
    return new ApiError(status, text.slice(0, 300) || `HTTP ${status}`, '', {});
}

export interface Ctx { base: string; creds: Creds; json: boolean }

export async function call<T = any>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = computeAuthHeaders(ctx.creds, method, path, bodyText);
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
        res = await fetch(ctx.base + path, { method, headers, body: body === undefined ? undefined : bodyText });
    } catch (e) {
        throw new ApiError(0, `could not reach ${ctx.base}: ${e instanceof Error ? e.message : String(e)}`, 'network', {});
    }
    const text = await res.text();
    if (!res.ok) throw parseApiError(res.status, text);
    try { return (text ? JSON.parse(text) : {}) as T; } catch { return {} as T; }
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Say what to do about the common refusals instead of echoing a status code. */
export function explain(e: unknown): string {
    if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
    if (e.status === 401) return `${e.message}. Check SGL_API_KEY (or your keypair).`;
    if (e.status === 403 && /compute:write/.test(e.message + JSON.stringify(e.details))) {
        return `${e.message}\n  connect, ssh, exec and key need a key with two permissions, ticked in Settings > API keys:\n  Compute "Extend, resize, destroy" (compute:write) and Agent Pods "Read and write pod files" (pods:control:write).`;
    }
    if (e.status === 403 && /pods:control:write/.test(e.message + JSON.stringify(e.details))) {
        return `${e.message}\n  Create a key in Settings > API keys and tick, under Agent Pods, "Read and write pod files,\n  install skills, create and restore backups" (pods:control:write). Use it as SGL_API_KEY.`;
    }
    if (e.status === 403 && (e.code === 'wallet_required' || /needs a wallet/i.test(e.message))) {
        return `${e.message}\n  exec, files and keys go through the pod API, which needs a key from a wallet login. 'singularity sandbox connect' works with any key.`;
    }
    return e.message;
}

function fail(e: unknown): never { return die(explain(e)); }

// ─── Which sandbox ──────────────────────────────────────────────────────────

export interface SandboxRow { id: string; name: string | null; status: string; model?: string | null; ai_mode?: string }

export async function listSandboxes(ctx: Ctx): Promise<SandboxRow[]> {
    const r = await call<{ pods?: any[] }>(ctx, 'GET', '/pods');
    return (r.pods || [])
        .filter((p) => p && p.agent_id === 'coding' && !['destroyed', 'deleted', 'failed'].includes(String(p.status)))
        .map((p) => ({ id: String(p.id), name: p.name ?? null, status: String(p.status), model: p.model ?? null, ai_mode: p.ai_mode }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pick one sandbox from an id, an id prefix or a name. Pure, so the ambiguity rules are tested. */
export function pickSandbox(rows: SandboxRow[], ref: string | undefined): { id: string } | { error: string } {
    if (!ref) {
        if (rows.length === 1) return { id: rows[0]!.id };
        if (!rows.length) return { error: 'you have no Coding sandbox. Create one in Studio or Cloud first.' };
        return { error: `you have ${rows.length} sandboxes; name one:\n` + rows.map((r) => `  ${r.id}  ${r.name || ''}`).join('\n') };
    }
    const exact = rows.filter((r) => r.id === ref.toLowerCase() || r.name === ref);
    if (exact.length === 1) return { id: exact[0]!.id };
    const pre = rows.filter((r) => r.id.startsWith(ref.toLowerCase()));
    if (pre.length === 1) return { id: pre[0]!.id };
    if (exact.length + pre.length > 1) return { error: `"${ref}" matches more than one sandbox; use more of the id` };
    return { error: `no Coding sandbox matches "${ref}"` };
}

async function resolveId(ctx: Ctx, ref: string | undefined): Promise<string> {
    // A full id needs no lookup (and works even where the list route is not reachable).
    if (ref && UUID.test(ref)) return ref.toLowerCase();
    const rows = await listSandboxes(ctx).catch(fail);
    const p = pickSandbox(rows, ref);
    if ('error' in p) return die(p.error);
    return p.id;
}

// ─── Wake handling ──────────────────────────────────────────────────────────

const isAsleepError = (e: unknown) => e instanceof ApiError && (
    e.code === 'waking' || e.details.reason === 'waking'
    || (e.status === 409 && /offline|waking|start it/i.test(e.message))
);

/**
 * Run a pod call, waking the sandbox when it is asleep. Newer servers wake it themselves and answer
 * "waking"; older ones answer "offline", and then this asks for a wake once. About a minute at most.
 */
async function withWake<T>(ctx: Ctx, id: string, fn: () => Promise<T>): Promise<T> {
    let asked = false;
    for (let i = 0; ; i++) {
        try { return await fn(); } catch (e) {
            if (!isAsleepError(e) || i >= 15) throw e;
            if (i === 0) process.stderr.write('Waking your sandbox...\n');
            if (!asked) { asked = true; await call(ctx, 'POST', `/pods/${id}/coding/wake`).catch(() => undefined); }
            await sleepMs(Math.max(2, (e as ApiError).retryAfter || 4) * 1000);
        }
    }
}

// ─── Terminal ───────────────────────────────────────────────────────────────

/** A single-use terminal socket URL (60 s). Waits while the sandbox wakes. */
export async function openTerminalUrl(ctx: Ctx, id: string): Promise<string> {
    for (let i = 0; ; i++) {
        try {
            const r = await call<{ path?: string; ticket?: string }>(ctx, 'POST', `/pods/${id}/coding/terminal`);
            const path = r.path || (r.ticket ? `/pods/screen/${encodeURIComponent(r.ticket)}` : '');
            if (!path.startsWith('/pods/screen/')) throw new ApiError(502, 'the server did not return a terminal link', '', {});
            return ctx.base.replace(/^http/, 'ws') + path;
        } catch (e) {
            if (!(e instanceof ApiError && e.code === 'waking') || i >= 15) throw e;
            if (i === 0) process.stderr.write('Waking your sandbox...\n');
            await sleepMs(Math.max(2, e.retryAfter || 4) * 1000);
        }
    }
}

/**
 * ssh-style escape: "~." at the start of a line disconnects, "~~" sends one "~". Anything else after a
 * held "~" sends both. Pure and stateful per session, so it is tested without a socket.
 */
export function makeEscapeFilter(): (chunk: Uint8Array) => { send: Uint8Array; disconnect: boolean } {
    let lineStart = true;
    let held = false;
    return (chunk) => {
        const out: number[] = [];
        for (const b of chunk) {
            if (held) {
                held = false;
                if (b === 0x2e) return { send: Uint8Array.from(out), disconnect: true };   // ~.
                if (b === 0x7e) { out.push(0x7e); lineStart = false; continue; }          // ~~
                out.push(0x7e);
            } else if (lineStart && b === 0x7e) { held = true; continue; }
            out.push(b);
            lineStart = b === 0x0d || b === 0x0a;
        }
        return { send: Uint8Array.from(out), disconnect: false };
    };
}

export function closeMessage(code: number, reason: string): { text: string; exit: number } {
    if (code === 1000 || code === 1005) return { text: 'Connection closed.', exit: 0 };
    if (code === 4006) return { text: 'Closed after 10 idle minutes.', exit: 0 };
    if (code === 1006) return { text: 'The terminal connection dropped.', exit: 1 };
    return { text: `The terminal closed${reason ? ': ' + reason : ''} (${code}).`, exit: 1 };
}

async function connect(ctx: Ctx, id: string): Promise<void> {
    const WS = (globalThis as any).WebSocket as (typeof WebSocket) | undefined;
    if (!WS) die('connect needs Node.js 22 or newer (it uses the built-in WebSocket). Run: node --version');
    const url = await openTerminalUrl(ctx, id).catch(fail);
    const stdin = process.stdin;
    const tty = !!stdin.isTTY;
    const ws = new WS!(url);
    ws.binaryType = 'arraybuffer';
    const filter = makeEscapeFilter();
    let opened = false;
    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        if (tty) { try { stdin.setRawMode(false); } catch { /* not a tty any more */ } }
        stdin.pause();
        stdin.unref();
    };
    process.on('exit', restore);
    const sendSize = () => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }));
    };
    const onData = (buf: Buffer) => {
        const { send, disconnect } = tty ? filter(buf) : { send: new Uint8Array(buf), disconnect: false };
        if (send.length && ws.readyState === 1) ws.send(send);
        if (disconnect) { process.stderr.write('\r\nDisconnected.\r\n'); try { ws.close(1000); } catch { /* closed */ } }
    };
    // Piped input: once it ends, send Ctrl-D so the remote shell sees end of input, like ssh does.
    const onEnd = () => { if (!tty && ws.readyState === 1) ws.send(new Uint8Array([0x04])); };
    const done = new Promise<void>((resolve) => {
        ws.onopen = () => {
            opened = true;
            if (tty) { stdin.setRawMode(true); process.stderr.write('Connected. Type ~. at the start of a line to disconnect.\r\n'); }
            stdin.on('data', onData);
            stdin.on('end', onEnd);
            stdin.resume();
            sendSize();
            if (process.stdout.isTTY) process.stdout.on('resize', sendSize);
        };
        ws.onmessage = (e: MessageEvent) => {
            if (e.data instanceof ArrayBuffer) process.stdout.write(Buffer.from(e.data));
        };
        ws.onerror = () => { /* onclose follows with the code */ };
        ws.onclose = (e: { code: number; reason: string }) => {
            restore();
            process.stdout.off('resize', sendSize);
            stdin.off('data', onData);
            stdin.off('end', onEnd);
            if (!opened) {
                process.stderr.write('Could not open the terminal (the link is single use and lasts 60 seconds). Try again.\n');
                process.exitCode = 1;
            } else {
                const m = closeMessage(e.code, e.reason);
                process.stderr.write(`\r\n${m.text}\n`);
                process.exitCode = m.exit;
            }
            resolve();
        };
    });
    // Ctrl-C reaches the remote shell as a byte in raw mode. These only fire for signals from outside.
    const bye = () => { try { ws.close(1000); } catch { /* closed */ } };
    // Signals from outside (Ctrl-C typed here is a byte in raw mode, not a signal): close cleanly,
    // which restores the terminal before exiting.
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT'] as const) process.once(sig, bye);
    await done;
}

// ─── Subcommands ────────────────────────────────────────────────────────────

/** The OpenAI-compatible key, from whichever owner route this credential may use. */
async function mintKey(ctx: Ctx, id: string, name: string): Promise<{ id: string; secret: string; base_url: string; model: string }> {
    try {
        const r = await call<any>(ctx, 'POST', `/pods/v1/pods/${id}/keys`, { name });
        return { id: r.key.id, secret: r.key.secret, base_url: r.endpoint.base_url, model: r.endpoint.model || 'agent-pod' };
    } catch (e) {
        // Account logins are refused by the partner pod API; the dashboard route serves them.
        if (!(e instanceof ApiError && e.status === 403 && (e.code === 'wallet_required' || /needs a wallet/i.test(e.message)))) throw e;
        const r = await call<any>(ctx, 'POST', `/pods/${id}/api-keys`, { name });
        return { id: r.row?.id, secret: r.key, base_url: r.base_url, model: 'agent-pod' };
    }
}

async function listKeys(ctx: Ctx, id: string): Promise<any[]> {
    try {
        return (await call<any>(ctx, 'GET', `/pods/v1/pods/${id}/keys`)).keys || [];
    } catch (e) {
        if (!(e instanceof ApiError && e.status === 403 && (e.code === 'wallet_required' || /needs a wallet/i.test(e.message)))) throw e;
        return ((await call<any>(ctx, 'GET', `/pods/${id}/api-keys`)).keys || []).map((k: any) => ({ ...k, revoked: Boolean(k.revoked_at) }));
    }
}

async function revokeKey(ctx: Ctx, id: string, keyId: string): Promise<void> {
    try {
        await call(ctx, 'DELETE', `/pods/v1/pods/${id}/keys/${keyId}`);
    } catch (e) {
        if (!(e instanceof ApiError && e.status === 403 && (e.code === 'wallet_required' || /needs a wallet/i.test(e.message)))) throw e;
        await call(ctx, 'DELETE', `/pods/${id}/api-keys/${keyId}`);
    }
}

/** Upload content must be text the file API can carry: valid UTF-8, no NUL bytes, under the cap. */
export function checkUpload(buf: Buffer): string | null {
    if (buf.length > MAX_PUT_BYTES) return `that file is ${Math.ceil(buf.length / 1024)} KB; put takes text files up to ${MAX_PUT_BYTES / 1024} KB. Use git or the terminal for bigger files.`;
    if (buf.includes(0)) return 'that looks like a binary file; put takes text files. Use git or the terminal for binaries.';
    if (Buffer.from(buf.toString('utf8'), 'utf8').compare(buf) !== 0) return 'that file is not UTF-8 text; put takes text files.';
    return null;
}

const out = (ctx: Ctx, human: string, data: unknown) => ok(ctx.json ? JSON.stringify(data) : human);

export async function run(words: string[], flags: Flags): Promise<void> {
    const sub = words[0];
    if (!sub || flags.help) { ok(HELP); if (!sub) process.exit(1); return; }
    const ctx: Ctx = { base: computeBase(flags), creds: loadSandboxCreds(flags, savedApiKey, sub === 'ssh-proxy'), json: !!flags.json };
    const args = words.slice(1);
    const sref = typeof flags.sandbox === 'string' ? flags.sandbox : undefined;

    switch (sub) {
        case 'list': case 'ls': {
            const rows = await listSandboxes(ctx).catch(fail);
            if (ctx.json) { ok(JSON.stringify(rows)); break; }
            if (!rows.length) { ok('No Coding sandboxes yet. Create one in Studio or Cloud.'); break; }
            for (const r of rows) ok(`${r.id}  ${(r.name || '').padEnd(20)}  ${r.status}`);
            break;
        }
        case 'status': {
            const id = await resolveId(ctx, sref || args[0]);
            const r = await call<any>(ctx, 'GET', `/pods/${id}/coding`).catch(fail);
            const c = r.coding || r;
            out(ctx, [
                `${id}  ${c.harness_name || c.harness || ''}`,
                `state         ${c.state}${c.busy ? ' (working)' : ''}`,
                `awake hours   ${c.awake_hours} of ${c.included_hours} included this month`,
                `sleeps after  ${c.idle_sleep_minutes} idle minutes`,
            ].join('\n'), c);
            break;
        }
        case 'connect': case 'shell': {
            const id = await resolveId(ctx, sref || args[0]);
            await connect(ctx, id);
            break;
        }
        case 'ssh-proxy': {
            // ssh's ProxyCommand: stdout IS the SSH stream, so nothing else may ever be printed there.
            const ref = sref || args[0];
            if (!ref || !UUID.test(ref)) { process.stderr.write('error: ssh-proxy needs the full sandbox id (singularity sandbox ssh-config writes it for you)\n'); process.exit(255); }
            const pub = typeof flags['public-key'] === 'string' ? flags['public-key'] : keyPath() + '.pub';
            await sshProxy(ctx, ref.toLowerCase(), pub);
            break;
        }
        case 'ssh-config': {
            const id = await resolveId(ctx, sref || args[0]);
            const rows = await listSandboxes(ctx).catch(() => [] as SandboxRow[]);
            sshConfigCommand(id, rows.find((r) => r.id === id)?.name ?? null, flags, ctx.creds);
            break;
        }
        case 'ssh': {
            // `ssh [sandbox] [-- ssh args...]`
            const sep = typeof flags['--'] === 'string' ? Number(flags['--']) - 2 : -1;
            const ref = sref || (sep !== 0 ? args[0] : undefined);
            const extra = sep >= 0 ? args.slice(sep) : [];
            const id = await resolveId(ctx, ref);
            await sshCommand(id, flags, extra);
            break;
        }
        case 'exec': {
            // `exec [sandbox] -- <command...>` or `exec [sandbox] "<command>"`.
            const sep = typeof flags['--'] === 'string' ? Number(flags['--']) - 2 : -1;
            let ref: string | undefined;
            let rest: string[];
            if (sep >= 0) { ref = sref || (sep > 0 ? args[0] : undefined); rest = args.slice(sep); }
            else { [ref, rest] = splitRef(args, Infinity, sref); }
            const command = rest.join(' ').trim();
            if (!command) die('usage: singularity sandbox exec [sandbox] -- <command>');
            const id = await resolveId(ctx, ref);
            const timeout = flags.timeout ? Number(flags.timeout) : 60;
            if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300) die('--timeout must be 1 to 300 seconds');
            const r = await withWake(ctx, id, () => call<any>(ctx, 'POST', `/pods/v1/pods/${id}/exec`, { command, timeout_seconds: timeout })).catch(fail);
            const x = r.exec || {};
            if (ctx.json) { ok(JSON.stringify(x)); break; }
            if (x.stdout) process.stdout.write(x.stdout);
            if (x.stderr) process.stderr.write(x.stderr);
            if (x.truncated) process.stderr.write('\n(output was cut short)\n');
            if (x.timed_out) { process.stderr.write(`\n(timed out after ${timeout}s)\n`); process.exitCode = 124; break; }
            process.exitCode = typeof x.exit_code === 'number' ? x.exit_code : 1;
            break;
        }
        case 'files': {
            const id = await resolveId(ctx, sref || args[0]);
            const r = await withWake(ctx, id, () => call<any>(ctx, 'GET', `/pods/v1/pods/${id}/files`)).catch(fail);
            if (ctx.json) { ok(JSON.stringify(r)); break; }
            const files: any[] = r.files || [];
            if (!files.length) { ok('(the workspace is empty)'); break; }
            for (const f of files) ok(`${String(f.size).padStart(9)}  ${f.path}`);
            break;
        }
        case 'get': case 'cat': {
            const [ref, rest] = splitRef(args, 2, sref);
            const [remote, local] = rest;
            if (!remote) die('usage: singularity sandbox get [sandbox] <path> [local-file]');
            const id = await resolveId(ctx, ref);
            const r = await withWake(ctx, id, () => call<any>(ctx, 'GET', `/pods/v1/pods/${id}/files?path=${encodeURIComponent(remote)}`)).catch(fail);
            const content = String(r.file?.content ?? '');
            if (local && local !== '-') { writeFileSync(local, content); out(ctx, `saved ${local}`, { path: r.file?.path, saved: local }); }
            else process.stdout.write(content);
            break;
        }
        case 'put': {
            const [ref, rest] = splitRef(args, 2, sref);
            const [local, remote] = rest;
            if (!local) die('usage: singularity sandbox put [sandbox] <local-file> [path]');
            if (!existsSync(local) || !statSync(local).isFile()) die(`no file at ${local}`);
            const buf = readFileSync(local);
            const bad = checkUpload(buf);
            if (bad) die(bad);
            const path = remote || local.split(/[\\/]/).pop()!;
            const id = await resolveId(ctx, ref);
            const r = await withWake(ctx, id, () => call<any>(ctx, 'PUT', `/pods/v1/pods/${id}/files`, { path, content: buf.toString('utf8') })).catch(fail);
            out(ctx, `uploaded ${r.file?.path ?? path} (${r.file?.size ?? buf.length} bytes)`, r.file);
            break;
        }
        case 'wake': case 'sleep': {
            const id = await resolveId(ctx, sref || args[0]);
            await call(ctx, 'POST', `/pods/${id}/coding/${sub}`).catch(fail);
            out(ctx, sub === 'wake' ? 'Awake.' : 'Asleep. It wakes again when you connect or send it work.', { ok: true });
            break;
        }
        case 'key': {
            const id = await resolveId(ctx, sref || args[0]);
            const name = typeof flags.name === 'string' ? flags.name : 'CLI key';
            const k = await mintKey(ctx, id, name).catch(fail);
            if (ctx.json) { ok(JSON.stringify(k)); break; }
            ok(`key       ${k.secret}`);
            ok(`base URL  ${k.base_url}`);
            ok(`model     ${k.model}`);
            ok('');
            ok('Shown once: store it now. Anyone with it can give your sandbox\'s coding agent work,');
            ok(`and the agent can run commands there. Revoke it with: singularity sandbox revoke-key ${id.slice(0, 8)} ${k.id}`);
            ok('');
            ok(`curl ${k.base_url}/chat/completions \\`);
            ok('  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \\');
            ok(`  -d '{"model":"${k.model}","stream":true,"messages":[{"role":"user","content":"hello"}]}'`);
            break;
        }
        case 'keys': {
            const id = await resolveId(ctx, sref || args[0]);
            const keys = await listKeys(ctx, id).catch(fail);
            if (ctx.json) { ok(JSON.stringify(keys)); break; }
            if (!keys.length) { ok('No keys. Create one with: singularity sandbox key'); break; }
            for (const k of keys) ok(`${k.id}  ${k.prefix || ''}...${k.last4 || ''}  ${(k.name || '').padEnd(16)}  ${k.revoked ? 'revoked' : 'active'}`);
            break;
        }
        case 'revoke-key': {
            const [ref, rest] = splitRef(args, 1, sref);
            const keyId = rest[0];
            if (!keyId || !UUID.test(keyId)) die('usage: singularity sandbox revoke-key [sandbox] <key-id>');
            const id = await resolveId(ctx, ref);
            await revokeKey(ctx, id, keyId).catch(fail);
            out(ctx, 'Revoked.', { ok: true });
            break;
        }
        default:
            console.error(`error: unknown sandbox subcommand "${sub}"\n`);
            ok(HELP);
            process.exit(1);
    }
}

/**
 * Split an optional leading sandbox reference from a command's own arguments. `--sandbox <ref>`
 * always wins. Otherwise the first word is the sandbox when there are more words than the command
 * takes, or when it plainly is one (a full id, or a hex id prefix of 4+ characters that is not a
 * path). With one sandbox on the account it can always be left out.
 */
export function splitRef(args: string[], maxOwn: number, flagRef?: string): [string | undefined, string[]] {
    if (flagRef) return [flagRef, args];
    if (args.length > maxOwn) return [args[0], args.slice(1)];
    if (args.length > 1 && (UUID.test(args[0]!) || looksLikeRef(args[0]!))) return [args[0], args.slice(1)];
    return [undefined, args];
}

export function looksLikeRef(s: string): boolean {
    return /^[0-9a-f]{4,}(-[0-9a-f-]*)?$/i.test(s) && !s.includes('.') && !s.includes('/');
}
