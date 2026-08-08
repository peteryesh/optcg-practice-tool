

/**
 * Need to evaluate the kind on the filter
 * Need a general evaluation function
 * Need a way to determine who is currently filtering
 * Need a way to determine if the card is able to act on self, another card, or either
 * Overall, there needs to be a way to get full context for the filter, and it is not always effect context
 */

import { getZoneArray } from "./game/mechanics";
import { captureSnapshot } from "./game/snapshot";
import { CardFilter, CardDef, CardSnapshot, EvalContext, GameState, PlayerId, BoardCondition, AmountExpression } from "./types";

/**
 * Evaluate a filter against a card AS OF SOME INSTANT.
 *
 * The candidate is a `CardSnapshot` rather than an id, and that is the point: this
 * function cannot tell whether it is reading the live board or a subject captured
 * before a mutation, so activation, targeting and `StatusEffectDef.affects` all share
 * one implementation instead of forking into live and frozen paths.
 *
 * Callers holding an id evaluate "as of now" by calling `captureSnapshot` first.
 *
 * `state` is still needed for the printed fields, which the snapshot deliberately
 * does not copy — see `CardSnapshot`.
 */
export function evalCardFilter(state: GameState, evalContext: EvalContext, candidate: CardSnapshot, filter: CardFilter): boolean {
    switch (filter.kind) {
        case "ANY":
            return true;
        case "THIS":
            return candidate.instanceId === evalContext.source;
        case "CONTROLLER":
            if (filter.controller === "SELF") {
                return candidate.controller === evalContext.self;
            }
            else if (filter.controller === "OPPONENT") {
                return candidate.controller !== evalContext.self;
            }
            else if (filter.controller === "ANY") {
                return true;
            }
            else {
                throw new Error(`Unknown controller filter: ${filter.controller}`);
            }
        case "NAME": {
            const def = defOf(state, candidate);
            return def !== null && (def.name === filter.name || def.aliases.includes(filter.name));
        }
        case "CLASS":
            return candidate.class === filter.cardClass;
        // NOTE: the three stat filters still read the BASE value and ignore their
        // `base` flag — pre-existing behaviour, tracked in EFFECT_PLAN.md's known
        // bugs. The snapshot now carries both forms, so wiring the flag up is a
        // one-line change per branch whenever that is picked up.
        case "COST": {
            if (candidate.baseCost === null) return false;
            return compare(filter.op, candidate.baseCost, filter.value);
        }
        case "POWER": {
            if (candidate.basePower === null) return false;
            return compare(filter.op, candidate.basePower, filter.value);
        }
        case "COUNTER": {
            if (candidate.class !== "CHARACTER") return false;
            if (candidate.baseCounter === null) return false;
            return compare(filter.op, candidate.baseCounter, filter.value);
        }
        case "COLOR": {
            const def = defOf(state, candidate);
            if (def === null) return false;
            return def.colors.includes(filter.color);
        }
        case "TYPE": {
            const def = defOf(state, candidate);
            if (def === null) return false;
            return def.types.includes(filter.cardType);
        }
        case "ATTRIBUTE": {
            const def = defOf(state, candidate);
            if (def === null) return false;
            return def.attributes.includes(filter.attribute);
        }
        case "RESTED":
            if (candidate.class === "DON") {
                if (candidate.zoneAtCapture === null) return false; // DON is attached
                return candidate.zoneAtCapture === "DON_ACTIVE" && !filter.isRested || candidate.zoneAtCapture === "DON_RESTED" && filter.isRested;
            }
            return candidate.isRested === filter.isRested;
        case "FLIPPED":
            if (candidate.flipped === null) return false; // DON and LEADER have no flipped state
            if (candidate.zoneAtCapture !== "LIFE") return false; // flipped only matters in life zone
            return candidate.flipped === filter.isFlipped;
        case "AND":
            return filter.filters.every(f => evalCardFilter(state, evalContext, candidate, f));
        case "OR":
            return filter.filters.some(f => evalCardFilter(state, evalContext, candidate, f));
        case "NOT":
            return !evalCardFilter(state, evalContext, candidate, filter.filter);
    }
}

export function evalAmountExpression(state: GameState, evalContext: EvalContext, expression: AmountExpression): number {
    switch (expression.kind) {
        case "LITERAL":
            return expression.value;
        case "COUNT":
            // return number of cards in zones that match filter
            let count = 0;
            for (const playerId of Object.keys(state.playerZones)) {
                for (const zone of expression.zones) {
                    for (const cardId of getZoneArray(state, playerId as PlayerId, zone)) {
                        // Live evaluation is a snapshot taken now.
                        if (evalCardFilter(state, evalContext, captureSnapshot(state, cardId), expression.filter)) {
                            count++;
                        }
                    }
                }
            }
            return count;
        case "SUBJECT_COUNT":
            // THROWS rather than defaulting to 0. `subjects` absent means there is no
            // activating signal in scope at all, so "how many did it carry" has no
            // answer — a card asking it outside an activation is a definition error.
            // `?? 0` would answer "none were carried", which is a different claim and
            // silently wrong.
            if (!evalContext.subjects) {
                throw new Error(`SUBJECT_COUNT evaluated with no activating signal in scope`);
            }
            return evalContext.subjects.length;
        case "ADD":
            return evalAmountExpression(state, evalContext, expression.left) + evalAmountExpression(state, evalContext, expression.right);
        case "SUBTRACT":
            return evalAmountExpression(state, evalContext, expression.left) - evalAmountExpression(state, evalContext, expression.right);
        case "MULTIPLY":
            return evalAmountExpression(state, evalContext, expression.left) * evalAmountExpression(state, evalContext, expression.right);
        default:
            throw new Error(`Unknown AmountExpression kind: ${(expression as any).kind}`);
    }
}

// Left is candidate, right is filter value
function compare(op: ">=" | "<=" | "==" | ">" | "<", left: number, right: number): boolean {
    switch (op) {
        case ">=":
            return left >= right;
        case "<=":
            return left <= right;
        case "==":
            return left === right;
        case ">":
            return left > right;
        case "<":
            return left < right;
    }
}

// The printed half of a card, which the snapshot does not copy. null for DON, which
// has no definition at all — every def-reading filter treats that as "does not
// match" rather than as an error.
function defOf(state: GameState, candidate: CardSnapshot): CardDef | null {
    if (candidate.cardId === null) return null;
    const def = state.definitions[candidate.cardId];
    if (!def) throw new Error(`Card definition ${candidate.cardId} not found for instance ${candidate.instanceId}`);
    return def;
}