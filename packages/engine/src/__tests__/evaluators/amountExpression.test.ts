import { describe, it, expect, beforeEach } from "vitest";
import { AmountExpression } from "../../types";
import { evalAmountExpression } from "../../evaluator";


describe("LITERAL", () => {
    it("returns the literal value", () => {
        const expression: AmountExpression = { kind: "LITERAL", value: 5 };
        expect(evalAmountExpression(state, evalContext, expression)).toBe(5);
    });
});

describe("COUNT", () => {
    it("counts cards in zones for both players (filter kind ANY)", () => {});
    it("counts cards in zones for self only (filter kind CONTROLLER:SELF)", () => {});
    it("counts cards in zones for opponent only (filter kind CONTROLLER:OPPONENT)", () => {});
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
    it("adds a positive literal and a negative literal", () => {});
    it("adds two negative literals", () => {});
    it("adds a literal and a count expression", () => {
        // literal as left, count as right
        // count as left, literal as right
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
    it("subtracts a positive literal and a negative literal", () => {});
    it("subtracts two negative literals", () => {});
    it("subtracts a literal and a count expression", () => {
        // literal as left, count as right
        // count as left, literal as right
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
    it("multiplies a positive literal and a negative literal", () => {});
    it("multiplies two negative literals", () => {});
    it("multiplies a literal and a count expression", () => {
        // literal as left, count as right
        // count as left, literal as right
    });
});

// Unsure what this is supposed to represent right now
it.todo("RANGE", () => {});