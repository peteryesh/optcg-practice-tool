import { describe, it, expect, beforeEach } from "vitest";
import { advance } from "../../conductor";
import { reducer } from "../../reducer";
import { getLegalActions } from "../../actionGen";
import { emit } from "../../game/emitter";
import { captureSnapshot } from "../../game/snapshot";
import { InvalidActionError } from "../../errors";
import {
    createTestState,
    makeCharacterInstance,
    makeDrawStep,
    makeEffectDef,
    placeCard,
    resetIds,
    withEffect,
} from "../helpers";
import type { GameState } from "../../types/state";
import type { CardInstance, CardDef } from "../../types/card";
import type { CardInstanceId } from "../../types/primitives";

// RESOLVE_EFFECT_ORDER — when one player has several effects waiting in a frame, the
// player picks which resolves next.
//
// WHY THE ASSERTIONS LOOK LIKE THIS. Only DRAW is implemented, so both effects draw
// into the same hand off the same deck and the final board is identical whichever
// order they ran in — counting cards proves nothing. The order is recovered from
// gameLog instead: every effect-driven draw emits CARDS_SENT_TO_HAND carrying
// `cause.sourceId`, which is the card whose effect drew. That is an operation result,
// not an internal structure, so these survive changes to the queue's shape.
//
// Most tests never name a field on the action either — they take actions from
// getLegalActions and hand them straight back to reducer. Wrong-order resolution is
// SILENT (the game proceeds, both effects resolve, nothing throws), which is the whole
// reason this file exists.

const CARD_A = "OP01-A";
const CARD_B = "OP01-B";
const TWO_EFFECT_CARD = "OP01-TWO";
const FILLER = "OP01-FILLER";

beforeEach(() => {
    resetIds();
});

// An effect that draws when ANY character is played, so several listeners activate off
// one signal without needing to be the played card themselves.
function drawOnAnyPlay(amount = 1) {
    return makeEffectDef({
        activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "ANY" } } }],
        steps: [makeDrawStep(amount)],
    });
}

function board(defs: Record<string, CardDef>, listeners: { cardId: string }[]) {
    const instances: Record<string, CardInstance> = {};
    const decks: Record<string, CardInstance[]> = {};
    for (const p of ["p1", "p2"]) {
        decks[p] = Array.from({ length: 8 }, () =>
            makeCharacterInstance({ controller: p, cardId: FILLER, currentZone: "DECK" }));
        for (const c of decks[p]) instances[c.instanceId] = c;
    }

    let state: GameState = createTestState(
        ["p1", "p2"],
        instances,
        {
            p1: { deck: decks.p1.map(c => c.instanceId) },
            p2: { deck: decks.p2.map(c => c.instanceId) },
        },
        defs,
    );

    const placed: CardInstance[] = [];
    for (const { cardId } of listeners) {
        const c = makeCharacterInstance({ controller: "p1", cardId, currentZone: "CHARACTERS" });
        state = placeCard(state, c, "CHARACTERS", "p1");
        placed.push(c);
    }

    // The card whose play sets everything off. It has no effects of its own.
    const played = makeCharacterInstance({ controller: "p1", cardId: FILLER, currentZone: "CHARACTERS" });
    state = placeCard(state, played, "CHARACTERS", "p1");

    return { state, placed, played };
}

// Park the game at the decision point by emitting the play and letting the conductor
// run to its next pause.
function stagedAt(state: GameState, playedId: CardInstanceId): GameState {
    return advance(emit(state, {
        type: "CHARACTER_PLAYED",
        subjects: [captureSnapshot(state, playedId)],
        controller: "p1",
        fromZone: "HAND",
        toZone: "CHARACTERS",
        cause: { kind: "PLAYER" },
    }));
}

// Which card's effect drew, in the order the draws happened.
function drawOrder(state: GameState): CardInstanceId[] {
    return state.gameLog
        .filter(e => e.kind === "SIGNAL" && e.signal.type === "CARDS_SENT_TO_HAND")
        .map(e => {
            const cause = (e as { signal: { cause: { kind: string; sourceId?: CardInstanceId } } }).signal.cause;
            return cause.sourceId!;
        });
}

describe("RESOLVE_EFFECT_ORDER", () => {
    it("pauses and offers one action per waiting effect", () => {
        const { state, played } = board(
            { ...withEffect(CARD_A, { e1: drawOnAnyPlay() }), ...withEffect(CARD_B, { e1: drawOnAnyPlay() }) },
            [{ cardId: CARD_A }, { cardId: CARD_B }],
        );

        const staged = stagedAt(state, played.instanceId);

        expect(staged.decisionPoint).toEqual({ type: "RESOLVE_EFFECT_ORDER", player: "p1" });
        expect(getLegalActions(staged, "p1")).toHaveLength(2);
        // The opponent is not being asked.
        expect(getLegalActions(staged, "p2")).toEqual([]);
    });

    // THE POINT OF THE FEATURE. Both branches are run from the same parked state, so
    // the only difference is which action was chosen.
    it("the choice determines which effect resolves first", () => {
        const { state, placed, played } = board(
            { ...withEffect(CARD_A, { e1: drawOnAnyPlay() }), ...withEffect(CARD_B, { e1: drawOnAnyPlay() }) },
            [{ cardId: CARD_A }, { cardId: CARD_B }],
        );
        const [a, b] = placed;

        const staged = stagedAt(state, played.instanceId);
        const actions = getLegalActions(staged, "p1");

        const first = drawOrder(reducer(staged, actions[0]));
        const second = drawOrder(reducer(staged, actions[1]));

        // Both orders are reachable, and each is a permutation of the two listeners.
        expect(first).not.toEqual(second);
        expect([...first].sort()).toEqual([a.instanceId, b.instanceId].sort());
        expect([...second].sort()).toEqual([a.instanceId, b.instanceId].sort());
    });

    it("resolves the remaining effect without asking again", () => {
        const { state, played } = board(
            { ...withEffect(CARD_A, { e1: drawOnAnyPlay() }), ...withEffect(CARD_B, { e1: drawOnAnyPlay() }) },
            [{ cardId: CARD_A }, { cardId: CARD_B }],
        );

        const staged = stagedAt(state, played.instanceId);
        const after = reducer(staged, getLegalActions(staged, "p1")[0]);

        // One decision resolved BOTH effects — the last one auto-promotes.
        expect(drawOrder(after)).toHaveLength(2);
        expect(after.currentEffect).toBeNull();
        expect(after.decisionPoint?.type).toBe("MAIN_ACTION");
    });

    // n effects produce n-1 decisions: the last one is never a choice.
    it("asks again while more than one effect remains", () => {
        const { state, played } = board(
            {
                ...withEffect(CARD_A, { e1: drawOnAnyPlay() }),
                ...withEffect(CARD_B, { e1: drawOnAnyPlay() }),
                ...withEffect(TWO_EFFECT_CARD, { e1: drawOnAnyPlay() }),
            },
            [{ cardId: CARD_A }, { cardId: CARD_B }, { cardId: TWO_EFFECT_CARD }],
        );

        const staged = stagedAt(state, played.instanceId);
        expect(getLegalActions(staged, "p1")).toHaveLength(3);

        const afterFirst = reducer(staged, getLegalActions(staged, "p1")[0]);
        expect(afterFirst.decisionPoint).toEqual({ type: "RESOLVE_EFFECT_ORDER", player: "p1" });
        expect(getLegalActions(afterFirst, "p1")).toHaveLength(2);

        const afterSecond = reducer(afterFirst, getLegalActions(afterFirst, "p1")[0]);
        expect(afterSecond.decisionPoint?.type).toBe("MAIN_ACTION");
        expect(drawOrder(afterSecond)).toHaveLength(3);
    });

    // Two effects on ONE card. This is what the composite key exists for — matching on
    // instanceId alone would splice whichever came first regardless of the choice.
    it("distinguishes two effects on the same card", () => {
        const { state, placed, played } = board(
            {
                ...withEffect(TWO_EFFECT_CARD, {
                    e1: drawOnAnyPlay(1),
                    e2: drawOnAnyPlay(2),
                }),
            },
            [{ cardId: TWO_EFFECT_CARD }],
        );
        const card = placed[0];

        const staged = stagedAt(state, played.instanceId);
        const actions = getLegalActions(staged, "p1");

        expect(actions).toHaveLength(2);
        // Same instance, different effects — so instanceId cannot be the key.
        expect(new Set(actions.map(a => (a as { instanceId: string }).instanceId))).toEqual(
            new Set([card.instanceId]),
        );
        expect(new Set(actions.map(a => (a as { effectId: string }).effectId))).toEqual(
            new Set(["e1", "e2"]),
        );

        // Draw counts differ, so the FIRST signal's subject count reveals which ran first.
        const firstDrawSize = (s: GameState) => {
            const sig = s.gameLog.find(e => e.kind === "SIGNAL" && e.signal.type === "CARDS_SENT_TO_HAND");
            return (sig as { signal: { subjects: unknown[] } }).signal.subjects.length;
        };

        expect(firstDrawSize(reducer(staged, actions[0])))
            .not.toBe(firstDrawSize(reducer(staged, actions[1])));
    });

    describe("rejects selections that are not on offer", () => {
        function parked() {
            const { state, played } = board(
                { ...withEffect(CARD_A, { e1: drawOnAnyPlay() }), ...withEffect(CARD_B, { e1: drawOnAnyPlay() }) },
                [{ cardId: CARD_A }, { cardId: CARD_B }],
            );
            return stagedAt(state, played.instanceId);
        }

        it("an index outside the frame", () => {
            const staged = parked();
            const real = getLegalActions(staged, "p1")[0] as { instanceId: string; effectId: string };
            expect(() => reducer(staged, {
                type: "CHOOSE_NEXT_EFFECT", playerId: "p1", index: 7,
                instanceId: real.instanceId, effectId: real.effectId,
            })).toThrow(InvalidActionError);
        });

        // The ids are a consistency check on the index: a stale index that happens to
        // be in range must be rejected, not silently promote the wrong effect.
        it("an index whose ids do not match", () => {
            const staged = parked();
            const [first, second] = getLegalActions(staged, "p1") as unknown as {
                index: number; instanceId: string; effectId: string;
            }[];
            expect(() => reducer(staged, {
                type: "CHOOSE_NEXT_EFFECT", playerId: "p1",
                index: first.index, instanceId: second.instanceId, effectId: second.effectId,
            })).toThrow(InvalidActionError);
        });

        it("a choice made by the player who was not asked", () => {
            const staged = parked();
            const real = getLegalActions(staged, "p1")[0] as {
                index: number; instanceId: string; effectId: string;
            };
            expect(() => reducer(staged, {
                type: "CHOOSE_NEXT_EFFECT", playerId: "p2",
                index: real.index, instanceId: real.instanceId, effectId: real.effectId,
            })).toThrow(InvalidActionError);
        });
    });
});
