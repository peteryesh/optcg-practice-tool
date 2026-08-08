import { produce } from 'immer';
import type { GameState } from './types/state';
import type { GameAction } from './types/action';
import { validate } from './validator';
import { InvalidActionError } from './errors';
import { 
    applyActivateEffect,
    applyPlayCard,
    applyAttachDon,
    applyDeclareAttack,
    applyDeclareBlocker,
    applyPlayCounter,
    applyCompleteBattle,
    applyNextPhase,
    applyTriggerActivation,
    applyDisplaceCardOnField
} from './game/actions/main';
import { setPlayerLife, shuffleDeck } from './game/actions/start';
import { commitEffectFrame, getCardInstance, promoteEffect, removeCurrentFrame, removeDecisionPoint, setDecisionPoint, setGameEnd } from './game/mechanics';
import { advanceEffect } from './game/effects';
import { enterStartGamePhase, cardsDraw, enterStartOfTurnPhase, setStartTurnState, enterRefreshPhase, enterDrawPhase, enterMainPhase, enterOnOpponentAttackPhase, enterBlockerPhase, enterCounterPhase, enterBattleResolutionPhase, enterWhenAttackingPhase } from './game/operations';
import { OPENING_HAND_SIZE } from './game/constants';
import type { Phase } from './types';

export function advance(state: GameState): GameState {
    let s = state;
    while (!s.decisionPoint && !s.winner) s = step(s);
    return s;
}

function step(state: GameState): GameState {
    // A promoted effect runs to completion before anything else is considered —
    // ahead of the Trigger mechanic and ahead of committing a new staging frame.
    if (state.currentEffect !== null) {
        return advanceEffect(state);
    }

    // check both players for trigger
    for (const player of Object.keys(state.playerZones)) {
        // Must resolve current effect before considering triggers
        if (state.playerZones[player].trigger.length > 0) {
            return setDecisionPoint(state, { type: "TRIGGER", player: player });
        }
    }

    // commit the frame if there are effects in the frame
    for (const staged of Object.values(state.stagingFrame)) {
        if (staged.length > 0) {
            state = commitEffectFrame(state);
            break;
        }
    }

    // effect selection sequence
    if (state.effectQueue.length > 0) {
        // check turn player first
        // promote effect or set decisionPoint to choose next effect
        const turnPlayerIdx = state.turnOrder.indexOf(state.turnPlayerId);
        for (let i = 0; i < state.turnOrder.length; i++) {
            let currIdx = (i + turnPlayerIdx) % state.turnOrder.length;
            const playerId = state.turnOrder[currIdx];
            const frame = state.effectQueue[0];
            if (frame[playerId].length === 1) {
                // auto promote and pop — the queued object is passed straight
                // through, and promoteEffect finds it by identity.
                return promoteEffect(state, frame[playerId][0]);
            }
            if (frame[playerId].length > 1) {
                // set decisionPoint to select next effect and return
                return setDecisionPoint(state, { type: "RESOLVE_EFFECT_ORDER", player: playerId });
            }
        }
        // pop the frame off the queue
        return removeCurrentFrame(state);
    }

    // handle state changes
    switch (state.phase) {
        case "SETUP":
            if (!state.setup.firstPlayer) {
                return setDecisionPoint(state, { type: "SELECT_FIRST_PLAYER", player: state.setup.coinFlipWinner });
            }
            return enterStartGamePhase(state);
        case "START_GAME":
            for (const playerId of state.turnOrder) {
                // deal starting hand, this is the only point that start game and empty hand will be true
                if (state.playerZones[playerId].hand.length <= 0) {
                    state = shuffleDeck(state, playerId);
                    state = cardsDraw(state, playerId, OPENING_HAND_SIZE, { kind: "RULE" });
                }
                // return if any player has not made mulligan decision
                if (state.setup.mulligan[playerId] === "PENDING") {
                    return setDecisionPoint(state, { type: "MULLIGAN", player: playerId });
                }
            }
            // All players have mulliganed or kept, set life and continue
            for (const playerId of state.turnOrder) {
                state = setPlayerLife(state, playerId);
            }
            return enterStartOfTurnPhase(state);
        case "START_OF_TURN":
            state = setStartTurnState(state);
            return enterRefreshPhase(state);
        case "REFRESH":
            return enterDrawPhase(state);
        case "DRAW":
            return enterMainPhase(state);
        case "MAIN":
            if (state.currentBattle !== null) {
                return enterWhenAttackingPhase(state);
            }
            return setDecisionPoint(state, { type: "MAIN_ACTION", player: state.turnPlayerId });
        case "WHEN_ATTACKING":
            return enterOnOpponentAttackPhase(state);
        case "ON_OPPONENT_ATTACK": 
            return enterBlockerPhase(state);
        case "BLOCKER": {
            const defender = getCardInstance(state, state.currentBattle!.defenderId);
            return setDecisionPoint(state, { type: "BLOCKER_SELECTION", player: defender.controller, battle: state.currentBattle! });
        }
        case "COUNTER": {
            const defender = getCardInstance(state, state.currentBattle!.defenderId);
            // COMPLETE_BATTLE given as action if phase is counter, state is advanced by player selecting this action
            return setDecisionPoint(state, { type: "COUNTER_STEP", player: defender.controller, battle: state.currentBattle! })
        }
        case "BATTLE_RESOLUTION":
            return enterMainPhase(state);
        case "END_OF_TURN":
            return enterStartOfTurnPhase(state);
        case "GAME_END":
            break;
    }
    return state;
}
