

/**
 * Need to evaluate the kind on the filter
 * Need a general evaluation function
 * Need a way to determine who is currently filtering
 * Need a way to determine if the card is able to act on self, another card, or either
 * Overall, there needs to be a way to get full context for the filter, and it is not always effect context
 */

import { getCardDef, getCardInstance, getZoneArray } from "./game/mechanics";
import { CardFilter, CardDef, CardInstanceId, EvalContext, GameState, PlayerId, BoardCondition, AmountExpression } from "./types";

export function evalCardFilter(state: GameState, evalContext: EvalContext, candidateId: CardInstanceId, filter: CardFilter): boolean {
    const candidate = getCardInstance(state, candidateId);
    switch (filter.kind) {
        case "ANY":
            return true;
        case "THIS":
            return candidateId === evalContext.source;
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
            const def = defOf(state, candidateId);
            return def !== null && (def.name === filter.name || def.aliases.includes(filter.name));
        }
        case "CLASS":
            return candidate.class === filter.cardClass;
        case "COST": {
            const def = defOf(state, candidateId);
            if (def === null) return false;
            if (candidate.class === "DON" || candidate.class === "LEADER") return false;
            if (def.cost === undefined) throw new Error(`Card ${def.id} has no cost defined`);
            return compare(filter.op, def.cost, filter.value);
        }
        case "POWER": {
            const def = defOf(state, candidateId);
            if (def === null) return false;
            if (candidate.class !== "CHARACTER" && candidate.class !== "LEADER") return false;
            if (def.power === undefined) throw new Error(`Card ${def.id} has no power defined`);
            return compare(filter.op, def.power, filter.value);
        }
        case "COUNTER": {
            const def = defOf(state, candidateId);
            if (def === null) return false;
            if (candidate.class !== "CHARACTER") return false;
            if (def.counter === undefined || def.counter === null) return false;
            return compare(filter.op, def.counter, filter.value);
        }
        case "COLOR": {
            const def = defOf(state, candidateId);
            if (def === null) return false;
            return def.colors.includes(filter.color);
        }
        case "TYPE": {
            const def = defOf(state, candidateId);
            if (def === null) return false;
            return def.types.includes(filter.cardType);
        }
        case "ATTRIBUTE": {
            const def = defOf(state, candidateId);
            if (def === null) return false;
            return def.attributes.includes(filter.attribute);
        }
        case "RESTED":
            if (candidate.class === "DON") {
                if (candidate.currentZone === null) return false; // DON is attached
                return candidate.currentZone === "DON_ACTIVE" && !filter.isRested || candidate.currentZone === "DON_RESTED" && filter.isRested;
            }
            return candidate.isRested === filter.isRested;
        case "FLIPPED":
            if (candidate.class === "DON" || candidate.class === "LEADER") return false;
            if (!("flipped" in candidate)) throw new Error(`Card has no flipped property`);
            if (candidate.currentZone !== "LIFE") return false; // flipped only matters in life zone
            return candidate.flipped === filter.isFlipped;
        case "AND":
            return filter.filters.every(f => evalCardFilter(state, evalContext, candidateId, f));
        case "OR":
            return filter.filters.some(f => evalCardFilter(state, evalContext, candidateId, f));
        case "NOT":
            return !evalCardFilter(state, evalContext, candidateId, filter.filter);
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
                        if (evalCardFilter(state, evalContext, cardId, expression.filter)) {
                            count++;
                        }
                    }
                }
            }
            return count;
        case "SUBJECT_COUNT":
            return evalAmountExpression(state, evalContext, expression.value);
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

function defOf(state: GameState, instanceId: CardInstanceId): CardDef | null {
    const card = getCardInstance(state, instanceId);
    if (card.class === "DON") return null;
    return getCardDef(state, instanceId);
}