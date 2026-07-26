import { describe, it, expect, beforeEach } from "vitest";
import { reducer } from "../../reducer";
import { effectDefsFor } from "../../cards";
import { makeGameBoard, resetIds } from "../helpers";
import type { GameState } from "../../types/state";
import type { CardDef, CardInstance } from "../../types/card";
import type { CardId } from "../../types/primitives";

// Authored cards, played through the REAL registry.
//
// Every other effect test builds its EffectDef inline with makeEffectDef, which
// proves the engine works but says nothing about whether an authored card is
// correct. These import from src/cards and use the real printed values, so they
// fail if an entry is malformed, keyed to the wrong id, or drifts when EffectDef
// changes shape.
//
// Card facts below are transcribed from the card database. Values belonging to a
// closed union — class, colors, attributes — are uppercase constants per
// primitives.ts; printed text (name, types) is kept exactly as it appears on the
// card. The remote data sends title case for colors and attributes ("Blue",
// "Slash"), so upcasing those is the translation layer's job.

const FILLER_CARD = "OP01-FILLER";

// OP04-045 King — cost 7, [On Play] Draw 1 card.
const king: CardDef = {
    id: "OP04-045",
    name: "King",
    class: "CHARACTER",
    cost: 7,
    power: 8000,
    counter: 1000,
    colors: ["BLUE"],
    types: ["Animal Kingdom Pirates"],
    attributes: ["SLASH"],
    aliases: [],
    restrictions: [],
    effectDefs: effectDefsFor("OP04-045"),
};

// OP13-041 Izo — cost 6, [On Play] Draw 2 cards.
const izo: CardDef = {
    id: "OP13-041",
    name: "Izo",
    class: "CHARACTER",
    cost: 6,
    power: 6000,
    counter: 1000,
    colors: ["BLUE"],
    types: ["Land of Wano", "Whitebeard Pirates"],
    attributes: ["RANGED"],
    aliases: [],
    restrictions: [],
    effectDefs: effectDefsFor("OP13-041"),
};

// A full mid-game board holding the card in p1's hand. 10 active DON comes from
// the fixture default, so cost never has to be reasoned about here.
function boardHolding(def: CardDef): { state: GameState; played: CardInstance } {
    const { state, hands } = makeGameBoard({
        definitions: { [def.id]: def },
        hands: { p1: [def.id] },
    });
    return { state, played: hands["p1"][0] };
}

beforeEach(() => {
    resetIds();
});

describe("registry", () => {
    it("returns undefined for an unauthored card", () => {
        expect(effectDefsFor("OP01-001" as CardId)).toBeUndefined();
    });
});

describe("OP04-045 King — [On Play] Draw 1 card.", () => {
    it("draws exactly 1 card when played", () => {
        const { state, played } = boardHolding(king);
        const deckBefore = state.playerZones["p1"].deck.length;

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.playerZones["p1"].deck).toHaveLength(deckBefore - 1);
        // net zero: King left the hand, the drawn card entered it
        expect(next.playerZones["p1"].hand).toHaveLength(1);
    });

    it("settles with the character in play and no effect in flight", () => {
        const { state, played } = boardHolding(king);

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.playerZones["p1"].characters).toContain(played.instanceId);
        expect(next.currentEffect).toBeNull();
        expect(next.decisionPoint).toEqual({ type: "MAIN_ACTION", player: "p1" });
    });
});

describe("OP13-041 Izo — [On Play] Draw 2 cards.", () => {
    // Same authored shape as King differing only in the LITERAL amount, which is
    // what proves the draw count comes from the definition rather than a default.
    it("draws exactly 2 cards when played", () => {
        const { state, played } = boardHolding(izo);
        const deckBefore = state.playerZones["p1"].deck.length;

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.playerZones["p1"].deck).toHaveLength(deckBefore - 2);
        expect(next.playerZones["p1"].hand).toHaveLength(2);
    });
});
