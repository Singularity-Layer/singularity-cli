/**
 * Formatting and coercion. Small, pure, and separated because both are places where the obvious
 * implementation is quietly wrong about money or types.
 */

import { die } from './auth.js';

/**
 * Integer micro-USDC -> a dollar string, WITHOUT ever touching a float.
 *
 * `micro / 1e6` is the obvious version and it is wrong for money. Every amount in this system is an
 * integer count of micro-USDC, and the server's ledger is computed from those integers; dividing by
 * 1e6 in IEEE-754 produces values that disagree with it in the last digits. A publisher reconciling
 * a payout against a chain explorer then finds two numbers that should be identical and are not,
 * with no way to tell which one is lying.
 *
 * Six decimal places always, because that is USDC's actual precision — trimming trailing zeros would
 * make $0.010000 and $0.01 look like different levels of certainty about the same amount.
 */
export function usd(micro: number | string | bigint | null | undefined): string {
    const n = BigInt(micro ?? 0);
    const sign = n < 0n ? '-' : '';
    const a = n < 0n ? -n : n;
    return `${sign}${a / 1000000n}.${String(a % 1000000n).padStart(6, '0')}`;
}

/** A timestamp a human reads, in UTC. Local time would make two people's logs disagree. */
export const when = (iso: string | null | undefined): string =>
    iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : '';

/**
 * Turn typed terminal input into the type the schema declares.
 *
 * DRIVEN BY THE SCHEMA, NEVER GUESSED FROM THE TEXT. Guessing is the tempting version — "it looks
 * like a number, make it a number" — and it silently corrupts the two cases that matter most: a
 * numeric id or an account number becomes a float and loses precision, and a zip code like 02134
 * loses its leading zero. The processor declared what it wants; this obeys that.
 */
export function coerce(raw: string, type: string | undefined): unknown {
    switch (type) {
        case 'number': case 'integer': {
            const n = Number(raw);
            if (!Number.isFinite(n)) return die(`"${raw}" is not a number`);
            // Truncated rather than rounded: an integer field given 2.7 should not silently become
            // 3. Rejecting outright would be defensible too, but this matches what every JSON schema
            // consumer does with a float in an integer slot.
            return type === 'integer' ? Math.trunc(n) : n;
        }
        case 'boolean':
            if (/^(true|yes|y|1)$/i.test(raw)) return true;
            if (/^(false|no|n|0)$/i.test(raw)) return false;
            return die(`"${raw}" is not true or false`);
        case 'array': case 'object':
            try { return JSON.parse(raw); } catch { return die(`"${raw}" is not valid JSON`); }
        default:
            // Includes an ABSENT type, which is the important case: an unspecified field stays a
            // string rather than being guessed into a number.
            return raw;
    }
}
