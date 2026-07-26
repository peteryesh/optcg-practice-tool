import type { EffectDef, EffectId } from "../types/effect";
import type { CardId } from "../types/primitives";
import { op04 } from "./op04";
import { op13 } from "./op13";

// Authored effect definitions, one file per set.
//
// These are hand-written TypeScript rather than data for as long as EffectDef is
// still changing shape: a schema change then surfaces as compile errors pointing
// at every card that needs migrating, instead of as a runtime surprise in one
// game. Once the shape settles these get written into the card rows themselves
// and this directory goes away.
const cardEffects: Record<CardId, Record<EffectId, EffectDef>> = {
    ...op04,
    ...op13,
};

// The only way to read the registry. Everything goes through here so the backing
// store can change — bundled object today, per-set dynamic import or fetched JSON
// later — without touching a single caller.
//
// undefined for an unauthored card is correct, not an error: getListenerInstanceIds
// filters on effectDefs being present, so a card with no entry is simply inert.
export function effectDefsFor(cardId: CardId): Record<EffectId, EffectDef> | undefined {
    return cardEffects[cardId];
}
