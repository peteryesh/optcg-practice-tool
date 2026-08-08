import type { GameState, PlayerId, SignalCause, CardInstanceId, DonInstance, StackPosition, Zone } from "../../../types";
import { moveCard, getZoneArray, attachDon, detachDon, getCardInstance } from "../../mechanics";
import { emit } from "../../emitter";
import { InvalidActionError } from "../../../errors";
import { _cardsMoveToHand, sendLifeToHand } from './hand';
import { _cardsMoveToTrash } from './trash';
import { captureSnapshot } from "../../snapshot";

// TRIGGER Zone Operations
// Transient Effect Zone

export function sendTopLifeToTrigger(state: GameState, playerId: PlayerId, signalCause: SignalCause): GameState {
    const life = getZoneArray(state, playerId, "LIFE");
    if (life.length <= 0) throw new InvalidActionError(`${playerId} has no life to consider for trigger`);
    const topLife = life[0];
    // Before the move: a life card is face-down in LIFE and face-up in TRIGGER, so
    // its flipped state at capture is part of what the signal reports.
    const subject = captureSnapshot(state, topLife);
    state = moveCard(state, topLife, "TRIGGER", "TOP");
    return emit(state, { type: "CARD_SENT_TO_TRIGGER", subjects: [subject], fromZone: "LIFE", controller: playerId, cause: signalCause });
}

export function sendTriggerToTrash(state: GameState, playerId: PlayerId, signalCause: SignalCause): GameState {
    const triggerZone = getZoneArray(state, playerId, "TRIGGER");
    if (triggerZone.length !== 1) throw new InvalidActionError(`Trigger zone has an invalid amount of card ids: ${triggerZone.length}`);
    return _cardsMoveToTrash(state, playerId, triggerZone, "TRIGGER", signalCause);
}

export function sendTriggerToHand(state: GameState, playerId: PlayerId, signalCause: SignalCause): GameState {
    const triggerZone = getZoneArray(state, playerId, "TRIGGER");
    if (triggerZone.length !== 1) throw new InvalidActionError(`Trigger zone has an invalid amount of card ids: ${triggerZone.length}`);
    return _cardsMoveToHand(state, playerId, triggerZone, "TRIGGER", signalCause);
}