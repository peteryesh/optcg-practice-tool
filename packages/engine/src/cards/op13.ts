import type { EffectDef, EffectId } from "../types/effect";
import type { CardId } from "../types/primitives";

export const op13: Record<CardId, Record<EffectId, EffectDef>> = {
    // Izo — [On Play] Draw 2 cards.
    "OP13-041": {
        onPlay: {
            activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "THIS" } } }],
            activeZone: "CHARACTERS",
            oncePerTurn: false,
            steps: [
                { kind: "RESOLUTION", operation: { type: "DRAW", amount: { kind: "LITERAL", value: 2 } } },
            ],
        },
    },
};
