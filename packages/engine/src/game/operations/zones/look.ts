import type { GameState, PlayerId, SignalCause, CardInstanceId, DonInstance, StackPosition, Zone } from "../../../types";
import { moveCard, getZoneArray, attachDon, detachDon, getCardInstance } from "../../mechanics";
import { emit } from "../../emitter";
import { InvalidActionError } from "../../../errors";
import { sendLifeToHand } from './hand';
import { setGameEnd } from '../../mechanics/gameEnd';
import { _cardsMoveToDeck } from "./deck";
import { _cardsMoveToTrash } from "./trash";
import { _cardsMoveToLife } from './life';

// LOOK Zone Operations
// Transient Effect Zone

export function _cardsMoveToLook(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], fromZone: Zone, signalCause: SignalCause): GameState {
    for (const id of instanceIds) {
        const zone = getZoneArray(state, playerId, fromZone);
        if (!zone.includes(id)) throw new InvalidActionError(`${id} not found in zone ${fromZone} of player ${playerId}`);
        const card = getCardInstance(state, id);
        if (card.class === "DON" || card.class === "LEADER") throw new InvalidActionError(`${id} has a card class of ${card.class} cannot be added to life`);
        state = moveCard(state, id, "LOOK", "TOP");
    }
    return emit(state, { type: "CARDS_SENT_TO_LOOK", instanceIds: instanceIds, fromZone: fromZone, controller: playerId, cause: signalCause });
}

export function sendTopDeckToLook(state: GameState, playerId: PlayerId, count: number, signalCause: SignalCause): GameState {
    const topDeck = [];
    // get all card ids to draw or until there are none left
    const deck = getZoneArray(state, playerId, "DECK");
    for (let i = 0; i < count; i++) {
        if (!deck[i]) break;
        topDeck.push(deck[i]);
    }
    if (topDeck.length === 0) return state;
    return _cardsMoveToLook(state, playerId, topDeck, "DECK", signalCause);
}

export function sendLookToDeck(state: GameState, playerId: PlayerId, position: StackPosition, signalCause: SignalCause): GameState {
    const look = getZoneArray(state, playerId, "LOOK");
    return _cardsMoveToDeck(state, playerId, look, "LOOK", position, signalCause);
}

export function sendLookToTrash(state: GameState, playerId: PlayerId, signalCause: SignalCause): GameState {
    const look = getZoneArray(state, playerId, "LOOK");
    return _cardsMoveToTrash(state, playerId, look, "LOOK", signalCause);
}

export function sendLookToLife(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], position: StackPosition, signalCause: SignalCause): GameState {
    return _cardsMoveToLife(state, playerId, instanceIds, "LOOK", position, signalCause);
}