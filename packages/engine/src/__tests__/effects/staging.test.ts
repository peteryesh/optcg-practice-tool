import { describe, it, expect } from "vitest";
import { emit } from "../../game/emitter";
import { createTestState, makeCharacterInstance, makeEffectDef, makeDrawStep, placeCard, withEffect } from "../helpers";
import type { GameState } from "../../types/state";
import type { GameSignal } from "../../types/signal";
import type { CardInstance } from "../../types/card";
import type { EffectDef, EffectId, SignalActivation, SubjectMatch } from "../../types/effect";
import type { CardInstanceId, Color, Phase, PlayerId, Zone } from "../../types/primitives";
import { captureSnapshot } from "../../game/snapshot";

// The emitter's staging gates.
//
// Written against emit() directly: build a board, emit a signal, assert what landed in
// stagingFrame. Three gates decide staging — the activeZone gate, tier 1 (predicates
// over the signal) and tier 2 (the SubjectMatch over the signal's carried subjects).
//
// The contract tier 2 answers with, which everything below is really testing:
//   null      — did not activate
//   []        — activated, carries nothing   <- what makes phase-keyed effects possible
//   non-empty — activated, carries these

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

// The subject is captured from live state, which is what the real emit sites do —
// so a THIS filter matches on instanceId and a CONTROLLER filter on the captured
// controller, exactly as they would in a game.
function playedSignal(state: GameState, instanceId: CardInstanceId, controller: PlayerId): GameSignal {
    return {
        type: "CHARACTER_PLAYED",
        subjects: [captureSnapshot(state, instanceId)],
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

        const next = emit(state, playedSignal(state, listener.instanceId, "p1"));

        // Staging builds the effect in its final resolving shape — there is no
        // lighter reference form. Asserted on identity rather than deep equality
        // because the context also carries the def's steps.
        expect(next.stagingFrame["p1"]).toHaveLength(1);
        expect(next.stagingFrame["p1"][0]).toMatchObject({
            playerId: "p1",
            effectId: EFFECT_ID,
            instanceId: listener.instanceId,
            cursor: 0,
        });
    });

    // subject: THIS must not match a different instance of the same cardId. Both
    // players hold a copy; only the one that was actually played may stage.
    it("does not stage when the opponent plays a copy of the same card", () => {
        const { state: base, listener: mine } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({ steps: [makeDrawStep(1)] }),
        });
        const theirs = makeCharacterInstance({ controller: "p2", cardId: EFFECT_CARD, currentZone: "CHARACTERS" });
        const state = placeCard(base, theirs, "CHARACTERS", "p2");

        const next = emit(state, playedSignal(state, theirs.instanceId, "p2"));

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
        const next = emit(withPlayed, playedSignal(withPlayed, played.instanceId, "p1"));

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
                            kind: "ANY_OF",
                            filter: {
                                kind: "AND",
                                filters: [
                                    { kind: "CONTROLLER", controller: "SELF" },
                                    { kind: "CLASS", cardClass: "CHARACTER" },
                                ],
                            },
                        },
                    }],
                    steps: [makeDrawStep(1)],
                }),
            },
            { currentZone: "DECK" },
        );

        const played = makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "CHARACTERS" });
        const withPlayed = placeCard(state, played, "CHARACTERS", "p1");
        const next = emit(withPlayed, playedSignal(withPlayed, played.instanceId, "p1"));

        expect(next.stagingFrame["p1"].map(ref => ref.instanceId)).not.toContain(listener.instanceId);
    });

    it("does not stage when no activation entry matches the signal type", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "THIS" } } }],
                steps: [makeDrawStep(1)],
            }),
        });

        const next = emit(state, {
            type: "STAGE_PLAYED",
            subjects: [captureSnapshot(state, listener.instanceId)],
            controller: "p1",
            fromZone: "HAND",
            toZone: "STAGE",
            cause: { kind: "PLAYER" },
        });

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    // .some() semantics — two matching entries still produce one EffectContext.
    it("stages once when two activation entries match the same signal", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [
                    { signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "THIS" } } },
                    { signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "ANY" } } },
                ],
                steps: [makeDrawStep(1)],
            }),
        });

        const next = emit(state, playedSignal(state, listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toHaveLength(1);
    });

    it("stages the ref under the controller of the listening card", () => {
        const { state, listener } = boardWithListener(
            { [EFFECT_ID]: makeEffectDef({ steps: [makeDrawStep(1)] }) },
            { controller: "p2" },
        );

        const next = emit(state, playedSignal(state, listener.instanceId, "p2"));

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
            activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "ANY" } }, ...narrowing }],
            steps: [makeDrawStep(1)],
        }),
    });

    it("stages when the cause kind and causing card both match", () => {
        const { state, listener, causeCard } = boardWithListenerAndCause(
            withCause({ causeKind: ["EFFECT"], source: { kind: "COLOR", color: "BLUE" } }),
            ["BLUE"],
        );

        const next = emit(state, {
            ...playedSignal(state, listener.instanceId, "p1"),
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
        const next = emit(state, playedSignal(state, listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    it("does not stage when the causing card fails the filter", () => {
        const { state, listener, causeCard } = boardWithListenerAndCause(
            withCause({ causeKind: ["EFFECT"], source: { kind: "COLOR", color: "BLUE" } }),
            ["RED"],
        );

        const next = emit(state, {
            ...playedSignal(state, listener.instanceId, "p1"),
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
            ...playedSignal(state, listener.instanceId, "p1"),
            cause: { kind: "RULE" },
        } as GameSignal);

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    // fromZone is the field that cannot be recovered from the card: by the time
    // the signal fires the card has already moved to its destination.
    it("stages when the origin zone is listed", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "ANY" } }, fromZone: ["HAND"] }],
                steps: [makeDrawStep(1)],
            }),
        });

        const next = emit(state, playedSignal(state, listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toHaveLength(1);
    });

    it("does not stage when the origin zone is not listed", () => {
        const { state, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "ANY" } }, fromZone: ["TRASH"] }],
                steps: [makeDrawStep(1)],
            }),
        });

        // played from hand, but the effect only listens for plays out of the trash
        const next = emit(state, playedSignal(state, listener.instanceId, "p1"));

        expect(next.stagingFrame["p1"]).toEqual([]);
    });
});

// A signal that names no card at all. Before the gate was split from the payload this
// could never stage anything: the subject filter over an empty set produced [], and []
// was read as "did not activate". Every phase-keyed ability depends on it working.
function phaseSignal(nextPhase: Phase): GameSignal {
    return { type: "PHASE_CHANGED", prevPhase: "MAIN", nextPhase, cause: { kind: "RULE" } };
}

describe("subject-less activation", () => {
    it("stages a phase-keyed effect, which carries no subjects", () => {
        const { state } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "PHASE_CHANGED", phase: ["WHEN_ATTACKING"] }],
                steps: [makeDrawStep(1)],
            }),
        });

        const next = emit(state, phaseSignal("WHEN_ATTACKING"));

        expect(next.stagingFrame["p1"]).toHaveLength(1);
    });

    // Without the phase predicate a phase-keyed effect fires on EVERY transition —
    // "when attacking" would also go off during the draw phase.
    it("does not stage when a different phase is entered", () => {
        const { state } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "PHASE_CHANGED", phase: ["WHEN_ATTACKING"] }],
                steps: [makeDrawStep(1)],
            }),
        });

        const next = emit(state, phaseSignal("DRAW"));

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    // ATTACK_DECLARED names an attacker AND a defender, which the flat subject channel
    // cannot tell apart, so it deliberately carries no `subjects` and lands in the
    // subject-less arm by type. Listening for it must FAIL rather than quietly activate
    // on nothing — battle abilities are phase-keyed instead. This throw is a permanent
    // design assertion, not a migration TODO.
    it("throws when an effect listens for a role-shaped signal", () => {
        const { state } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "ATTACK_DECLARED" }],
                steps: [makeDrawStep(1)],
            }),
        });

        expect(() => emit(state, {
            type: "ATTACK_DECLARED",
            attackerId: "card-1",
            defenderId: "card-2",
            controller: "p1",
            cause: { kind: "PLAYER" },
        })).toThrow();
    });
});

describe("SubjectMatch quantifiers", () => {
    // Two cards trashed together, so ALL_OF has something to quantify over.
    function trashSignal(state: GameState, ids: CardInstanceId[]): GameSignal {
        return {
            type: "CARDS_SENT_TO_TRASH",
            subjects: ids.map(id => captureSnapshot(state, id)),
            fromZone: "HAND",
            controller: "p1",
            cause: { kind: "RULE" },
        };
    }

    function boardWithTrashListener(subject: SubjectMatch) {
        const { state: base, listener } = boardWithListener({
            [EFFECT_ID]: makeEffectDef({
                activation: [{ signal: "CARDS_SENT_TO_TRASH", subject } as SignalActivation],
                steps: [makeDrawStep(1)],
            }),
        });
        const mine = makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "HAND" });
        const theirs = makeCharacterInstance({ controller: "p2", cardId: FILLER_CARD, currentZone: "HAND" });
        let state = placeCard(base, mine, "HAND", "p1");
        state = placeCard(state, theirs, "HAND", "p2");
        return { state, listener, mine, theirs };
    }

    it("ALL_OF stages when every subject matches", () => {
        const { state, mine } = boardWithTrashListener({
            kind: "ALL_OF", filter: { kind: "CONTROLLER", controller: "SELF" },
        });

        const next = emit(state, trashSignal(state, [mine.instanceId]));

        expect(next.stagingFrame["p1"]).toHaveLength(1);
    });

    it("ALL_OF does not stage when one subject fails the filter", () => {
        const { state, mine, theirs } = boardWithTrashListener({
            kind: "ALL_OF", filter: { kind: "CONTROLLER", controller: "SELF" },
        });

        const next = emit(state, trashSignal(state, [mine.instanceId, theirs.instanceId]));

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    // The empty set has to FAIL, or ALL_OF is vacuously true and fires on every signal
    // that named nothing.
    it("ALL_OF does not stage for an empty subject set", () => {
        const { state } = boardWithTrashListener({
            kind: "ALL_OF", filter: { kind: "CONTROLLER", controller: "SELF" },
        });

        const next = emit(state, trashSignal(state, []));

        expect(next.stagingFrame["p1"]).toEqual([]);
    });

    // ANY_OF is existential, so a partial match still activates — and carries only the
    // subjects that matched, never the raw set.
    it("ANY_OF stages on a partial match", () => {
        const { state, mine, theirs } = boardWithTrashListener({
            kind: "ANY_OF", filter: { kind: "CONTROLLER", controller: "SELF" },
        });

        const next = emit(state, trashSignal(state, [mine.instanceId, theirs.instanceId]));

        expect(next.stagingFrame["p1"]).toHaveLength(1);
    });

    // THE GOVERNING INVARIANT: what the effect carries is exactly the set that
    // satisfied the filter, not the set the signal named. Two cards were trashed;
    // only one is the effect's business.
    it("carries the FILTERED subjects, not the raw signal set", () => {
        const { state, mine, theirs } = boardWithTrashListener({
            kind: "ANY_OF", filter: { kind: "CONTROLLER", controller: "SELF" },
        });

        const next = emit(state, trashSignal(state, [mine.instanceId, theirs.instanceId]));

        const staged = next.stagingFrame["p1"][0];
        expect(staged.subjects.map(s => s.instanceId)).toEqual([mine.instanceId]);
        expect(staged.subjects.map(s => s.instanceId)).not.toContain(theirs.instanceId);
    });

    // ALL_OF carries the full raw set, because "all of them matched" means all of them
    // are what the effect is about. It is a gate refinement, not a narrowing.
    it("ALL_OF carries every subject, not just the ones tested", () => {
        const { state, mine } = boardWithTrashListener({
            kind: "ALL_OF", filter: { kind: "CONTROLLER", controller: "SELF" },
        });
        const second = makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "HAND" });
        const withSecond = placeCard(state, second, "HAND", "p1");

        const next = emit(withSecond, trashSignal(withSecond, [mine.instanceId, second.instanceId]));

        expect(next.stagingFrame["p1"][0].subjects.map(s => s.instanceId))
            .toEqual([mine.instanceId, second.instanceId]);
    });
});
