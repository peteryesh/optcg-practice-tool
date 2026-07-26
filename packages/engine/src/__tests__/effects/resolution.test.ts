import { describe, it, expect, beforeEach } from "vitest";
import { evalContextOf, executeResolution } from "../../game/effects/resolution";
import { createTestState, makeCharacterInstance, makeEffectContext, resetIds } from "../helpers";
import type { GameState } from "../../types/state";
import type { CardInstance } from "../../types/card";
import type { PlayerId } from "../../types/primitives";

// Phase 1.B — executeResolution + evalContextOf.
//
// executeResolution is the adapter from EffectOperation data to an operation
// call. It runs exactly one operation and returns state; it owns none of the
// cursor/consumption semantics, which belong to advanceEffect (stepper.test.ts).
//
// Testable in full isolation: hand-build an EffectContext with makeEffectContext,
// hand a DRAW operation straight in. No staging, no conductor, no reducer.
//
// Deck sizing matters — emit runs a deckout check on BOTH players after every
// signal, so a deck that empties mid-test ends the game instead of drawing.

const FILLER_CARD = "OP01-FILLER";
const SOURCE_CARD = "OP01-SOURCE";

function makeDeck(controller: PlayerId, count: number): CardInstance[] {
    return Array.from({ length: count }, () =>
        makeCharacterInstance({ controller, cardId: FILLER_CARD, currentZone: "DECK" }));
}

function instanceMap(instances: CardInstance[]): Record<string, CardInstance> {
    return Object.fromEntries(instances.map(i => [i.instanceId, i]));
}

// A board where both players hold a stocked deck and p1 controls `source` on the
// field. Nothing here has effectDefs, so emit never reaches the staging loop.
function board(extra: CardInstance[] = []): { state: GameState; source: CardInstance } {
    const source = makeCharacterInstance({ controller: "p1", cardId: SOURCE_CARD, currentZone: "CHARACTERS" });
    const p1Deck = makeDeck("p1", 5);
    const p2Deck = makeDeck("p2", 5);

    const state = createTestState(
        ["p1", "p2"],
        instanceMap([source, ...p1Deck, ...p2Deck, ...extra]),
        {
            p1: {
                characters: [source.instanceId, ...extra.filter(c => c.controller === "p1").map(c => c.instanceId)],
                deck: p1Deck.map(c => c.instanceId),
            },
            p2: {
                characters: extra.filter(c => c.controller === "p2").map(c => c.instanceId),
                deck: p2Deck.map(c => c.instanceId),
            },
        },
    );
    return { state, source };
}

beforeEach(() => {
    resetIds();
});

// The whole function: EffectContext describes whose effect is resolving,
// EvalContext is what the expression evaluators consume. This mapping is the only
// place "who is acting" is decided, which is why it gets its own tests — if it is
// backwards, every filter and amount in the game silently evaluates for the wrong
// player.
describe("evalContextOf", () => {
    it("maps EffectContext.playerId onto EvalContext.self", () => {
        const ctx = makeEffectContext({ playerId: "p2", instanceId: "card-9" });
        expect(evalContextOf(ctx).self).toBe("p2");
    });

    it("maps EffectContext.instanceId onto EvalContext.source", () => {
        const ctx = makeEffectContext({ playerId: "p2", instanceId: "card-9" });
        expect(evalContextOf(ctx).source).toBe("card-9");
    });
});

describe("executeResolution", () => {
    describe("DRAW", () => {
        it("draws the evaluated amount into the effect controller's hand", () => {
            const { state, source } = board();
            const ctx = makeEffectContext({ playerId: "p1", instanceId: source.instanceId });

            const next = executeResolution(state, ctx, {
                type: "DRAW",
                amount: { kind: "LITERAL", value: 2 },
            });

            expect(next.playerZones["p1"].hand).toHaveLength(2);
            expect(next.playerZones["p1"].deck).toHaveLength(3);
        });

        // Guards the DSL contract: the amount must round-trip through
        // evalAmountExpression, never be read off `.value`. A COUNT expression is
        // the cheapest way to prove it — it has no `.value` field at all.
        it("evaluates a COUNT amount against board state rather than reading a literal", () => {
            const ally = makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "CHARACTERS" });
            const { state, source } = board([ally]);
            const ctx = makeEffectContext({ playerId: "p1", instanceId: source.instanceId });

            // two cards sit in CHARACTERS: the source and the ally
            const next = executeResolution(state, ctx, {
                type: "DRAW",
                amount: { kind: "COUNT", zones: ["CHARACTERS"], filter: { kind: "ANY" } },
            });

            expect(next.playerZones["p1"].hand).toHaveLength(2);
        });

        // ctx.playerId, not the controller of whatever card happens to be drawn.
        it("draws for the effect's controller when both players hold decks", () => {
            const { state } = board();
            const ctx = makeEffectContext({ playerId: "p2", instanceId: "card-does-not-matter" });

            const next = executeResolution(state, ctx, {
                type: "DRAW",
                amount: { kind: "LITERAL", value: 1 },
            });

            expect(next.playerZones["p2"].hand).toHaveLength(1);
            expect(next.playerZones["p1"].hand).toHaveLength(0);
        });

        // { kind: "EFFECT", sourceId } — not RULE. emit reads cause.sourceId to
        // attribute wins, so effect-caused movement has to name its source.
        it("emits the draw with an EFFECT cause carrying the source instanceId", () => {
            const { state, source } = board();
            const ctx = makeEffectContext({ playerId: "p1", instanceId: source.instanceId });

            const next = executeResolution(state, ctx, {
                type: "DRAW",
                amount: { kind: "LITERAL", value: 1 },
            });

            const drawSignals = next.gameLog
                .filter(entry => entry.kind === "SIGNAL")
                .map(entry => (entry as { kind: "SIGNAL"; signal: any }).signal)
                .filter(signal => signal.type === "CARDS_SENT_TO_HAND");

            expect(drawSignals).toHaveLength(1);
            expect(drawSignals[0].cause).toEqual({ kind: "EFFECT", sourceId: source.instanceId });
        });

        it("is a no-op when the amount evaluates to 0", () => {
            const { state, source } = board();
            const ctx = makeEffectContext({ playerId: "p1", instanceId: source.instanceId });
            const logLength = state.gameLog.length;

            const next = executeResolution(state, ctx, {
                type: "DRAW",
                amount: { kind: "LITERAL", value: 0 },
            });

            expect(next.playerZones["p1"].hand).toHaveLength(0);
            expect(next.playerZones["p1"].deck).toHaveLength(5);
            // a no-op must not log a signal either
            expect(next.gameLog).toHaveLength(logLength);
        });
    });

    // Defined in the EffectOperation union but unimplemented. They must fail
    // loudly — a silently skipped operation looks like a resolved effect.
    it("throws for LOOK operations", () => {
        const { state, source } = board();
        const ctx = makeEffectContext({ playerId: "p1", instanceId: source.instanceId });

        expect(() => executeResolution(state, ctx, {
            type: "LOOK",
            from: "DECK",
            amount: { kind: "LITERAL", value: 1 },
        })).toThrow();
    });

    it("throws for ADD_TO_HAND operations", () => {
        const { state, source } = board();
        const ctx = makeEffectContext({ playerId: "p1", instanceId: source.instanceId });

        expect(() => executeResolution(state, ctx, { type: "ADD_TO_HAND" })).toThrow();
    });

    it("throws for REORDER operations", () => {
        const { state, source } = board();
        const ctx = makeEffectContext({ playerId: "p1", instanceId: source.instanceId });

        expect(() => executeResolution(state, ctx, {
            type: "REORDER",
            from: "LOOK",
            to: "DECK",
            toPos: "TOP",
        })).toThrow();
    });

    // Boundary check: resolution runs the operation and nothing else. Moving the
    // cursor and clearing currentEffect belong to advanceEffect.
    it("leaves ctx.cursor and state.currentEffect untouched", () => {
        const { state, source } = board();
        const ctx = makeEffectContext({ playerId: "p1", instanceId: source.instanceId, cursor: 0 });
        const withEffectInFlight: GameState = { ...state, currentEffect: ctx };

        const next = executeResolution(withEffectInFlight, ctx, {
            type: "DRAW",
            amount: { kind: "LITERAL", value: 1 },
        });

        expect(ctx.cursor).toBe(0);
        expect(next.currentEffect).toEqual(ctx);
    });
});
