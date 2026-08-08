import { InvalidActionError } from "../../../errors";
import type { CardSnapshot, GameState, PlayerId, CardInstanceId, StackPosition, SignalCause, Zone } from "../../../types";
import { emit } from "../../emitter";
import { getCardInstance, getZoneArray, moveCard } from "../../mechanics";
import { captureSnapshot } from "../../snapshot";


export function _cardsMoveToTrash(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], fromZone: Zone, signalCause: SignalCause): GameState {
    const subjects: CardSnapshot[] = [];
    for (const id of instanceIds) {
        const zone = getZoneArray(state, playerId, fromZone);
        if (!zone.includes(id)) {
            throw new InvalidActionError(`${id} not found in zone of player ${playerId}`);
        }
        const card = getCardInstance(state, id);
        if (card.class === "DON" || card.class === "LEADER") throw new InvalidActionError(`${id} has a card class of ${card.class} cannot be added to trash`);
        // Captured BEFORE the move — a character trashed from the field loses its
        // attached DON on the way out, and this is the last moment its real power
        // is readable.
        subjects.push(captureSnapshot(state, id));
        state = moveCard(state, id, "TRASH", "TOP");
    }
    return emit(state, { type: "CARDS_SENT_TO_TRASH", subjects: subjects, fromZone: "HAND", controller: playerId, cause: signalCause });
}

/**
 * Discards one or more cards from a player's hand and moves them to the player's trash
 * @param state - Game state
 * @param playerId - Player to discard cards from
 * @param instanceIds - Array of card ids to discard
 * @param signalCause - Cause of discard action
 * @returns Game state with the cards specified discarded from the player's hand
 */
export function sendHandToTrash(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], signalCause: SignalCause): GameState {
    return _cardsMoveToTrash(state, playerId, instanceIds, "HAND", signalCause);
}

export function sendTopDeckToTrash(state: GameState, playerId: PlayerId, count: number, signalCause: SignalCause): GameState {
    const topDeck = [];
    // get all card ids to draw or until there are none left
    const deck = getZoneArray(state, playerId, "DECK");
    for (let i = 0; i < count; i++) {
        if (!deck[i]) break;
        topDeck.push(deck[i]);
    }
    if (topDeck.length === 0) return state;
    return _cardsMoveToTrash(state, playerId, topDeck, "DECK", signalCause);
}

export function sendTopLifeToTrash(state: GameState, playerId: PlayerId, count: number, signalCause: SignalCause): GameState {
    const topLife = [];
    const lifeZone = getZoneArray(state, playerId, "LIFE");
    for (let i = 0; i < count; i++) {
        if(!lifeZone[i]) break;
        topLife.push(lifeZone[i]);
    }
    if (topLife.length === 0) return state;
    return _cardsMoveToTrash(state, playerId, topLife, "LIFE", signalCause);
}