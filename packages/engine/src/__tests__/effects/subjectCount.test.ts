import { describe, it, expect, beforeEach } from "vitest";
import { advance } from "../../conductor";
import { sendHandToTrash } from "../../game/operations/zones/trash";
import {
    createTestState,
    makeCharacterInstance,
    placeCard,
    resetIds,
    withEffect,
} from "../helpers";
import type { GameState } from "../../types/state";
import type { CardDef, CardInstance } from "../../types/card";

// The driving card for the whole subject channel, end to end.
//
//   "When a {Navy} card trashes cards from your hand by an effect,
//    draw 1 card for each card trashed."
//
// It is here rather than in src/cards/ because it is hypothetical — no real card id
// prints this text. What makes it worth a test of its own is that it is the first
// thing to exercise every piece of the channel at once, where the unit tests each
// cover one:
//
//   capture pre-mutation  -> a MULTI-subject signal (CARDS_SENT_TO_TRASH batches)
//   -> tier 1 narrowing on causeKind + source + fromZone all together
//   -> tier 2 ANY_OF filtering  -> subjects written onto the EffectContext
//   -> evalContextOf threading them -> SUBJECT_COUNT reading the length
//   -> DRAW resolving with a computed amount
//
// Anything that breaks the chain shows up here as the wrong number of cards drawn,
// which is why the assertions are on the hand and not on any intermediate structure.

const LISTENER_CARD = "OP01-NAVY-DRAWER";
const NAVY_CARD = "OP01-NAVY-SOURCE";
const FILLER_CARD = "OP01-FILLER";
const EFFECT_ID = "e1";

beforeEach(() => {
    resetIds();
});

// The listener: on the field, watching for its own side's hand being trashed by a
// Navy card's effect. Note `subject` filters on CONTROLLER SELF — the signal reports
// whose cards moved, and an effect only cares about its own controller's hand.
function listenerDef(): Record<string, CardDef> {
    return withEffect(
        LISTENER_CARD,
        {
            [EFFECT_ID]: {
                activation: [{
                    signal: "CARDS_SENT_TO_TRASH",
                    subject: { kind: "ANY_OF", filter: { kind: "CONTROLLER", controller: "SELF" } },
                    causeKind: ["EFFECT"],
                    source: { kind: "TYPE", cardType: "Navy" },
                    fromZone: ["HAND"],
                }],
                activeZone: "CHARACTERS",
                oncePerTurn: false,
                steps: [
                    { kind: "RESOLUTION", operation: { type: "DRAW", amount: { kind: "SUBJECT_COUNT" } } },
                ],
            },
        },
        { types: ["Navy"] },
    );
}

// A board with the listener and a Navy card on the field, `handSize` cards in hand,
// and decks deep enough that drawing does not deck anyone out (emit ends the game the
// moment a deck is empty).
function board(handSize: number, sourceTypes: string[] = ["Navy"]) {
    const hand: CardInstance[] = Array.from({ length: handSize }, () =>
        makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "HAND" }));
    const p1Deck = Array.from({ length: 6 }, () =>
        makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "DECK" }));
    const p2Deck = Array.from({ length: 6 }, () =>
        makeCharacterInstance({ controller: "p2", cardId: FILLER_CARD, currentZone: "DECK" }));

    const instances: Record<string, CardInstance> = {};
    for (const c of [...hand, ...p1Deck, ...p2Deck]) instances[c.instanceId] = c;

    let state: GameState = createTestState(
        ["p1", "p2"],
        instances,
        {
            p1: { hand: hand.map(c => c.instanceId), deck: p1Deck.map(c => c.instanceId) },
            p2: { deck: p2Deck.map(c => c.instanceId) },
        },
        {
            ...listenerDef(),
            [NAVY_CARD]: {
                id: NAVY_CARD, name: NAVY_CARD, class: "CHARACTER", cost: 1, power: 1000,
                colors: [], types: sourceTypes, attributes: [], aliases: [], restrictions: [],
            },
        },
    );

    const listener = makeCharacterInstance({ controller: "p1", cardId: LISTENER_CARD, currentZone: "CHARACTERS" });
    const navy = makeCharacterInstance({ controller: "p1", cardId: NAVY_CARD, currentZone: "CHARACTERS" });
    state = placeCard(state, listener, "CHARACTERS", "p1");
    state = placeCard(state, navy, "CHARACTERS", "p1");

    return { state, listener, navy, hand };
}

describe("SUBJECT_COUNT end to end", () => {
    it("draws one card for each card trashed", () => {
        const { state, navy, hand } = board(3);

        // The Navy card's effect trashes two cards from hand. Hand goes 3 -> 1.
        const trashed = hand.slice(0, 2).map(c => c.instanceId);
        const after = advance(sendHandToTrash(state, "p1", trashed, { kind: "EFFECT", sourceId: navy.instanceId }));

        // 1 left after trashing, plus 2 drawn.
        expect(after.playerZones["p1"].hand).toHaveLength(3);
        expect(after.playerZones["p1"].trash).toHaveLength(2);
    });

    // The count comes from the SUBJECTS, not from any board query — the trash already
    // holds other cards by the time the effect resolves, so a COUNT over the trash
    // zone would give a different (wrong) answer.
    it("counts the subjects, not the resulting trash", () => {
        const { state, navy, hand } = board(4);

        // Seed the trash first, so trash size and subject count cannot coincide.
        const seeded = sendHandToTrash(state, "p1", [hand[0].instanceId], { kind: "RULE" });
        const trashed = hand.slice(1, 4).map(c => c.instanceId);
        const after = advance(sendHandToTrash(seeded, "p1", trashed, { kind: "EFFECT", sourceId: navy.instanceId }));

        // 4 cards in the trash, but only 3 were the effect's subjects.
        expect(after.playerZones["p1"].trash).toHaveLength(4);
        expect(after.playerZones["p1"].hand).toHaveLength(3);
    });

    // Tier 1 rejects before tier 2 ever runs. Each of these leaves the subject filter
    // perfectly satisfiable — only the signal-level predicate differs.
    it("does not activate when the cause is not an effect", () => {
        const { state, hand } = board(3);

        const trashed = hand.slice(0, 2).map(c => c.instanceId);
        const after = advance(sendHandToTrash(state, "p1", trashed, { kind: "RULE" }));

        expect(after.playerZones["p1"].hand).toHaveLength(1);
    });

    it("does not activate when the causing card is not {Navy}", () => {
        const { state, navy, hand } = board(3, ["Straw Hat Crew"]);

        const trashed = hand.slice(0, 2).map(c => c.instanceId);
        const after = advance(sendHandToTrash(state, "p1", trashed, { kind: "EFFECT", sourceId: navy.instanceId }));

        expect(after.playerZones["p1"].hand).toHaveLength(1);
    });

    // The subject filter resolves CONTROLLER against the LISTENER, not the signal, so
    // an identical copy on the other side of the board evaluates the same definition
    // and correctly declines. Tier 1 passes for both — the Navy source is a type test
    // with no controller component — so only tier 2 separates them.
    it("does not activate a copy owned by the other player", () => {
        const { state, navy, hand } = board(3);
        const theirCopy = makeCharacterInstance({ controller: "p2", cardId: LISTENER_CARD, currentZone: "CHARACTERS" });
        const withTheirs = placeCard(state, theirCopy, "CHARACTERS", "p2");

        const trashed = hand.slice(0, 2).map(c => c.instanceId);
        const after = advance(sendHandToTrash(
            withTheirs, "p1", trashed, { kind: "EFFECT", sourceId: navy.instanceId },
        ));

        // p1's listener drew its 2; p2's identical copy drew nothing.
        expect(after.playerZones["p1"].hand).toHaveLength(3);
        expect(after.playerZones["p2"].hand).toHaveLength(0);
    });
});
