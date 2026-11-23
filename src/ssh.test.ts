/**
 * `singularity sandbox ssh-config / ssh-proxy`: the parts that can be wrong with no network. The
 * tunnel itself was proven against production on a test sandbox (see the PR).
 */
import { describe, it, expect } from 'vitest';
import { renderBlock, upsertBlock, aliasesInUse, hostAlias, sshPath, proxyCommand, isWaitError, keyPath, sshOptions } from './ssh.js';
import { ApiError, loadSandboxCreds } from './sandbox.js';

const ID = '9f19b672-8951-4d86-b9b1-e5b4fac92b84';
const OTHER = '11111111-2222-4333-8444-555555555555';
const base = { nodePath: '/usr/local/bin/node', cliPath: '/opt/lib/node_modules/@singularity-layer/cli/dist/cli.js', home: '/Users/me' };

describe('ssh config block', () => {
    it('logs in as the sandbox user through our ProxyCommand, our key only, pinned host key, keepalives', () => {
        const b = renderBlock({ id: ID, alias: 'sgl-test', ...base });
        expect(b.split('\n')[0]).toBe(`# >>> singularity sandbox ${ID} >>>`);
        expect(b).toContain('\nHost sgl-test\n');
        expect(b).toContain('  User node\n');
        expect(b).toContain(`  ProxyCommand "/usr/local/bin/node" "/opt/lib/node_modules/@singularity-layer/cli/dist/cli.js" sandbox ssh-proxy ${ID} --public-key "/Users/me/.singularity/ssh/id_ed25519.pub"\n`);
        expect(b).toContain('  IdentityFile "/Users/me/.singularity/ssh/id_ed25519"\n');
        expect(b).toContain('  IdentitiesOnly yes\n');
        expect(b).toContain(`  HostKeyAlias sgl-sandbox-${ID}\n`);
        expect(b).toContain('  UserKnownHostsFile "/Users/me/.singularity/ssh/known_hosts"\n');
        expect(b).toContain('  StrictHostKeyChecking accept-new\n');
        expect(b).toContain('  ServerAliveInterval 30\n');
        expect(b).toContain('  ForwardAgent no\n');
        expect(b).not.toMatch(/x402c_|api[-_]key/i);   // never a secret in ~/.ssh/config
    });
    it('Windows paths become forward slashes; % is escaped for ssh tokens', () => {
        expect(sshPath('C:\\Users\\Me Me\\node.exe')).toBe('"C:/Users/Me Me/node.exe"');
        expect(sshPath('/a/100%/b')).toBe('"/a/100%%/b"');
        expect(sshPath('/a"\nProxyCommand evil\n/b')).toBe('"/aProxyCommand evil/b"');   // no line break into the config
        expect(proxyCommand({ id: ID, nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\c\\cli.js', home: 'C:\\Users\\me' })).toContain('"C:/Users/me/.singularity/ssh/id_ed25519.pub"');
        expect(keyPath('/h')).toBe('/h/.singularity/ssh/id_ed25519');
    });
    it('goes at the top, replaces its own old block, never touches the rest, and can be removed', () => {
        const user = 'Host *\n  ServerAliveInterval 5\n\nHost work\n  HostName w.example\n';
        const one = upsertBlock(user, ID, renderBlock({ id: ID, alias: 'sgl-a', ...base }));
        expect(one.startsWith(`# >>> singularity sandbox ${ID} >>>`)).toBe(true);
        expect(one.endsWith(user)).toBe(true);
        const two = upsertBlock(one, ID, renderBlock({ id: ID, alias: 'sgl-b', ...base }));
        expect(two.match(/singularity sandbox 9f19b672-8951-4d86-b9b1-e5b4fac92b84 >>>/g)).toHaveLength(1);
        expect(two).toContain('Host sgl-b');
        expect(two).not.toContain('Host sgl-a');
        expect(two.endsWith(user)).toBe(true);
        const both = upsertBlock(two, OTHER, renderBlock({ id: OTHER, alias: 'sgl-c', ...base }));
        expect([...aliasesInUse(both, ID)]).toEqual(['sgl-c']);
        expect(upsertBlock(upsertBlock(both, ID, null), OTHER, null)).toBe(user);
        expect(upsertBlock('', ID, renderBlock({ id: ID, alias: 'x', ...base }))).toBe(renderBlock({ id: ID, alias: 'x', ...base }));
    });
    it('alias from the sandbox name, else the id', () => {
        expect(hostAlias(ID, 'Claude Code sandbox')).toBe('sgl-claude-code-sandbox');
        expect(hostAlias(ID, '  !!! ')).toBe('sgl-9f19b672');
        expect(hostAlias(ID, null)).toBe('sgl-9f19b672');
        expect(hostAlias(ID, 'a'.repeat(80))).toBe('sgl-' + 'a'.repeat(32));
    });
    it('the inline ssh options are the same as the block (one source)', () => {
        const opts = Object.fromEntries(sshOptions({ id: ID, alias: '', ...base }));
        expect(opts.User).toBe('node');
        expect(opts.ProxyCommand).toContain('sandbox ssh-proxy ' + ID);
    });
});

describe('ssh-proxy waiting', () => {
    it('waits on waking / setting up / retry-after, gives up on the rest', () => {
        expect(isWaitError(new ApiError(409, 'x', 'ssh_setting_up', { retry_after_seconds: 15 }))).toBe(true);
        expect(isWaitError(new ApiError(409, 'x', 'waking', {}))).toBe(true);
        expect(isWaitError(new ApiError(409, 'x', 'starting', { retry_after_seconds: 5 }))).toBe(true);
        expect(isWaitError(new ApiError(409, 'x', 'not_available', {}))).toBe(false);
        expect(isWaitError(new ApiError(409, 'x', 'ssh_setup_failed', {}))).toBe(false);
        expect(isWaitError(new ApiError(403, 'x', 'forbidden', {}))).toBe(false);
        expect(isWaitError(new Error('x'))).toBe(false);
    });
});

describe('credentials for sandbox commands', () => {
    const env = { ...process.env };
    const restore = () => { process.env.SGL_API_KEY = env.SGL_API_KEY; process.env.SINGULARITY_API_KEY = env.SINGULARITY_API_KEY; if (env.SGL_API_KEY === undefined) delete process.env.SGL_API_KEY; if (env.SINGULARITY_API_KEY === undefined) delete process.env.SINGULARITY_API_KEY; };
    it('flag and env beat the saved key; the saved key beats the default keypair', () => {
        try {
            delete process.env.SGL_API_KEY; delete process.env.SINGULARITY_API_KEY;
            expect(loadSandboxCreds({}, () => 'x402c_saved')).toEqual({ apiKey: 'x402c_saved' });
            expect(loadSandboxCreds({ 'api-key': 'x402c_flag' }, () => 'x402c_saved')).toEqual({ apiKey: 'x402c_flag' });
            process.env.SGL_API_KEY = 'x402c_env';
            expect(loadSandboxCreds({}, () => 'x402c_saved')).toEqual({ apiKey: 'x402c_env' });
        } finally { restore(); }
    });
});
