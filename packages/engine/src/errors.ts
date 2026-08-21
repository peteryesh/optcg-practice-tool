export class InvalidActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidActionError';
    }
}

/**
 * Exhaustiveness check for a discriminated union.
 *
 * Placed in a `default:` arm, this fails to COMPILE the moment the union gains a member
 * the switch does not handle — the argument is only assignable to `never` when every
 * other case has been covered.
 *
 * Worth the two lines because the failure it prevents is silent: a switch with no
 * default just falls through, so a missing arm looks like "the action applied and
 * changed nothing" rather than like an error. `SUBMIT_REORDER` sat in exactly that
 * state — generated, validated, and then quietly discarded.
 */
export function assertNever(value: never): never {
    throw new Error(`Unhandled union member: ${JSON.stringify(value)}`);
}
