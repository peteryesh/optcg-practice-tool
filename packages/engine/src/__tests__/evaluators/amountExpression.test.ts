import { describe, it, expect, beforeEach } from "vitest";
import type {
    AmountExpression,
    EvalContext,
    GameState,
    CardInstance,
    CharacterInstance,
    CardInstanceId,
    PlayerId,
} from "../../types";
import { evalAmountExpression } from "../../evaluator";
import { createTestState, makeCharacterInstance, resetIds } from "../helpers";

const SELF: PlayerId = "p1";
const OPP: PlayerId = "p2";

const evalContext: EvalContext = { self: SELF, source: "source" };

// A trivial state for the pure-arithmetic cases that never read game state.
let state: GameState;

beforeEach(() => {
    resetIds();
    state = createTestState([SELF, OPP]);
});

function char(overrides: Partial<CharacterInstance> = {}): CharacterInstance {
    return { ...(makeCharacterInstance() as CharacterInstance), ...overrides };
}

// Build a state with `self` characters controlled by p1 and `opp` characters
// controlled by p2, all sitting in each player's CHARACTERS zone.
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

const COUNT_CHARS: AmountExpression = {
    kind: "COUNT",
    zones: ["CHARACTERS"],
    filter: { kind: "ANY" },
};

describe("LITERAL", () => {
    it("returns the literal value", () => {
        const expression: AmountExpression = { kind: "LITERAL", value: 5 };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(5);
    });
    it("returns zero", () => {
        const expression: AmountExpression = { kind: "LITERAL", value: 0 };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(0);
    });
    it("returns a negative literal value", () => {
        const expression: AmountExpression = { kind: "LITERAL", value: -3 };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(-3);
    });
});

describe("COUNT", () => {
    it("counts cards in zones for both players (filter kind ANY)", () => {
        const s = charsInPlay(2, 1);
        const expression: AmountExpression = {
            kind: "COUNT",
            zones: ["CHARACTERS"],
            filter: { kind: "ANY" },
        };
        expect(evalAmountExpression(s, evalContext, expression)).toBe(3);
    });
    it("counts cards in zones for self only (filter kind CONTROLLER:SELF)", () => {
        const s = charsInPlay(2, 1);
        const expression: AmountExpression = {
            kind: "COUNT",
            zones: ["CHARACTERS"],
            filter: { kind: "CONTROLLER", controller: "SELF" },
        };
        expect(evalAmountExpression(s, evalContext, expression)).toBe(2);
    });
    it("counts cards in zones for opponent only (filter kind CONTROLLER:OPPONENT)", () => {
        const s = charsInPlay(2, 1);
        const expression: AmountExpression = {
            kind: "COUNT",
            zones: ["CHARACTERS"],
            filter: { kind: "CONTROLLER", controller: "OPPONENT" },
        };
        expect(evalAmountExpression(s, evalContext, expression)).toBe(1);
    });
    it("returns zero when no cards match", () => {
        const s = charsInPlay(0, 0);
        expect(evalAmountExpression(s, evalContext, COUNT_CHARS)).toBe(0);
    });
    it("counts across multiple zones", () => {
        const inHand = char({ controller: SELF, currentZone: "HAND" });
        const inPlay = char({ controller: SELF, currentZone: "CHARACTERS" });
        const s = createTestState(
            [SELF, OPP],
            { [inHand.instanceId]: inHand, [inPlay.instanceId]: inPlay },
            { [SELF]: { hand: [inHand.instanceId], characters: [inPlay.instanceId] } },
        );
        const expression: AmountExpression = {
            kind: "COUNT",
            zones: ["HAND", "CHARACTERS"],
            filter: { kind: "ANY" },
        };
        expect(evalAmountExpression(s, evalContext, expression)).toBe(2);
    });
});

describe("ADD", () => {
    it("adds two positive literal values", () => {
        const expression: AmountExpression = {
            kind: "ADD",
            left: { kind: "LITERAL", value: 3 },
            right: { kind: "LITERAL", value: 4 }
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(7);
    });
    it("adds a positive literal and a negative literal", () => {
        const expression: AmountExpression = {
            kind: "ADD",
            left: { kind: "LITERAL", value: 3 },
            right: { kind: "LITERAL", value: -4 },
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(-1);
    });
    it("adds two negative literals", () => {
        const expression: AmountExpression = {
            kind: "ADD",
            left: { kind: "LITERAL", value: -2 },
            right: { kind: "LITERAL", value: -3 },
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(-5);
    });
    it("adds a literal and a count expression", () => {
        const s = charsInPlay(2, 1); // COUNT_CHARS === 3
        // literal as left, count as right
        expect(evalAmountExpression(s, evalContext, {
            kind: "ADD",
            left: { kind: "LITERAL", value: 10 },
            right: COUNT_CHARS,
        })).toBe(13);
        // count as left, literal as right
        expect(evalAmountExpression(s, evalContext, {
            kind: "ADD",
            left: COUNT_CHARS,
            right: { kind: "LITERAL", value: 10 },
        })).toBe(13);
    });
});

describe("SUBTRACT", () => {
    it("subtracts two positive literal values", () => {
        const expression: AmountExpression = {
            kind: "SUBTRACT",
            left: { kind: "LITERAL", value: 10 },
            right: { kind: "LITERAL", value: 4 }
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(6);
    });
    it("subtracts a positive literal and a negative literal", () => {
        const expression: AmountExpression = {
            kind: "SUBTRACT",
            left: { kind: "LITERAL", value: 5 },
            right: { kind: "LITERAL", value: -3 },
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(8);
    });
    it("subtracts two negative literals", () => {
        const expression: AmountExpression = {
            kind: "SUBTRACT",
            left: { kind: "LITERAL", value: -5 },
            right: { kind: "LITERAL", value: -3 },
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(-2);
    });
    it("subtracts a literal and a count expression", () => {
        const s = charsInPlay(2, 1); // COUNT_CHARS === 3
        // literal as left, count as right
        expect(evalAmountExpression(s, evalContext, {
            kind: "SUBTRACT",
            left: { kind: "LITERAL", value: 10 },
            right: COUNT_CHARS,
        })).toBe(7);
        // count as left, literal as right
        expect(evalAmountExpression(s, evalContext, {
            kind: "SUBTRACT",
            left: COUNT_CHARS,
            right: { kind: "LITERAL", value: 10 },
        })).toBe(-7);
    });
});

describe("MULTIPLY", () => {
    it("multiplies two positive literal values", () => {
        const expression: AmountExpression = {
            kind: "MULTIPLY",
            left: { kind: "LITERAL", value: 3 },
            right: { kind: "LITERAL", value: 5 }
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(15);
    });
    it("multiplies a positive literal and a negative literal", () => {
        const expression: AmountExpression = {
            kind: "MULTIPLY",
            left: { kind: "LITERAL", value: 3 },
            right: { kind: "LITERAL", value: -4 },
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(-12);
    });
    it("multiplies two negative literals", () => {
        const expression: AmountExpression = {
            kind: "MULTIPLY",
            left: { kind: "LITERAL", value: -3 },
            right: { kind: "LITERAL", value: -4 },
        };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(12);
    });
    it("multiplies a literal and a count expression", () => {
        const s = charsInPlay(2, 1); // COUNT_CHARS === 3
        // literal as left, count as right
        expect(evalAmountExpression(s, evalContext, {
            kind: "MULTIPLY",
            left: { kind: "LITERAL", value: 10 },
            right: COUNT_CHARS,
        })).toBe(30);
        // count as left, literal as right
        expect(evalAmountExpression(s, evalContext, {
            kind: "MULTIPLY",
            left: COUNT_CHARS,
            right: { kind: "LITERAL", value: 10 },
        })).toBe(30);
    });
});

// Nested composition — arithmetic over counts and literals resolves recursively.
describe("nested composition", () => {
    it("evaluates (count + 1) * 2", () => {
        const s = charsInPlay(2, 1); // COUNT_CHARS === 3
        const expression: AmountExpression = {
            kind: "MULTIPLY",
            left: { kind: "ADD", left: COUNT_CHARS, right: { kind: "LITERAL", value: 1 } },
            right: { kind: "LITERAL", value: 2 },
        };
        expect(evalAmountExpression(s, evalContext, expression)).toBe(8);
    });
});
