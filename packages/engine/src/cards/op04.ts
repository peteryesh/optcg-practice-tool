import type { EffectDef, EffectId } from "../types/effect";
import type { CardId } from "../types/primitives";

export const op04: Record<CardId, Record<EffectId, EffectDef>> = {
    // King — [On Play] Draw 1 card.
    "OP04-045": {
        onPlay: {
            activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "THIS" } }],
            activeZone: "CHARACTERS",
            oncePerTurn: false,
            steps: [
                { kind: "RESOLUTION", operation: { type: "DRAW", amount: { kind: "LITERAL", value: 1 } } },
            ],
        },
    },
};
