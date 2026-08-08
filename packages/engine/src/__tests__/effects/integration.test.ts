import { describe, it, expect, beforeEach } from "vitest";
import { reducer } from "../../reducer";
import {
    createTestState,
    makeCharacterInstance,
    makeDrawStep,
    makeEffectDef,
    resetIds,
    withEffect,
} from "../helpers";
import type { GameState } from "../../types/state";
import type { CardDef, CardInstance } from "../../types/card";
import type { CardInstanceId, PlayerId } from "../../types/primitives";

// Phase 1.E — the vertical slice, and the definition of done for the skeleton.
//
// One card: a character with [On Play] Draw 1 card. One reducer call. Everything
// between PLAY_CARD and the next decision point is the engine's own business:
//
//   PLAY_CARD -> moveCard -> emit(CHARACTER_PLAYED) -> staging gate -> EffectContext
//   -> commitEffectFrame -> effectQueue -> promoteEffect -> currentEffect
//   -> advanceEffect -> executeResolution(DRAW) -> cardsDraw -> cursor off the end
//   -> currentEffect null -> MAIN_ACTION
//
// The units are covered in staging/resolution/stepper.test.ts. What is covered
// ONLY here is the middle of the chain — commitEffectFrame, promoteEffect, and the
// queue/promotion block in conductor.ts — which was already implemented and so got
// no red-first unit test of its own.
//
// Note the hand is net ZERO across the play: the played card leaves it and the
// drawn card enters it. The draw is asserted by naming the card that was on top of
// the deck, not by counting the hand.

const EFFECT_CARD = "OP01-ONPLAY-DRAW";
const PLAIN_CARD = "OP01-VANILLA";
const FILLER_CARD = "OP01-FILLER";
const EFFECT_ID = "e1";

// A 0-cost character with no effects. Needs an explicit definition because
// createTestState's auto-generated defs carry no `cost`, and validate() runs
// calculateCost on every PLAY_CARD.
const plainCardDef: CardDef = {
    id: PLAIN_CARD,
    name: PLAIN_CARD,
    class: "CHARACTER",
    cost: 0,
    colors: [],
    types: [],
    attributes: [],
    aliases: [],
    restrictions: [],
};

function makeDeck(controller: PlayerId, count: number): CardInstance[] {
    return Array.from({ length: count }, () =>
        makeCharacterInstance({ controller, cardId: FILLER_CARD, currentZone: "DECK" }));
}

function instanceMap(instances: CardInstance[]): Record<string, CardInstance> {
    return Object.fromEntries(instances.map(i => [i.instanceId, i]));
}

// A MAIN-phase board waiting on MAIN_ACTION, with `player` holding one playable
// card in hand and both players holding stocked decks.
function boardReadyToPlay(opts: {
    player?: PlayerId;
    cardId?: string;
    deckSize?: number;
} = {}): { state: GameState; played: CardInstance; deckTop: CardInstanceId } {
    const player = opts.player ?? "p1";
    const cardId = opts.cardId ?? EFFECT_CARD;
    const deckSize = opts.deckSize ?? 5;

    const played = makeCharacterInstance({ controller: player, cardId, currentZone: "HAND" });
    const p1Deck = makeDeck("p1", deckSize);
    const p2Deck = makeDeck("p2", deckSize);

    const base = createTestState(
        ["p1", "p2"],
        instanceMap([played, ...p1Deck, ...p2Deck]),
        {
            p1: {
                deck: p1Deck.map(c => c.instanceId),
                hand: player === "p1" ? [played.instanceId] : [],
            },
            p2: {
                deck: p2Deck.map(c => c.instanceId),
                hand: player === "p2" ? [played.instanceId] : [],
            },
        },
        {
            ...withEffect(EFFECT_CARD, { [EFFECT_ID]: makeEffectDef({ steps: [makeDrawStep(1)] }) }),
            [PLAIN_CARD]: plainCardDef,
        },
    );

    const state: GameState = {
        ...base,
        turnPlayerId: player,
        decisionPoint: { type: "MAIN_ACTION", player },
    };

    const deckTop = (player === "p1" ? p1Deck : p2Deck)[0].instanceId;
    return { state, played, deckTop };
}

function signalsOf(state: GameState): any[] {
    return state.gameLog
        .filter(entry => entry.kind === "SIGNAL")
        .map(entry => (entry as { kind: "SIGNAL"; signal: any }).signal);
}

beforeEach(() => {
    resetIds();
});

describe("On-Play draw 1", () => {
    // The pump: the caller applies one action and the engine settles. A second
    // reducer call must not be required to get the card drawn.
    it("resolves the effect within the single PLAY_CARD reducer call", () => {
        const { state, played, deckTop } = boardReadyToPlay();

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.playerZones["p1"].hand).toContain(deckTop);
    });

    it("moves exactly one card off the top of the deck", () => {
        const { state, played, deckTop } = boardReadyToPlay();

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.playerZones["p1"].deck).toHaveLength(4);
        expect(next.playerZones["p1"].deck).not.toContain(deckTop);
    });

    it("puts the played character in the CHARACTERS zone", () => {
        const { state, played } = boardReadyToPlay();

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.playerZones["p1"].characters).toContain(played.instanceId);
        expect(next.playerZones["p1"].hand).not.toContain(played.instanceId);
    });

    it("returns the decision point to MAIN_ACTION for the turn player", () => {
        const { state, played } = boardReadyToPlay();

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.decisionPoint).toEqual({ type: "MAIN_ACTION", player: "p1" });
    });

    // At rest nothing may be left mid-flight. The queue block pops its frame once
    // the last ref is promoted; a leaked empty frame would stall the next signal.
    it("leaves currentEffect null and the queue empty", () => {
        const { state, played } = boardReadyToPlay();

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.currentEffect).toBeNull();
        expect(next.effectQueue).toEqual([]);
        expect(next.stagingFrame).toEqual({ p1: [], p2: [] });
    });

    // Causal order in the log: the play caused the effect, so its signal precedes
    // the draw's. This is also what makes the log readable as an explanation.
    it("logs CHARACTER_PLAYED before the draw's CARDS_SENT_TO_HAND", () => {
        const { state, played } = boardReadyToPlay();

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });
        const types = signalsOf(next).map(signal => signal.type);

        expect(types.indexOf("CHARACTER_PLAYED")).toBeGreaterThanOrEqual(0);
        expect(types.indexOf("CARDS_SENT_TO_HAND")).toBeGreaterThan(types.indexOf("CHARACTER_PLAYED"));
    });

    // The draw is attributed to the effect, not to a rule.
    it("logs the draw with an EFFECT cause naming the played card", () => {
        const { state, played } = boardReadyToPlay();

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });
        const draws = signalsOf(next).filter(signal => signal.type === "CARDS_SENT_TO_HAND");

        expect(draws).toHaveLength(1);
        expect(draws[0].cause).toEqual({ kind: "EFFECT", sourceId: played.instanceId });
    });
});

describe("On-Play draw 1 — negative cases", () => {
    // Integration-level restatement of the staging gate: proves it survives the
    // whole pump, not just a direct emit() call. p2's own copy still fires for p2.
    it("does not draw for the opponent when they play their own copy", () => {
        const { state, played } = boardReadyToPlay({ player: "p2" });

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p2", instanceId: played.instanceId });

        expect(next.playerZones["p1"].deck).toHaveLength(5);
        expect(next.playerZones["p1"].hand).toHaveLength(0);
        expect(next.playerZones["p2"].deck).toHaveLength(4);
    });

    // A plain character must not disturb the effect machinery at all.
    it("plays a character with no effects without touching currentEffect", () => {
        const { state, played } = boardReadyToPlay({ cardId: PLAIN_CARD });

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.currentEffect).toBeNull();
        expect(next.effectQueue).toEqual([]);
        expect(next.playerZones["p1"].deck).toHaveLength(5);
        expect(next.playerZones["p1"].characters).toContain(played.instanceId);
    });

    // DOCUMENTS CURRENT BEHAVIOUR, and it is worth a second look. emit runs a
    // deckout check after EVERY signal and ends the game the moment a deck is
    // empty — so drawing the last card loses immediately, rather than on a later
    // failed draw. OPTCG's actual rule is that you lose when you must draw and
    // cannot, which is not the same thing. Pinned here so the difference is
    // visible; changing it is outside the effect slice.
    it("ends the game by DECKOUT when the effect's draw empties the deck", () => {
        const { state, played } = boardReadyToPlay({ deckSize: 1 });

        const next = reducer(state, { type: "PLAY_CARD", playerId: "p1", instanceId: played.instanceId });

        expect(next.winner).toBe("p2");
        expect(next.endReason).toBe("DECKOUT");
    });
});
