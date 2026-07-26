import { ALL_CARDS_URL } from "./config";
import type { Card, CardDef, DeckList } from "../types/card";
import type { CardId } from "../types/primitives";
import { effectDefsFor } from "../cards";

export async function fetchCardData(): Promise<Record<CardId, Card>> {
    const response = await fetch(`${ALL_CARDS_URL}`);
    const data = await response.json();
    return data as Record<CardId, Card>;
}

export async function getCardDefs(cardIds: CardId[]): Promise<Record<CardId, CardDef>> {
    const allCards = await fetchCardData();
    const defs: Record<CardId, CardDef> = {};
    for (const cardId of cardIds) {
        if (allCards[cardId]) {
            defs[cardId] = toCardDef(allCards[cardId]);
        } else {
            console.warn(`Card ID ${cardId} not found in database.`);
        }
    }
    return defs;
}

export async function getCardDefsFromDeckList(deckList: DeckList): Promise<Record<CardId, CardDef>> {
    const allCardIds = [deckList.leader, ...deckList.deck]; // sideDeck excluded
    return await getCardDefs(allCardIds);
}

function toCardDef(card: Card): CardDef {
    // Conversion to CardDef may or may not include effects, as that may come from anoter source
    return {
        id: card.id,
        name: card.name,
        class: card.class,
        cost: card.cost,
        power: card.power,
        counter: card.counter,
        life: card.life,
        colors: card.colors,
        types: card.types,
        attributes: card.attributes,
        aliases: card.aliases,
        restrictions: card.restrictions,
        effectDefs: effectDefsFor(card.id)
    };
}