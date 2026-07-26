import type { EffectContext, EffectOperation, EvalContext, GameState } from "../../types";
import { evalAmountExpression } from "../../evaluator";
import { cardsDraw } from "../operations";

// Translates "whose effect is resolving" into the two things the expression
// evaluators need: `self` answers "whose side" (CONTROLLER filters, and who acts
// for player-scoped operations), `source` answers "which card" (THIS).
//
// The staging gate builds the same pair by hand for each listener; this is the
// version derived from an effect that has already been promoted.
export function evalContextOf(effectContext: EffectContext): EvalContext {
    return {
        self: effectContext.playerId,
        source: effectContext.instanceId,
    };
}

// The adapter from EffectOperation data on a card definition to an operation call.
// Runs exactly one operation and returns state.
//
// It receives the operation, never the step, so it cannot reach the cursor, `bind`
// or `label` — advancing through the step list belongs to the stepper.
//
// Note that no operation takes a player argument: who acts is derived from the
// expressions via `self`, so an effect that makes the opponent act says so through
// its filters rather than through a parameter here.
export function executeResolution(state: GameState, effectContext: EffectContext, operation: EffectOperation): GameState {
    const evalContext = evalContextOf(effectContext);
    switch (operation.type) {
        case "DRAW": {
            const amount = evalAmountExpression(state, evalContext, operation.amount);
            // EFFECT, not RULE — emit reads cause.sourceId to attribute wins, so
            // movement caused by an effect has to name the card that caused it.
            return cardsDraw(state, evalContext.self, amount, { kind: "EFFECT", sourceId: effectContext.instanceId });
        }
        // Defined in the EffectOperation union but not built yet. These throw
        // rather than fall through, because an operation that silently does
        // nothing is indistinguishable from an effect that resolved correctly.
        case "LOOK":
        case "ADD_TO_HAND":
        case "REORDER":
            throw new Error(`Effect operation ${operation.type} is not yet implemented`);
        default:
            throw new Error(`Unknown effect operation: ${(operation as any).type}`);
    }
}
