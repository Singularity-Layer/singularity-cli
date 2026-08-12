/**
 * singularity — the Singularity developer CLI.
 *
 * ONE command, a subcommand per product. New capabilities become subcommands here rather than new
 * binaries; that rule is what stops this becoming five CLIs nobody can keep straight.
 *
 * It is deliberately NOT the same tool as:
 *   • `sgl`     — the Rust node-operator daemon. Different audience (people running GPU boxes),
 *                 different runtime, and its releases are hash-allowlisted for supply-chain
 *                 reasons, so folding a fast-moving dev tool into that process would slow both.
 *   • `sglcode` — the agentic coding CLI. A product in its own right, like Claude Code.
 *                 Demoting it to `singularity code` would misrepresent what it is.
 *
 * Auth is a per-request Solana wallet signature. The key never leaves the machine.
 */

import { parseArgs, loadKeypair, ok, type Flags } from './auth.js';
import * as processors from './processors.js';
import { VERSION } from './version.js';

const COMMANDS: Record<string, { run: (words: string[], flags: Flags) => Promise<void>; blurb: string }> = {
    processors: { run: processors.run, blurb: 'deploy loops we host and run on demand' },
};

const HELP = `singularity ${VERSION} — build on the Singularity Cloud Network

usage: singularity <command> [subcommand] [options]

commands:
${Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(14)} ${v.blurb}`).join('\n')}
  whoami         print the wallet address your keypair resolves to

  singularity <command>            show that command's subcommands
  --keypair <path>                 defaults to ~/.config/solana/id.json
  --json                           machine-readable output, for scripts and agents

Other Singularity CLIs, deliberately separate:
  sgl            run a compute node and earn        (node operators)
  sglcode        agentic coding on the grid         (npm i -g sglcode)`;

async function main(): Promise<void> {
    const { words, flags } = parseArgs(process.argv.slice(2));
    const cmd = words[0];

    // VERSION FIRST. Checked before the no-command branch because `singularity --version` has no
    // command word, so the help branch claimed it and printed the whole help text — which is exactly
    // what a version check in someone's install script does not want.
    if (flags.version || cmd === 'version') { ok(VERSION); return; }
    if (!cmd || flags.help || cmd === 'help') { ok(HELP); process.exit(cmd && cmd !== 'help' ? 1 : 0); }

    if (cmd === 'whoami') {
        const kp = loadKeypair(flags);
        ok(flags.json ? JSON.stringify({ address: kp.address, chain: 'solana' }) : kp.address);
        return;
    }

    const entry = COMMANDS[cmd];
    if (!entry) {
        console.error(`error: unknown command "${cmd}"\n`);
        ok(HELP);
        process.exit(1);
    }

    await entry.run(words.slice(1), flags);
}

main().catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});

// NO process.exit(0) ON SUCCESS, deliberately.
//
// It looks like the tidy way to guarantee the process ends, and it silently truncates piped stdout:
// writes to a pipe are asynchronous on Node, so `singularity ... --json | jq` can lose the tail of a
// large output. The process must be allowed to drain and exit on its own.
//
// What made exiting tempting is a resumed stdin handle keeping the loop alive after an interactive
// prompt. That is fixed where it happens — prompt() unrefs stdin when it is done — rather than here,
// where the cure costs correctness for every command.

