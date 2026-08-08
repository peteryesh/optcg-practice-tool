import { InvalidActionError } from "../../../errors";
import { CardSnapshot, GameState, PlayerId, SignalCause, CardInstanceId, Zone, StackPosition } from "../../../types";
import { emit } from "../../emitter";
import { getCardInstance, getZoneArray, moveCard } from "../../mechanics";
import { captureSnapshot } from "../../snapshot";


export function _cardsMoveToHand(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], fromZone: Zone, signalCause: SignalCause): GameState {
    const subjects: CardSnapshot[] = [];
    for (const id of instanceIds) {
        const zone = getZoneArray(state, playerId, fromZone);
        if (!zone.includes(id)) throw new InvalidActionError(`${id} not found in zone ${fromZone} of player ${playerId}`);
        const card = getCardInstance(state, id);
        if (card.class === "DON" || card.class === "LEADER") throw new InvalidActionError(`${id} has a card class of ${card.class} cannot be added to hand`);
        // Before the move: a character bounced off the field reads base stats once it
        // is in hand, so the on-field power is only recoverable from here.
        subjects.push(captureSnapshot(state, id));
        state = moveCard(state, id, "HAND", "TOP");
    }
    return emit(state, { type: "CARDS_SENT_TO_HAND", subjects: subjects, fromZone: fromZone, controller: playerId, cause: signalCause });
}

/**
 * Draws one or more cards to a player's hand. Order is not important but is maintained for replay purposes.
 * Note: end result should be top card in hand is most recent card drawn.
 * @param state - Game state
 * @param playerId - Player to draw cards for
 * @param count - Number of cards to draw
 * @param signalCause - Reason for drawing cards (game rule or card effect)
 * @returns Game state with cards drawn from the deck and placed into the target player's hand
 */
export function cardsDraw(state: GameState, playerId: PlayerId, count: number, signalCause: SignalCause): GameState {
    const cardsToDraw = [];
    // get all card ids to draw or until there are none left
    const deck = getZoneArray(state, playerId, "DECK");
    for (let i = 0; i < count; i++) {
        if (!deck[i]) break;
        cardsToDraw.push(deck[i]);
    }
    if (cardsToDraw.length === 0) return state;
    return _cardsMoveToHand(state, playerId, cardsToDraw, "DECK", signalCause);
}

export function sendTrashToHand(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], signalCause: SignalCause): GameState {
    return _cardsMoveToHand(state, playerId, instanceIds, "TRASH", signalCause);
}

// Meant to send a single card from life to hand (top or bottom)
export function sendLifeToHand(state: GameState, playerId: PlayerId, lifePosition: StackPosition, signalCause: SignalCause): GameState {
    const lifeZone = getZoneArray(state, playerId, "LIFE");
    const lifeCardId = lifePosition === "TOP" ? lifeZone[0] : lifeZone.at(-1);
    if (!lifeCardId) return state;

    return _cardsMoveToHand(state, playerId, [lifeCardId], "LIFE", signalCause);
}