import type { CardSnapshot, GameState, PlayerId, SignalCause, CardInstanceId, DonInstance, StackPosition, Zone } from "../../../types";
import { moveCard, getZoneArray, attachDon, detachDon, getCardInstance, setDecisionPoint } from "../../mechanics";
import { emit } from "../../emitter";
import { InvalidActionError } from "../../../errors";
import { sendLifeToHand } from './hand';
import { setGameEnd } from '../../mechanics/gameEnd';
import { sendTopLifeToTrigger } from "./trigger";
import { captureSnapshot } from "../../snapshot";


export function _cardsMoveToLife(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], fromZone: Zone, position: StackPosition, signalCause: SignalCause): GameState {
    const subjects: CardSnapshot[] = [];
    for (const id of instanceIds) {
        const zone = getZoneArray(state, playerId, fromZone);
        if (!zone.includes(id)) throw new InvalidActionError(`${id} not found in zone ${fromZone} of player ${playerId}`);
        const card = getCardInstance(state, id);
        if (card.class === "DON" || card.class === "LEADER") throw new InvalidActionError(`${id} has a card class of ${card.class} cannot be added to life`);
        subjects.push(captureSnapshot(state, id));
        state = moveCard(state, id, "LIFE", position);
    }
    return emit(state, { type: "CARDS_SENT_TO_LIFE", subjects: subjects, fromZone: fromZone, position: position, controller: playerId, cause: signalCause });
}

export function sendTopDeckToLife(state: GameState, playerId: PlayerId, count: number, position: StackPosition, signalCause: SignalCause): GameState {
    const topDeck = [];
    // get all card ids to draw or until there are none left
    const deck = getZoneArray(state, playerId, "DECK");
    for (let i = 0; i < count; i++) {
        if (!deck[i]) break;
        topDeck.push(deck[i]);
    }
    if (topDeck.length === 0) return state;
    return _cardsMoveToLife(state, playerId, topDeck, "DECK", position, signalCause);
}

export function sendTrashToLife(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], position: StackPosition, signalCause: SignalCause): GameState {
    return _cardsMoveToLife(state, playerId, instanceIds, "TRASH", position, signalCause);
}

export function sendHandToLife(state: GameState, playerId: PlayerId, instanceIds: CardInstanceId[], position: StackPosition, signalCause: SignalCause): GameState {
    return _cardsMoveToLife(state, playerId, instanceIds, "HAND", position, signalCause);
}

export function takeDamage(state: GameState, damagedPlayerId: PlayerId, signalCause: SignalCause): GameState {
    const leaderId = getZoneArray(state, damagedPlayerId, "LEADER")[0];
    if (!leaderId) throw new InvalidActionError(`No leader id found`);

    if (getZoneArray(state, damagedPlayerId, "LIFE").length === 0) {
        // emit will handle game over check
        return emit(state, { type: "LETHAL_DAMAGE_TAKEN", instanceId: leaderId, controller: damagedPlayerId, cause: signalCause });
    }
    state = emit(state, { type: "DAMAGE_TAKEN", instanceId: leaderId, controller: damagedPlayerId, cause: signalCause });
    const lifeZone = getZoneArray(state, damagedPlayerId, "LIFE");
    const topLifeCard = lifeZone[0];
    state = emit(state, { type: "LIFE_DAMAGED", instanceId: topLifeCard, controller: damagedPlayerId, cause: signalCause });
    return sendTopLifeToTrigger(state, damagedPlayerId, signalCause);
}