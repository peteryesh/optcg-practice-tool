import { produce } from 'immer';
import type { CardInstanceId, EffectId, EffectRef, GameAction, GameSignal, GameState, PlayerId } from '../types';
import { getCardDef, getCardInstance, setGameEnd, stageEffectRef } from './mechanics';

export function emit(state: GameState, signal: GameSignal): GameState {
    state = produce(state, draft => {
        draft.gameLog.push({ kind: "SIGNAL", signal });
    });
    
    // lethal damage check
    if (signal.type === "LETHAL_DAMAGE_TAKEN" && (signal.cause.kind === "BATTLE" || signal.cause.kind === "EFFECT") && state.playerZones[signal.controller].life.length === 0) {
        const causeCard = getCardInstance(state, signal.cause.sourceId);
        if (!causeCard) throw new Error(`No card instance for card cause when resolving lethal damage`);
        return setGameEnd(state, causeCard.controller, "KNOCKOUT");
    }

    // deckout check
    for (const player of Object.keys(state.playerZones)) {
        if (state.playerZones[player].deck.length <= 0) {
            const twoPlayerWinner = state.turnOrder.filter(playerId => playerId !== player);
            return setGameEnd(state, twoPlayerWinner[0], "DECKOUT");
        }
    }

    // stage the effects activated off this signal
    for (const instanceId of getListenerInstanceIds(state)) {
        const card = getCardInstance(state, instanceId);
        const cardDef = getCardDef(state, instanceId);
        if (!cardDef.effectDefs) throw new Error(`${instanceId} has no effect on its card definition: ${cardDef.id}`);
        for (const effectId of Object.keys(cardDef.effectDefs)) {
            if (!cardDef.effectDefs[effectId].activatingSignals.includes(signal.type)) 
                continue;
            // if (board state does not meet activation condition)
            //     continue;
            // if (active zone does not match)
            //     continue;
            state = stageEffectRef(state, card.controller, instanceId, effectId);
        }
    }
    return state;
}

function getListenerInstanceIds(state: GameState): CardInstanceId[] {
    return Object.keys(state.instances).filter(instanceId => {
        const cardDef = getCardDef(state, instanceId);
        return state.instances[instanceId].class !== "DON" && cardDef.effectDefs !== null && cardDef.effectDefs !== undefined;
    });
}