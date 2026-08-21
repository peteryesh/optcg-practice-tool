import { describe, it, expect, beforeEach } from "vitest";
import { advanceEffect } from "../../game/effects/stepper";
import { advance } from "../../conductor";
import {
    createTestState,
    makeCharacterInstance,
    makeDrawStep,
    makeEffectContext,
    makeEffectDef,
    resetIds,
    withEffect,
} from "../helpers";
import type { GameState } from "../../types/state";
import type { CardInstance } from "../../types/card";
import type { EffectStep } from "../../types/effect";
import type { PlayerId } from "../../types/primitives";

// Phase 1.D — advanceEffect, the currentEffect stepper.
//
// advanceEffect owns four decisions and nothing else:
//   which step is current, what kind it is, that progress was made, and whether
//   the effect is finished. The work inside a RESOLUTION step belongs to
//   executeResolution (resolution.test.ts).
//
// ON BRITTLENESS. This unit is pure bookkeeping, which makes it tempting to
// assert on the bookkeeping — and the bookkeeping is exactly what the deferred
// work (goto/labels, done/abort terminals, the consumption boundary) will rewrite.
// So progress and ordering are asserted through what the OPERATIONS did — cards
// moved — rather than through the counter. Exactly one test reads `cursor`
// directly, and it is labelled as pinning a recorded design invariant.
//
// Throws are asserted bare, with no message matching, so rewording an error does
// not fail a test.

const FILLER_CARD = "OP01-FILLER";
const SOURCE_CARD = "OP01-SOURCE";

function makeDeck(controller: PlayerId, count: number): CardInstance[] {
    return Array.from({ length: count }, () =>
        makeCharacterInstance({ controller, cardId: FILLER_CARD, currentZone: "DECK" }));
}

function instanceMap(instances: CardInstance[]): Record<string, CardInstance> {
    return Object.fromEntries(instances.map(i => [i.instanceId, i]));
}

// A MAIN-phase board with both decks stocked, p1 controlling `source` on the
// field, and an effect already promoted and parked at cursor 0. Stands in for
// whatever staging and promotion would have produced.
function boardMidEffect(
    steps: EffectStep[],
    opts: { playerId?: PlayerId; triggerCard?: boolean } = {},
): { state: GameState; source: CardInstance } {
    const playerId = opts.playerId ?? "p1";
    const source = makeCharacterInstance({ controller: playerId, cardId: SOURCE_CARD, currentZone: "CHARACTERS" });
    const p1Deck = makeDeck("p1", 5);
    const p2Deck = makeDeck("p2", 5);
    const triggerCard = opts.triggerCard
        ? makeCharacterInstance({ controller: "p1", cardId: FILLER_CARD, currentZone: "TRIGGER" })
        : null;

    const base = createTestState(
        ["p1", "p2"],
        instanceMap([source, ...p1Deck, ...p2Deck, ...(triggerCard ? [triggerCard] : [])]),
        {
            p1: {
                characters: playerId === "p1" ? [source.instanceId] : [],
                deck: p1Deck.map(c => c.instanceId),
                trigger: triggerCard ? [triggerCard.instanceId] : [],
            },
            p2: {
                characters: playerId === "p2" ? [source.instanceId] : [],
                deck: p2Deck.map(c => c.instanceId),
            },
        },
    );

    const state: GameState = {
        ...base,
        currentEffect: makeEffectContext({ playerId, instanceId: source.instanceId, steps }),
    };
    return { state, source };
}

beforeEach(() => {
    resetIds();
});

describe("advanceEffect", () => {
    it("resolves the step sitting at the cursor", () => {
        const { state } = boardMidEffect([makeDrawStep(1)]);

        const next = advanceEffect(state);

        expect(next.playerZones["p1"].hand).toHaveLength(1);
    });

    // THE ONE STRUCTURAL TEST. Pins the recorded invariant that `cursor` is a
    // plain int advanced by one — which is what keeps resume trivial and rules
    // out nested step groups. If that design is ever revisited, this is the test
    // that should fail, and it should be the only one.
    it("advances the cursor by one past a resolved step", () => {
        const { state } = boardMidEffect([makeDrawStep(1), makeDrawStep(1)]);

        const next = advanceEffect(state);

        expect(next.currentEffect?.cursor).toBe(1);
    });

    // The fixed-point loop belongs to `advance`. Draining the list here would
    // duplicate it and hide the mid-effect pauses a PAYMENT step will need.
    // Observed through the draw count rather than the cursor.
    it("runs exactly one step per call", () => {
        const { state } = boardMidEffect([makeDrawStep(1), makeDrawStep(1)]);

        const next = advanceEffect(state);

        expect(next.playerZones["p1"].hand).toHaveLength(1);
        expect(next.currentEffect).not.toBeNull();
    });

    // Steps draw different amounts so the ORDER is observable, not just the total.
    it("resolves a multi-step effect in list order across successive calls", () => {
        const { state } = boardMidEffect([makeDrawStep(1), makeDrawStep(2)]);

        const afterFirst = advanceEffect(state);
        expect(afterFirst.playerZones["p1"].hand).toHaveLength(1);

        const afterSecond = advanceEffect(afterFirst);
        expect(afterSecond.playerZones["p1"].hand).toHaveLength(3);
    });

    // The call that runs the last step is also the call that terminates — no
    // extra round trip to notice the list ran out.
    it("clears currentEffect on the call that resolves the last step", () => {
        const { state } = boardMidEffect([makeDrawStep(1)]);

        const next = advanceEffect(state);

        expect(next.playerZones["p1"].hand).toHaveLength(1);
        expect(next.currentEffect).toBeNull();
    });

    it("clears currentEffect immediately for an effect with no steps", () => {
        const { state } = boardMidEffect([]);

        const next = advanceEffect(state);

        expect(next.currentEffect).toBeNull();
        expect(next.playerZones["p1"].hand).toHaveLength(0);
    });

    // Nothing should reach the stepper without a promoted effect — `step` only
    // calls it behind a null check, so arriving here with none is a bug in the
    // caller, not a state worth tolerating.
    it("throws when called with no currentEffect", () => {
        const { state } = boardMidEffect([makeDrawStep(1)]);

        expect(() => advanceEffect({ ...state, currentEffect: null })).toThrow();
    });

    // Real step kinds with no implementation yet. They must fail loudly rather
    // than be skipped, or a half-authored effect looks like it resolved.
    it("throws for a REQUIREMENT step", () => {
        const { state } = boardMidEffect([{
            kind: "REQUIREMENT",
            requirement: {
                kind: "COMPARE", op: ">=",
                left: { kind: "COUNT", zones: ["HAND"], filter: { kind: "CONTROLLER", controller: "SELF" } },
                right: { kind: "LITERAL", value: 1 },
            },
        }]);

        expect(() => advanceEffect(state)).toThrow();
    });

    it("throws for a PAYMENT step", () => {
        const { state } = boardMidEffect([{
            kind: "PAYMENT",
            optional: false,
            cost: { kind: "REST" },
        }]);

        expect(() => advanceEffect(state)).toThrow();
    });
});

// `step` is private to conductor.ts, so delegation is observed through `advance`,
// which runs to a fixed point. There is no intermediate state to catch, so these
// assert the END STATE that the conductor's branch ordering produces.
describe("conductor delegation", () => {
    it("runs a promoted effect to completion", () => {
        const { state } = boardMidEffect([makeDrawStep(1), makeDrawStep(1)]);

        const next = advance(state);

        expect(next.playerZones["p1"].hand).toHaveLength(2);
        expect(next.currentEffect).toBeNull();
    });

    it("resumes normal phase handling after the effect finishes", () => {
        const { state } = boardMidEffect([makeDrawStep(1)]);

        const next = advance(state);

        expect(next.decisionPoint).toEqual({ type: "MAIN_ACTION", player: "p1" });
    });

    // The currentEffect branch sits ahead of the trigger check on purpose. Both
    // assertions together are the contract: the effect ran to completion AND the
    // trigger is still offered afterwards — it was deferred, not skipped.
    it("finishes a resolving effect before offering a TRIGGER decision point", () => {
        const { state } = boardMidEffect([makeDrawStep(1)], { triggerCard: true });

        const next = advance(state);

        expect(next.playerZones["p1"].hand).toHaveLength(1);
        expect(next.decisionPoint?.type).toBe("TRIGGER");
    });

    // Refs staged while an effect is in flight must wait. If the frame were
    // committed and promoted first it would displace currentEffect, and the
    // in-flight effect's draw would never happen — so the draw is the assertion.
    it("does not displace a resolving effect with a newly staged one", () => {
        const listener = makeCharacterInstance({ controller: "p1", cardId: "OP01-LISTENER", currentZone: "CHARACTERS" });
        const source = makeCharacterInstance({ controller: "p1", cardId: SOURCE_CARD, currentZone: "CHARACTERS" });
        const p1Deck = makeDeck("p1", 5);
        const p2Deck = makeDeck("p2", 5);

        const base = createTestState(
            ["p1", "p2"],
            instanceMap([source, listener, ...p1Deck, ...p2Deck]),
            {
                p1: { characters: [source.instanceId, listener.instanceId], deck: p1Deck.map(c => c.instanceId) },
                p2: { deck: p2Deck.map(c => c.instanceId) },
            },
            // the staged effect does nothing, so it settles without interfering
            withEffect("OP01-LISTENER", { "e1": makeEffectDef({ steps: [] }) }),
        );

        const state: GameState = {
            ...base,
            currentEffect: makeEffectContext({ playerId: "p1", instanceId: source.instanceId, steps: [makeDrawStep(1)] }),
            stagingFrame: {
                p1: [makeEffectContext({ playerId: "p1", effectId: "e1", instanceId: listener.instanceId, steps: [] })],
                p2: [],
            },
        };

        const next = advance(state);

        expect(next.playerZones["p1"].hand).toHaveLength(1);
        expect(next.currentEffect).toBeNull();
    });
});
