import type { CardInstanceId, CardSnapshot, GameState } from "../types";
import { getCardInstance, getCardDef } from "./mechanics";
import { calculateCounter, calculateCost, calculatePower } from "./calculations";

/**
 * Read a card as it is right now, as a detached value.
 *
 * Pure — no mutation, no emit. Called at two very different moments and it does not
 * know the difference: live evaluation captures at the moment of the question, while
 * a signal captures immediately BEFORE the mutation its cause describes, so that the
 * subject it carries survives what that mutation destroys.
 *
 * That is why derived stats are computed here rather than left to the reader. A
 * character trashed from the field has its DON detached on the way out; by the time
 * anything reads the signal, `calculatePower` would answer with the DON already gone.
 * Capturing first is the only way the buffed power is still reportable.
 *
 * Lives outside `mechanics/` on purpose: `calculations.ts` imports from `mechanics`,
 * so a snapshot helper placed there would close an import cycle.
 */
export function captureSnapshot(state: GameState, instanceId: CardInstanceId): CardSnapshot {
    const card = getCardInstance(state, instanceId);

    // DON first — it carries no `cardId` and `getCardDef` throws for it, so every
    // definition-derived field is inapplicable rather than merely missing. Callers
    // hit this constantly: DON_RESTED fires whenever a cost is paid.
    if (card.class === "DON") {
        return {
            instanceId,
            cardId: null,
            class: "DON",
            controller: card.controller,
            // null while attached to a card, which is a real state, not an error.
            zoneAtCapture: card.currentZone,
            isRested: card.isRested,
            flipped: null,
            attachedDon: [],
            power: null,
            basePower: null,
            cost: null,
            baseCost: null,
            counter: null,
            baseCounter: null,
        };
    }

    const def = getCardDef(state, instanceId);

    // Which stats EXIST is a property of the class, and the three calculate* helpers
    // throw rather than return null for a class that has none.
    //
    // The def check is the second half of the same guard, and it is deliberate: the
    // remote card data is known to be lossy (leaders arrive with `cost: null` against
    // a `cost?: number` declaration — see EFFECT_PLAN.md known bugs). This function
    // now runs over every card in every zone on each COUNT, so letting one malformed
    // definition throw would make the game unplayable rather than making one filter
    // return false.
    const hasPower = (card.class === "CHARACTER" || card.class === "LEADER") && def.power !== undefined && def.power !== null;
    const hasCost = (card.class === "CHARACTER" || card.class === "STAGE" || card.class === "EVENT") && def.cost !== undefined && def.cost !== null;
    const hasCounter = card.class === "CHARACTER" && def.counter !== undefined && def.counter !== null;

    return {
        instanceId,
        cardId: card.cardId,
        class: card.class,
        controller: card.controller,
        zoneAtCapture: card.currentZone,
        isRested: card.isRested,
        flipped: "flipped" in card ? card.flipped : null,
        // Copied, not aliased — a snapshot that shares an array with live state is
        // not a snapshot.
        attachedDon: "attachedDon" in card ? [...card.attachedDon] : [],
        power: hasPower ? calculatePower(state, instanceId) : null,
        basePower: hasPower ? Number(def.power) : null,
        cost: hasCost ? calculateCost(state, instanceId) : null,
        baseCost: hasCost ? Number(def.cost) : null,
        counter: hasCounter ? calculateCounter(state, instanceId) : null,
        baseCounter: hasCounter ? Number(def.counter) : null,
    };
}
