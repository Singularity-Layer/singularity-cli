/**
 * `singularity sandbox ssh | ssh-config | ssh-proxy`: real SSH into a Coding sandbox, so ssh, scp,
 * sftp, port forwarding and VS Code / Cursor Remote-SSH work.
 *
 * There is no port to dial. `ssh-proxy` is the ProxyCommand: it asks the API for a single-use,
 * 60-second SSH ticket bound to YOUR public key (POST /pods/<id>/coding/ssh), then carries the SSH
 * byte stream over a WebSocket to /pods/screen/<ticket>, which the sandbox's own outbound tunnel
 * relays to an SSH server started for that one connection. That server accepts only the key the
 * ticket was made for, and logs in as the sandbox user (never root).
 *
 * Two layers, both needed: your API key (or wallet signature) at our API, then your SSH key in the
 * sandbox. The private key never leaves this machine.
 *
 * ssh-config writes ONE managed block per sandbox at the top of ~/.ssh/config (ssh keeps the first
 * value it finds, so a `Host *` further down cannot override it), with absolute paths so an editor
 * started from the dock finds node and this CLI.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { die, ok, type Flags, type Creds } from './auth.js';
import { call, ApiError, explain, type Ctx } from './sandbox.js';

export const SSH_USER = 'node';
/** Our tunnel's keepalive text frame; the API answers it without waking anything. Never written to stdout. */
export const POD_KEEPALIVE = '{"type":"keepalive"}';
/** Close codes from the API that mean "try a new ticket" rather than "give up". */
export const SSH_NOT_READY_CLOSE = 4011;   // the sandbox is still finishing its SSH setup
export const POD_DID_NOT_ANSWER_CLOSE = 4002;

export function singularityDir(home = homedir()): string { return join(home, '.singularity'); }
export function keyPath(home = homedir()): string { return join(singularityDir(home), 'ssh', 'id_ed25519'); }
export function knownHostsPath(home = homedir()): string { return join(singularityDir(home), 'ssh', 'known_hosts'); }
export function credentialsPath(home = homedir()): string { return join(singularityDir(home), 'credentials.json'); }

/**
 * The API key saved by ssh-config, so ssh-proxy can authenticate when an editor runs it without
 * your shell's environment. Only read when no --api-key flag and no SGL_API_KEY are set.
 */
export function savedApiKey(home = homedir()): string | null {
    try {
        const j = JSON.parse(readFileSync(credentialsPath(home), 'utf8'));
        return typeof j?.api_key === 'string' && j.api_key.trim() ? j.api_key.trim() : null;
    } catch { return null; }
}

export function saveApiKey(key: string, home = homedir()): string {
    const p = credentialsPath(home);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify({ api_key: key }) + '\n', { mode: 0o600 });
    try { chmodSync(p, 0o600); } catch { /* windows */ }
    return p;
}

/** Make ~/.singularity/ssh/id_ed25519 with ssh-keygen if it is not there. Returns the public key line. */
export function ensureKeypair(home = homedir()): string {
    const k = keyPath(home);
    if (!existsSync(k + '.pub')) {
        mkdirSync(dirname(k), { recursive: true, mode: 0o700 });
        const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'singularity-sandbox', '-f', k], { stdio: ['ignore', 'inherit', 'inherit'] });
        if (r.error || r.status !== 0) die('could not make an SSH key with ssh-keygen. Install OpenSSH (it comes with macOS, Linux and Windows 10+) and try again.');
    }
    return readFileSync(k + '.pub', 'utf8').trim();
}

// ─── ~/.ssh/config block ────────────────────────────────────────────────────

/** A path inside ssh_config: forward slashes, quoted, and '%' doubled (ssh expands %-tokens). */
export function sshPath(p: string): string {
    // eslint-disable-next-line no-control-regex
    return '"' + p.replace(/\\/g, '/').replace(/%/g, '%%').replace(/["\u0000-\u001f\u007f]/g, '') + '"';
}

/** `sgl-<name>` from the sandbox name (or its id), only [a-z0-9-]. */
export function hostAlias(id: string, name: string | null | undefined): string {
    const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    return 'sgl-' + (slug || id.slice(0, 8));
}

export interface BlockOpts {
    id: string;
    alias: string;
    nodePath: string;
    cliPath: string;
    home: string;
    /** Extra args for the ProxyCommand (a non-default --keypair or --compute-url). */
    extra?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function assertSandboxId(id: string): string {
    if (!UUID_RE.test(id)) die(`not a sandbox id: ${JSON.stringify(id).slice(0, 60)}`);
    return id;
}

/**
 * One word of the ProxyCommand. ssh hands that line to your shell on macOS and Linux, so it is
 * single-quoted there ($ and backticks stay literal); Windows runs it without a shell, which
 * takes double quotes. Control characters are dropped either way.
 */
export function proxyWord(p: string, platform: NodeJS.Platform = process.platform): string {
    // eslint-disable-next-line no-control-regex
    const clean = p.replace(/[\u0000-\u001f\u007f]/g, '').replace(/%/g, '%%');
    if (platform === 'win32') return '"' + clean.replace(/\\/g, '/').replace(/"/g, '') + '"';
    return "'" + clean.replace(/'/g, `'\\''`) + "'";
}

/** The ProxyCommand line (absolute node + CLI paths: an editor started from the dock has no PATH). */
export function proxyCommand(o: Pick<BlockOpts, 'id' | 'nodePath' | 'cliPath' | 'home' | 'extra'>, platform: NodeJS.Platform = process.platform): string {
    assertSandboxId(o.id);
    const w = (x: string) => proxyWord(x, platform);
    return [w(o.nodePath), w(o.cliPath), 'sandbox', 'ssh-proxy', o.id, '--public-key', w(keyPath(o.home) + '.pub'), ...(o.extra || []).map(w)].join(' ');
}

/** Options shared by the config block and `singularity sandbox ssh` (inline -o). */
export function sshOptions(o: BlockOpts): Array<[string, string]> {
    return [
        ['User', SSH_USER],
        ['ProxyCommand', proxyCommand(o)],
        ['IdentityFile', sshPath(keyPath(o.home))],
        ['IdentitiesOnly', 'yes'],
        // The host key is pinned per sandbox, in our own file, on first use.
        ['HostKeyAlias', `sgl-sandbox-${o.id}`],
        ['UserKnownHostsFile', sshPath(knownHostsPath(o.home))],
        ['StrictHostKeyChecking', 'accept-new'],
        // Real bytes every 30 s keep the session (and the sandbox) awake while you are connected.
        ['ServerAliveInterval', '30'],
        ['ServerAliveCountMax', '6'],
        ['ForwardAgent', 'no'],
        ['ForwardX11', 'no'],
    ];
}

const BEGIN = (id: string) => `# >>> singularity sandbox ${id} >>>`;
const END = (id: string) => `# <<< singularity sandbox ${id} <<<`;

export function renderBlock(o: BlockOpts): string {
    return [
        BEGIN(o.id),
        `# Managed by 'singularity sandbox ssh-config'. Remove with: singularity sandbox ssh-config ${o.id.slice(0, 8)} --remove`,
        `Host ${o.alias}`,
        ...sshOptions(o).map(([k, v]) => `  ${k} ${v}`),
        // Lines below this block in ~/.ssh/config apply to every host again (they used to be
        // global before the block was put on top: Include, IdentityFile, User, ...).
        'Match all',
        END(o.id),
        '',
    ].join('\n');
}

/** Aliases used by OTHER sandboxes' managed blocks (so two sandboxes never share one). */
export function aliasesInUse(config: string, exceptId: string): Set<string> {
    const out = new Set<string>();
    const re = /# >>> singularity sandbox ([0-9a-f-]{36}) >>>\n(?:#[^\n]*\n)*Host (\S+)/g;
    for (let m; (m = re.exec(config));) if (m[1] !== exceptId) out.add(m[2]!);
    return out;
}

/** Put the block for this sandbox at the top (replacing an old one), or remove it (block null). */
export function upsertBlock(config: string, id: string, block: string | null): string {
    const start = config.indexOf(BEGIN(id));
    let rest = config;
    if (start >= 0) {
        const endAt = config.indexOf(END(id), start);
        if (endAt >= 0) {
            let stop = endAt + END(id).length;
            if (config[stop] === '\n') stop++;
            if (config[stop] === '\n') stop++;   // the blank line upsert put after the block
            rest = config.slice(0, start) + config.slice(stop);
        }
    }
    if (block === null) return rest;
    return block + (rest.startsWith('\n') || rest === '' ? '' : '\n') + rest;
}

// ─── ssh-proxy ──────────────────────────────────────────────────────────────

/** Errors from the SSH ticket route that mean "wait and ask again". */
export function isWaitError(e: unknown): boolean {
    return e instanceof ApiError && (
        e.code === 'waking' || e.code === 'starting' || e.code === 'ssh_setting_up' || e.details.reason === 'waking'
        || (e.status === 409 && e.retryAfter > 0)
    );
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A single-use SSH socket URL. Waits (stderr only, never stdout) while the sandbox wakes or sets SSH up. */
export async function openSshUrl(ctx: Ctx, id: string, publicKey: string, deadline: number): Promise<string> {
    let said = '';
    for (;;) {
        try {
            const r = await call<{ path?: string; ticket?: string }>(ctx, 'POST', `/pods/${id}/coding/ssh`, { public_key: publicKey });
            const path = r.path || (r.ticket ? `/pods/screen/${encodeURIComponent(r.ticket)}` : '');
            if (!path.startsWith('/pods/screen/')) throw new ApiError(502, 'the server did not return an SSH link', '', {});
            return ctx.base.replace(/^http/, 'ws') + path;
        } catch (e) {
            if (!isWaitError(e) || Date.now() > deadline) throw e;
            const msg = (e as ApiError).code === 'ssh_setting_up' ? (e as ApiError).message : 'Waking your sandbox...';
            if (msg !== said) { process.stderr.write(msg + '\n'); said = msg; }
            await sleepMs(Math.min(20, Math.max(2, (e as ApiError).retryAfter || 4)) * 1000);
        }
    }
}

type Outcome = { kind: 'done'; code: number } | { kind: 'retry'; why: string };

/**
 * One WebSocket attempt. Bytes ssh wrote before the server said anything are kept in `early` and
 * sent again on a retry, so a retry (sandbox still finishing its setup) is invisible to ssh.
 */
function pipeOnce(url: string, early: Buffer[], st: { serverSpoke: boolean; stdinEnded: boolean }): Promise<Outcome> {
    const WS = (globalThis as any).WebSocket as (typeof WebSocket) | undefined;
    if (!WS) die('ssh needs Node.js 22 or newer (it uses the built-in WebSocket). Run: node --version');
    return new Promise((resolve) => {
        const ws = new WS!(url);
        ws.binaryType = 'arraybuffer';
        const stdin = process.stdin;
        let opened = false;
        let keep: ReturnType<typeof setInterval> | null = null;
        let flow: ReturnType<typeof setInterval> | null = null;
        const onData = (b: Buffer) => {
            if (!st.serverSpoke) early.push(b);
            if (ws.readyState === 1) ws.send(b);
            // Back-pressure: stop reading ssh while 4 MB wait to go out.
            if (ws.bufferedAmount > 4 * 1024 * 1024 && !flow) {
                stdin.pause();
                flow = setInterval(() => { if (ws.bufferedAmount < 1024 * 1024) { clearInterval(flow!); flow = null; stdin.resume(); } }, 50);
            }
        };
        const onEnd = () => { st.stdinEnded = true; try { ws.close(1000); } catch { /* closed */ } };
        const cleanup = () => {
            if (keep) clearInterval(keep);
            if (flow) clearInterval(flow);
            stdin.off('data', onData);
            stdin.off('end', onEnd);
            stdin.pause();
        };
        ws.onopen = () => {
            opened = true;
            for (const b of early) ws.send(b);
            stdin.on('data', onData);
            stdin.on('end', onEnd);
            stdin.resume();
            keep = setInterval(() => { if (ws.readyState === 1) ws.send(POD_KEEPALIVE); }, 25_000);
        };
        ws.onmessage = (e: MessageEvent) => {
            if (!(e.data instanceof ArrayBuffer)) return;   // keepalive answers and other text are not the SSH stream
            st.serverSpoke = true;
            early.length = 0;
            process.stdout.write(Buffer.from(e.data));
        };
        ws.onerror = () => { /* onclose follows */ };
        ws.onclose = (e: { code: number; reason: string }) => {
            cleanup();
            if (!st.serverSpoke && !st.stdinEnded && (e.code === SSH_NOT_READY_CLOSE || e.code === POD_DID_NOT_ANSWER_CLOSE || !opened)) {
                return resolve({ kind: 'retry', why: e.code === SSH_NOT_READY_CLOSE ? 'Your sandbox is finishing setting up SSH...' : 'Reaching your sandbox...' });
            }
            if (!st.serverSpoke) process.stderr.write(`singularity: the SSH connection closed before the sandbox answered (${e.code}${e.reason ? ' ' + e.reason : ''}).\n`);
            resolve({ kind: 'done', code: st.serverSpoke ? 0 : 255 });
        };
    });
}

export async function sshProxy(ctx: Ctx, id: string, publicKeyFile: string): Promise<void> {
    if (!existsSync(publicKeyFile)) die(`no public key at ${publicKeyFile}. Run: singularity sandbox ssh-config`);
    const publicKey = readFileSync(publicKeyFile, 'utf8').trim();
    // About 4 minutes for a sandbox that sleeps and has never had SSH (wake + one-time setup).
    const deadline = Date.now() + 4 * 60_000;
    const early: Buffer[] = [];
    const st = { serverSpoke: false, stdinEnded: false };
    let said = '';
    for (let attempt = 0; ; attempt++) {
        let url: string;
        try { url = await openSshUrl(ctx, id, publicKey, deadline); } catch (e) { process.stderr.write(`singularity: ${explain(e)}\n`); process.exit(255); }
        const out = await pipeOnce(url, early, st);
        if (out.kind === 'done') { process.exitCode = out.code; return; }
        if (Date.now() > deadline || attempt >= 12) { process.stderr.write('singularity: the sandbox did not answer. Try again in a minute.\n'); process.exit(255); }
        if (out.why !== said) { process.stderr.write(out.why + '\n'); said = out.why; }
        await sleepMs(10_000);
    }
}

// ─── entry points (from sandbox.ts) ─────────────────────────────────────────

/** Where this CLI lives, for the ProxyCommand. */
export function selfPaths(): { nodePath: string; cliPath: string } {
    let cli = process.argv[1] || '';
    try { cli = realpathSync(cli); } catch { /* keep as is */ }
    return { nodePath: stableNodePath(), cliPath: cli };
}

/**
 * The node on PATH when it is this same binary (e.g. /opt/homebrew/bin/node), not the versioned
 * path it resolves to (/opt/homebrew/Cellar/node/26.5.0_1/...), which an upgrade deletes.
 */
export function stableNodePath(): string {
    const exe = process.execPath;
    const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    let real = exe;
    try { real = realpathSync(exe); } catch { /* keep */ }
    for (const d of dirs) {
        if (!d) continue;
        const cand = join(d, name);
        try { if (realpathSync(cand) === real) return cand; } catch { /* not there */ }
    }
    return exe;
}

/** ProxyCommand extras: only what differs from the defaults (never a secret). */
export function proxyExtras(flags: Flags): string[] {
    const out: string[] = [];
    // Absolute: an editor runs the ProxyCommand from another folder.
    if (typeof flags.keypair === 'string') out.push('--keypair', resolve(flags.keypair));
    if (typeof flags['compute-url'] === 'string') out.push('--compute-url', flags['compute-url']);
    return out;
}

export function sshConfigCommand(id: string, name: string | null, flags: Flags, creds: Creds, home = homedir()): void {
    assertSandboxId(id);
    const cfgPath = join(home, '.ssh', 'config');
    const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
    if (flags.remove) {
        writeFileSync(cfgPath, upsertBlock(existing, id, null));
        ok(`Removed the SSH entry for ${id.slice(0, 8)} from ${cfgPath}.`);
        return;
    }
    ensureKeypair(home);
    let alias = typeof flags.host === 'string' ? flags.host : hostAlias(id, name);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(alias)) die('--host may only use letters, digits, ".", "_" and "-"');
    if (aliasesInUse(existing, id).has(alias)) alias = `${alias}-${id.slice(0, 8)}`;
    const { nodePath, cliPath } = selfPaths();
    const block = renderBlock({ id, alias, nodePath, cliPath, home, extra: proxyExtras(flags) });
    if (flags.print) { process.stdout.write(block); return; }
    mkdirSync(join(home, '.ssh'), { recursive: true, mode: 0o700 });
    writeFileSync(cfgPath, upsertBlock(existing, id, block), { mode: 0o600 });
    // An editor runs the ProxyCommand without your shell's environment: keep the key you used here.
    let saved = '';
    if (creds.apiKey && !flags['no-save-key']) saved = saveApiKey(creds.apiKey, home);
    if (/[\\/]_npx[\\/]/.test(cliPath)) {
        process.stderr.write('Note: this runs from the npx cache, which can be cleared. For a lasting setup: npm install -g @singularity-layer/cli, then run ssh-config again.\n');
    }
    ok(`SSH is set up for this sandbox as "${alias}" (in ${cfgPath}).`);
    if (saved) ok(`Your API key was saved to ${saved} (only you can read it) so editors can connect. Use --no-save-key to skip.`);
    ok('');
    ok(`  ssh ${alias}                      a shell in the sandbox`);
    ok(`  scp ./file ${alias}:workspace/     copy files in (or out)`);
    ok(`  ssh -L 3000:localhost:3000 ${alias}   open the sandbox's port 3000 on this machine`);
    ok('');
    ok(`VS Code or Cursor: install "Remote - SSH", then "Connect to Host..." and pick ${alias}.`);
    ok('The first connection can take a minute while the sandbox wakes; set "remote.SSH.connectTimeout": 60.');
    ok('An open connection keeps the sandbox awake (awake hours count as usual). It sleeps again once you disconnect.');
}

export async function sshCommand(id: string, flags: Flags, extraArgs: string[], home = homedir()): Promise<void> {
    assertSandboxId(id);
    ensureKeypair(home);
    const { nodePath, cliPath } = selfPaths();
    const opts = sshOptions({ id, alias: '', nodePath, cliPath, home, extra: proxyExtras(flags) });
    // ssh parses -o exactly like a config line, so the same quoted values work here.
    // The destination first: ssh still reads options after it (-L ...), and the rest is the command.
    const args = [...opts.flatMap(([k, v]) => ['-o', `${k} ${v}`]), `sgl-sandbox-${id}`, ...extraArgs];
    const p = spawn('ssh', args, { stdio: 'inherit' });
    await new Promise<void>((resolve) => {
        p.on('error', () => { process.stderr.write('error: could not run ssh. Install OpenSSH (it comes with macOS, Linux and Windows 10+).\n'); process.exitCode = 1; resolve(); });
        p.on('exit', (code) => { process.exitCode = code ?? 1; resolve(); });
    });
}
