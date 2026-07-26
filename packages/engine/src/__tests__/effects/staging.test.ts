import { describe, it, expect } from "vitest";
import { emit, signalSubjects } from "../../game/emitter";
import { createTestState, makeCharacterInstance, makeEffectDef, makeDrawStep, placeCard, withEffect } from "../helpers";
import type { GameState } from "../../types/state";
import type { GameSignal } from "../../types/signal";
import type { CardInstance } from "../../types/card";
import type { EffectDef, EffectId, SignalActivation } from "../../types/effect";
import type { CardInstanceId, Color, PlayerId, Zone } from "../../types/primitives";

// Phase 1.A + 1.C — signalSubjects and the emitter's staging gates.
//
// Written against emit() directly: build a board, emit a signal, assert what
// landed in stagingFrame. Two gates decide staging — the activeZone gate and the
// (signal, subject) match over EffectDef.activation.
//
// WRITE THE POSITIVE CASE FIRST. Today emitter.ts calls .includes(signal.type) on
// an array of SignalActivation objects, which always returns false at runtime, so
// every negative case below passes before a line is implemented. Only the first
// test produces a real red.

// signalSubjects answers "which card(s) is this signal about", so the staging gate
// has a candidate to test EffectDef.activation[].subject against. Pure function:
// signal in, ids out, no state.
//
// Three categories, and the distinction is deliberate:
//   1. Mapped        — one unambiguous subject role -> [id]
//   2. Subject-less  — the signal is about no card at all -> []
//   3. Undecided     — the signal names cards in MORE THAN ONE role (attacker vs
//                      defender), or names many at once, and the semantics are not
//                      settled yet -> throw.
//
// Throwing is safe because emit only calls this after confirming some effect
// listens for the signal type, so an unhandled case means a card genuinely
// declared interest in semantics that do not exist yet — an authoring bug worth
// surfacing loudly, not a silent no-fire.

describe("signalSubjects", () => {
    it("returns the played instance for CHARACTER_PLAYED", () => {
        expect(signalSubjects({
            type: "CHARACTER_PLAYED",
            instanceId: "card-1",
            controller: "p1",
            fromZone: "HAND",
            toZone: "CHARACTERS",
            cause: { kind: "PLAYER" },
        })).toEqual(["card-1"]);
    });

    // Same shape, same single role — free to support alongside CHARACTER_PLAYED.
    it("returns the played instance for STAGE_PLAYED", () => {
        expect(signalSubjects({
            type: "STAGE_PLAYED",
            instanceId: "card-2",
            controller: "p1",
            fromZone: "HAND",
            toZone: "STAGE",
            cause: { kind: "PLAYER" },
        })).toEqual(["card-2"]);
    });

    it("returns the played instance for EVENT_PLAYED", () => {
        expect(signalSubjects({
            type: "EVENT_PLAYED",
            instanceId: "card-3",
            controller: "p1",
            fromZone: "HAND",
            toZone: "TRASH",
            cause: { kind: "PLAYER" },
        })).toEqual(["card-3"]);
    });

    // Not "unmapped" — genuinely about no card. Returning [] is the true answer.
    // NOTE: staging currently has no way to fire an effect off a subject-less
    // signal (`subjects.some(...)` over [] is always false), so phase-keyed effects
    // cannot activate yet. That gap belongs to staging, not here.
    it("returns an empty list for signals with no card subject (PHASE_CHANGED)", () => {
        expect(signalSubjects({
            type: "PHASE_CHANGED",
            prevPhase: "DRAW",
            nextPhase: "MAIN",
            cause: { kind: "RULE" },
        })).toEqual([]);
    });

    // Two cards in two different roles. "When this character attacks" and "when
    // this character is attacked" are different effects off one signal, and a flat
    // list cannot tell them apart — it would stage both. Deferred, so: loud.
    it("throws for a signal whose subject role is ambiguous (ATTACK_DECLARED)", () => {
        expect(() => signalSubjects({
            type: "ATTACK_DECLARED",
            attackerId: "card-1",
            defenderId: "card-2",
            controller: "p1",
        })).toThrow();
    });

    // Multi-card signals are held back with the fan-out-vs-once semantic and LKI
    // snapshots, which are deferred together.
    it("throws for a multi-card signal (CARDS_SENT_TO_TRASH)", () => {
        expect(() => signalSubjects({
            type: "CARDS_SENT_TO_TRASH",
            instanceIds: ["card-1", "card-2"],
            fromZone: "CHARACTERS",
            controller: "p1",
            cause: { kind: "RULE" },
        })).toThrow();
    });
});

const EFFECT_CARD = "OP01-EFFECT";
const FILLER_CARD = "OP01-FILLER";
const EFFECT_ID = "e1";

// emit runs a deckout check over BOTH players on every signal, so a board with an
// empty deck ends the game before staging is ever reached. Every fixture here
// stocks both decks with a filler that has no effectDefs (and so is never a
// listener). Definitions come from createTestState, which auto-generates one for
// any cardId it has not been given.
function boardWithListener(
    effectDefs: Record<EffectId, EffectDef>,
    listenerOpts: { controller?: PlayerId; currentZone?: Zone } = {},
): { state: GameState; listener: CardInstance } {
    const p1Deck = makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "DECK" });
    const p2Deck = makeCharacterInstance({ controller: "p2", cardId: FILLER_CARD, currentZone: "DECK" });

    let state = createTestState(
        ["p1", "p2"],
        { [p1Deck.instanceId]: p1Deck, [p2Deck.instanceId]: p2Deck },
        { p1: { deck: [p1Deck.instanceId] }, p2: { deck: [p2Deck.instanceId] } },
        withEffect(EFFECT_CARD, effectDefs),
    );

    const controller = listenerOpts.controller ?? "p1";
    const zone = listenerOpts.currentZone ?? "CHARACTERS";
    const listener = makeCharacterInstance({ controller, cardId: EFFECT_CARD, currentZone: zone });
    state = placeCard(state, listener, zone, controller);
    return { state, listener };
}

// Same board, plus a card that can act as the cause of an effect-driven play.
const CAUSE_CARD = "OP01-CAUSE";

function boardWithListenerAndCause(
    effectDefs: Record<EffectId, EffectDef>,
    causeColors: Color[],
): { state: GameState; listener: CardInstance; causeCard: CardInstance } {
    const { state: base, listener } = boardWithListener(effectDefs);
    const causeCard = makeCharacterInstance({ controller: "p2", cardId: CAUSE_CARD, currentZone: "CHARACTERS" });

    const withDef: GameState = {
        ...base,
        definitions: {
            ...base.definitions,
            [CAUSE_CARD]: {
                id: CAUSE_CARD, name: CAUSE_CARD, class: "CHARACTER", cost: 1, power: 1000,
                colors: causeColors, types: [], attributes: [], aliases: [], restrictions: [],
            },
        },
    };

    return { state: placeCard(withDef, causeCard, "CHARACTERS", "p2"), listener, causeCard };
}

function playedSignal(instanceId: CardInstanceId, controller: PlayerId): GameSignal {
    return {
        type: "CHARACTER_PLAYED",
        instanceId,
        controller,
        fromZone: "HAND",
        toZone: "CHARACTERS",
        cause: { kind: "PLAYER" },
    };
}

describe("staging gates", () => {
    it("stages an On-Play effect when its own card is played", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({ steps: [makeDrawStep(1)] }),
        });

        const next = emit(state, playedSignal(listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toEqual([
            { cardId: EFFECT_CARD, effectId: EFFECT_ID, instanceId: listener.instanceId },
        ]);
    });

    // subject: THIS must not match a different instance of the same cardId. Both
    // players hold a copy; only the one that was actually played may stage.
    it("does not stage when the opponent plays a copy of the same card", () => {
        const { state: base, listener: mine } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({ steps: [makeDrawStep(1)] }),
        });
        const theirs = makeCharacterInstance({ controller: "p2", cardId: EFFECT_CARD, currentZone: "CHARACTERS" });
        const state = placeCard(base, theirs, "CHARACTERS", "p2");

        const next = emit(state, playedSignal(theirs.instanceId, "p2"));

        // theirs staged for its own controller; mine did not stage at all
        expect(next.stagingFrame["p1"]).toEqual([]);
        expect(next.stagingFrame["p2"]).toHaveLength(1);
        expect(next.stagingFrame["p2"][0].instanceId).toBe(theirs.instanceId);
        expect(mine.instanceId).not.toBe(theirs.instanceId);
    });

    // getListenerInstanceIds scans every instance in the game, decks included.
    // NOTE: this passes incidentally — the deck copy is a different instanceId, so
    // THIS fails on its own and the activeZone gate is never exercised. The next
    // test is the one that actually forces it.
    it("does not stage for a copy of the card sitting in the deck", () => {
        const { state: base } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({ steps: [makeDrawStep(1)] }),
        });
        const inDeck = makeCharacterInstance({ controller: "p1", cardId: EFFECT_CARD, currentZone: "DECK" });
        const state = placeCard(base, inDeck, "DECK", "p1");

        const played = makeCharacterInstance({ controller: "p1", cardId: EFFECT_CARD, currentZone: "CHARACTERS" });
        const withPlayed = placeCard(state, played, "CHARACTERS", "p1");
        const next = emit(withPlayed, playedSignal(played.instanceId, "p1"));

        expect(next.stagingFrame["p1"].map(ref => ref.instanceId)).not.toContain(inDeck.instanceId);
    });

    // The real activeZone test. A broad subject ("when you play a character") is
    // satisfied by the played card regardless of which instance is listening, so
    // THIS no longer protects us — only the zone gate can stop a card in the deck
    // from activating.
    it("does not stage a broad-subject effect from a listener sitting in the deck", () => {
        const { state, listener } = boardWithListener(
            {
                [EFFECT_ID]: makeEffectDef({
                    activation: [{
                        signal: "CHARACTER_PLAYED",
                        subject: {
                            kind: "AND",
                            filters: [
                                { kind: "CONTROLLER", controller: "SELF" },
                                { kind: "CLASS", cardClass: "CHARACTER" },
                            ],
                        },
                    }],
                    steps: [makeDrawStep(1)],
                }),
            },
            { currentZone: "DECK" },
        );

        const played = makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "CHARACTERS" });
        const withPlayed = placeCard(state, played, "CHARACTERS", "p1");
        const next = emit(withPlayed, playedSignal(played.instanceId, "p1"));

        expect(next.stagingFrame["p1"].map(ref => ref.instanceId)).not.toContain(listener.instanceId);
    });

    it("does not stage when no activation entry matches the signal type", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "THIS" } }],
                steps: [makeDrawStep(1)],
            }),
        });

        const next = emit(state, {
            type: "STAGE_PLAYED",
            instanceId: listener.instanceId,
            controller: "p1",
            fromZone: "HAND",
            toZone: "STAGE",
            cause: { kind: "PLAYER" },
        });

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    // .some() semantics — two matching entries still produce one EffectRef.
    it("stages once when two activation entries match the same signal", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [
                    { signal: "CHARACTER_PLAYED", subject: { kind: "THIS" } },
                    { signal: "CHARACTER_PLAYED", subject: { kind: "ANY" } },
                ],
                steps: [makeDrawStep(1)],
            }),
        });

        const next = emit(state, playedSignal(listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toHaveLength(1);
    });

    it("stages the ref under the controller of the listening card", () => {
        const { state, listener } = boardWithListener(
            { [EFFECT_ID]: makeEffectDef({ steps: [makeDrawStep(1)] }) },
            { controller: "p2" },
        );

        const next = emit(state, playedSignal(listener.instanceId, "p2"));

        expect(next.stagingFrame["p2"]).toHaveLength(1);
        expect(next.stagingFrame["p1"]).toEqual([]);
    });
});

// The two gate fields the discriminated SignalActivation adds. Both are optional:
// an activation that omits them matches any cause and any origin zone, which is
// what keeps every existing card definition valid unchanged.
describe("activation gates on signal fields", () => {
    const withCause = (
        narrowing: Pick<SignalActivation, "causeKind" | "source">,
    ): Record<EffectId, EffectDef> => ({
        [EFFECT_ID]: makeEffectDef({
            activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY" }, ...narrowing }],
            steps: [makeDrawStep(1)],
        }),
    });

    it("stages when the cause kind and causing card both match", () => {
        const { state, listener, causeCard } = boardWithListenerAndCause(
            withCause({ causeKind: ["EFFECT"], source: { kind: "COLOR", color: "BLUE" } }),
            ["BLUE"],
        );

        const next = emit(state, {
            ...playedSignal(listener.instanceId, "p1"),
            cause: { kind: "EFFECT", sourceId: causeCard.instanceId },
        } as GameSignal);

        expect(next.stagingFrame["p1"]).toHaveLength(1);
    });

    // This is the distinction a bare "does it have a sourceId" check cannot make.
    it("does not stage when the cause kind differs", () => {
        const { state, listener } = boardWithListenerAndCause(
            withCause({ causeKind: ["EFFECT"] }),
            ["BLUE"],
        );

        // played by the player, not by an effect
        const next = emit(state, playedSignal(listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    it("does not stage when the causing card fails the filter", () => {
        const { state, listener, causeCard } = boardWithListenerAndCause(
            withCause({ causeKind: ["EFFECT"], source: { kind: "COLOR", color: "BLUE" } }),
            ["RED"],
        );

        const next = emit(state, {
            ...playedSignal(listener.instanceId, "p1"),
            cause: { kind: "EFFECT", sourceId: causeCard.instanceId },
        } as GameSignal);

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    // A cause filter cannot pass when nothing caused it — RULE carries no sourceId.
    it("does not stage on a causeless signal when a causing card is required", () => {
        const { state, listener } = boardWithListenerAndCause(
            withCause({ source: { kind: "ANY" } }),
            ["BLUE"],
        );

        const next = emit(state, {
            ...playedSignal(listener.instanceId, "p1"),
            cause: { kind: "RULE" },
        } as GameSignal);

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    // fromZone is the field that cannot be recovered from the card: by the time
    // the signal fires the card has already moved to its destination.
    it("stages when the origin zone is listed", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY" }, fromZone: ["HAND"] }],
                steps: [makeDrawStep(1)],
            }),
        });

        const next = emit(state, playedSignal(listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toHaveLength(1);
    });

    it("does not stage when the origin zone is not listed", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY" }, fromZone: ["TRASH"] }],
                steps: [makeDrawStep(1)],
            }),
        });

        // played from hand, but the effect only listens for plays out of the trash
        const next = emit(state, playedSignal(listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toEqual([]);
    });
});
