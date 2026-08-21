import { describe, it, expect, beforeEach } from "vitest";
import type {
    AmountExpression,
    Condition,
    EvalContext,
    GameState,
    CardInstance,
    CharacterInstance,
    CardInstanceId,
    CardSnapshot,
    PlayerId,
} from "../../types";
import { evalCondition } from "../../evaluator";
import { createTestState, makeCharacterInstance, resetIds } from "../helpers";

// `Condition` is a boolean expression, not a board query — nothing in it reads the
// game. Everything it can ask about comes through AmountExpression's leaves, so these
// tests are really about two things:
//
//   1. the boolean combinators (AND/OR/NOT), including their vacuous cases
//   2. COMPARE being a comparison of TWO expressions, which is what ZONE_SIZE could
//      not do — it had no operator and no controller scoping
//
// The last describe block pins the inheritance: a condition is exactly as capable, and
// exactly as failure-prone, as the amounts inside it.

const SELF: PlayerId = "p1";
const OPP: PlayerId = "p2";

const evalContext: EvalContext = { self: SELF, source: "source" };

let state: GameState;

beforeEach(() => {
    resetIds();
    state = createTestState([SELF, OPP]);
});

function char(overrides: Partial<CharacterInstance> = {}): CharacterInstance {
    return { ...(makeCharacterInstance() as CharacterInstance), ...overrides };
}

// `self` characters for p1 and `opp` for p2, all on the field.
function charsInPlay(self: number, opp: number): GameState {
    const selfChars = Array.from({ length: self }, () => char({ controller: SELF, currentZone: "CHARACTERS" }));
    const oppChars = Array.from({ length: opp }, () => char({ controller: OPP, currentZone: "CHARACTERS" }));
    const instances: Record<CardInstanceId, CardInstance> = {};
    for (const c of [...selfChars, ...oppChars]) instances[c.instanceId] = c;
    return createTestState([SELF, OPP], instances, {
        [SELF]: { characters: selfChars.map(c => c.instanceId) },
        [OPP]: { characters: oppChars.map(c => c.instanceId) },
    });
}

const lit = (value: number): AmountExpression => ({ kind: "LITERAL", value });

// Characters controlled by one side. The CONTROLLER filter is the scoping ZONE_SIZE
// lacked — it could only count a zone across both players.
const myChars: AmountExpression = {
    kind: "COUNT", zones: ["CHARACTERS"], filter: { kind: "CONTROLLER", controller: "SELF" },
};
const theirChars: AmountExpression = {
    kind: "COUNT", zones: ["CHARACTERS"], filter: { kind: "CONTROLLER", controller: "OPPONENT" },
};

const TRUE: Condition = { kind: "COMPARE", op: "==", left: lit(1), right: lit(1) };
const FALSE: Condition = { kind: "COMPARE", op: "==", left: lit(1), right: lit(0) };

describe("COMPARE operators", () => {
    // Table-driven: 3 vs 5 exercises every operator in both directions.
    const cases: [">=" | "<=" | "==" | ">" | "<", boolean][] = [
        [">=", false],
        ["<=", true],
        ["==", false],
        [">", false],
        ["<", true],
    ];

    for (const [op, expected] of cases) {
        it(`3 ${op} 5 is ${expected}`, () => {
            expect(evalCondition(state, evalContext, { kind: "COMPARE", op, left: lit(3), right: lit(5) }))
                .toBe(expected);
        });
    }

    it("treats equal values as equal", () => {
        expect(evalCondition(state, evalContext, { kind: "COMPARE", op: "==", left: lit(4), right: lit(4) })).toBe(true);
        expect(evalCondition(state, evalContext, { kind: "COMPARE", op: ">=", left: lit(4), right: lit(4) })).toBe(true);
        expect(evalCondition(state, evalContext, { kind: "COMPARE", op: ">", left: lit(4), right: lit(4) })).toBe(false);
    });
});

describe("what ZONE_SIZE could not express", () => {
    // "if you have 2 or more Characters" — needs an OPERATOR, which ZONE_SIZE had none of.
    it("compares a controller-scoped count against a threshold", () => {
        const board = charsInPlay(3, 1);
        const twoOrMore: Condition = { kind: "COMPARE", op: ">=", left: myChars, right: lit(2) };

        expect(evalCondition(board, evalContext, twoOrMore)).toBe(true);
        expect(evalCondition(charsInPlay(1, 5), evalContext, twoOrMore)).toBe(false);
    });

    // The scoping half: the opponent's board must not leak into "your" count.
    it("scopes by controller rather than by zone alone", () => {
        const board = charsInPlay(1, 4);

        expect(evalCondition(board, evalContext, { kind: "COMPARE", op: "==", left: myChars, right: lit(1) })).toBe(true);
        expect(evalCondition(board, evalContext, { kind: "COMPARE", op: "==", left: theirChars, right: lit(4) })).toBe(true);
    });

    // Two expressions rather than expression-vs-literal — impossible under ZONE_SIZE at
    // any operator, since one side was always a bare amount.
    it("compares two counts relationally", () => {
        const moreThanThem: Condition = { kind: "COMPARE", op: ">", left: myChars, right: theirChars };

        expect(evalCondition(charsInPlay(3, 1), evalContext, moreThanThem)).toBe(true);
        expect(evalCondition(charsInPlay(1, 3), evalContext, moreThanThem)).toBe(false);
        expect(evalCondition(charsInPlay(2, 2), evalContext, moreThanThem)).toBe(false);
    });

    // The existence idiom. Deliberately no EXISTS leaf — this is what it would be.
    it("expresses existence as COUNT >= 1", () => {
        const iHaveAny: Condition = { kind: "COMPARE", op: ">=", left: myChars, right: lit(1) };

        expect(evalCondition(charsInPlay(1, 0), evalContext, iHaveAny)).toBe(true);
        expect(evalCondition(charsInPlay(0, 3), evalContext, iHaveAny)).toBe(false);
    });
});

describe("combinators", () => {
    it("AND is true only when every branch is", () => {
        expect(evalCondition(state, evalContext, { kind: "AND", conditions: [TRUE, TRUE] })).toBe(true);
        expect(evalCondition(state, evalContext, { kind: "AND", conditions: [TRUE, FALSE] })).toBe(false);
        expect(evalCondition(state, evalContext, { kind: "AND", conditions: [FALSE, FALSE] })).toBe(false);
    });

    it("OR is true when any branch is", () => {
        expect(evalCondition(state, evalContext, { kind: "OR", conditions: [FALSE, TRUE] })).toBe(true);
        expect(evalCondition(state, evalContext, { kind: "OR", conditions: [FALSE, FALSE] })).toBe(false);
    });

    it("NOT inverts", () => {
        expect(evalCondition(state, evalContext, { kind: "NOT", condition: TRUE })).toBe(false);
        expect(evalCondition(state, evalContext, { kind: "NOT", condition: FALSE })).toBe(true);
    });

    // Vacuous cases, pinned because they are silent when wrong: an empty AND that
    // returned false would make every effect with a forgotten branch fizzle, and an
    // empty OR that returned true would gate nothing. Matches CardFilter's AND/OR.
    it("an empty AND is true and an empty OR is false", () => {
        expect(evalCondition(state, evalContext, { kind: "AND", conditions: [] })).toBe(true);
        expect(evalCondition(state, evalContext, { kind: "OR", conditions: [] })).toBe(false);
    });

    it("nests to arbitrary depth", () => {
        const board = charsInPlay(3, 1);
        // "you have 2+ Characters AND NOT (opponent has 3+)"
        const condition: Condition = {
            kind: "AND",
            conditions: [
                { kind: "COMPARE", op: ">=", left: myChars, right: lit(2) },
                { kind: "NOT", condition: { kind: "COMPARE", op: ">=", left: theirChars, right: lit(3) } },
            ],
        };

        expect(evalCondition(board, evalContext, condition)).toBe(true);
        expect(evalCondition(charsInPlay(3, 4), evalContext, condition)).toBe(false);
    });
});

describe("reach is inherited from AmountExpression, not defined here", () => {
    const snap = (instanceId: CardInstanceId): CardSnapshot => ({
        instanceId, cardId: "c", class: "CHARACTER", controller: SELF,
        zoneAtCapture: "TRASH", isRested: false, flipped: false, attachedDon: [],
        power: null, basePower: null, cost: null, baseCost: null, counter: null, baseCounter: null,
    });

    // A condition can ask about the activating signal purely because AmountExpression
    // can — nothing in Condition knows signals exist.
    it("can compare against the activating signal's subject count", () => {
        const withSubjects: EvalContext = { ...evalContext, subjects: [snap("a"), snap("b")] };
        const twoOrMoreTrashed: Condition = {
            kind: "COMPARE", op: ">=", left: { kind: "SUBJECT_COUNT" }, right: lit(2),
        };

        expect(evalCondition(state, withSubjects, twoOrMoreTrashed)).toBe(true);
        expect(evalCondition(state, { ...evalContext, subjects: [snap("a")] }, twoOrMoreTrashed)).toBe(false);
    });

    // And it inherits the failure mode: no signal in scope is unanswerable, not zero.
    // Comparing against 0 here would silently make the condition false instead of
    // reporting that the card asked something meaningless.
    it("throws when a subject count is asked with no signal in scope", () => {
        expect(() => evalCondition(state, evalContext, {
            kind: "COMPARE", op: ">=", left: { kind: "SUBJECT_COUNT" }, right: lit(1),
        })).toThrow();
    });
});
