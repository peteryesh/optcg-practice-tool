import { GameState, PlayerId, SignalCause, CardInstanceId, DonInstance, StackPosition, Zone, PlayCause, Card, Phase } from "../../types";
import { moveCard, removeFromZone, getZoneArray, setActive, setRested, insertCardAtZoneIndex } from "../mechanics";
import { emit } from "../emitter";
import { InvalidActionError } from "../../errors";
import { sendHandToTrash } from './zones/trash';
import { cardsSetRested, removeCardsFromField } from './cards';
import { calculatePower, calculateCounter } from '../calculations';
import { takeDamage } from './zones/life';
import { logCurrentBattleForTurn, removeCurrentBattle, updateCurrentBattle } from '../mechanics/combat';
import { enterBattleResolutionPhase, enterCounterPhase } from './phase';
import { getCardInstance } from "../mechanics";

export function declareAttack(state: GameState, playerId: PlayerId, attackerId: CardInstanceId, defenderId: CardInstanceId): GameState {
    if (state.currentBattle) throw new InvalidActionError(`Attempting to declare an attack when a battle is taking place`);
    state = updateCurrentBattle(state, {attackerId: attackerId, defenderId: defenderId, counter: 0});
    const attacker = getCardInstance(state, attackerId);
    const defender = getCardInstance(state, defenderId);
    if (attacker.controller !== playerId) throw new InvalidActionError(`Player ${playerId} does not control attacker ${attackerId}`);
    if (defender.controller === playerId) throw new InvalidActionError(`Player ${playerId} cannot control defender ${defenderId} in battle`);
    // STATUS EFFECT: If the card has a status that does not allow it to attack or rest, it cannot attack
    // STATUS EFFECT: If a card exists that says "can only attack this card" then all other targets should be invalid
    if (attacker.currentZone !== "CHARACTERS" && attacker.currentZone !== "LEADER") throw new InvalidActionError(`Attacker ${attackerId} is not in the CHARACTERS or LEADER zone`);
    if (attacker.class !== "CHARACTER" && attacker.class !== "LEADER") throw new InvalidActionError(`Attacker ${attackerId} is not a character or leader`);
    if (attacker.isRested) throw new InvalidActionError(`${attackerId} is rested and cannot declare an attack`);
    // STATUS EFFECT: Rush, character rush
    if (state.cardsPlayedThisTurn.includes(attackerId)) throw new InvalidActionError(`${attackerId} was played this turn and does not have rush`)
    // STATUS EFFECT: Need a check here for if a status effect is applied to the card that restricts its ability to attack
    if (defender.currentZone !== "CHARACTERS" && defender.currentZone !== "LEADER") throw new InvalidActionError(`Defender ${defenderId} is not in the CHARACTERS zone`);
    // STATUS EFFECT: If the defender is standing, need to check if a status effect allows to attack active characters
    if (defender.class === "CHARACTER" && !defender.isRested) throw new InvalidActionError(`${defenderId} is an active character and ${attackerId} does not have the ability to attack active characters`);
    state = cardsSetRested(state, playerId, [attackerId], { kind: "RULE" });
    return emit(state, { type: "ATTACK_DECLARED", attackerId, defenderId, controller: playerId, cause: { kind: "PLAYER" } });

}

export function declareBlocker(state: GameState, playerId: PlayerId, blockerId: CardInstanceId): GameState {
    const battle = state.currentBattle;
    if (!battle) throw new InvalidActionError(`No current battle exists`);
    const prevDefenderId = battle.defenderId;
    if (!prevDefenderId) throw new InvalidActionError(`No previous defender, battle is corrupt`);
    const blocker = getCardInstance(state, blockerId);
    state = updateCurrentBattle(state, {...battle, defenderId: blockerId});
    if (blocker.controller !== playerId) throw new InvalidActionError(`Player ${playerId} does not control new target ${blockerId}`);
    // STATUS EFFECT: cannot block, cannot rest
    if (blocker.currentZone !== "CHARACTERS" && blocker.currentZone !== "LEADER") throw new InvalidActionError(`Blocker ${blockerId} is not in the CHARACTERS zone`);
    if (blocker.isRested) throw new InvalidActionError(`${blockerId} is rested and cannot block`);
    state = cardsSetRested(state, playerId, [blockerId], { kind: "RULE" });
    state = emit(state, { type: "BLOCKER_DECLARED", blockerId, attackerId: battle.attackerId, prevDefenderId: prevDefenderId, controller: playerId, cause: { kind: "PLAYER" } });
    return enterCounterPhase(state);
}

export function redirectAttack(state: GameState, playerId: PlayerId, newTargetId: CardInstanceId, signalCause: SignalCause): GameState {
    const battle = state.currentBattle;
    if (!battle) throw new InvalidActionError(`No current battle exists`);
    const prevDefenderId = battle.defenderId;
    if (!prevDefenderId) throw new InvalidActionError(`No previous defender, battle is corrupt`);
    const newTarget = getCardInstance(state, newTargetId);
    state = updateCurrentBattle(state, {...battle, defenderId: newTargetId});
    if (newTarget.controller !== playerId) throw new InvalidActionError(`Player ${playerId} does not control new target ${newTargetId}`);
    if (newTarget.currentZone !== "CHARACTERS" && newTarget.currentZone !== "LEADER") throw new InvalidActionError(`New target ${newTargetId} is not in the CHARACTERS zone`);
    return emit(state, { type: "ATTACK_REDIRECTED", attackerId: battle.attackerId, fromDefenderId: prevDefenderId, toDefenderId: newTargetId, cause: signalCause });
}

export function playCounter(state: GameState, playerId: PlayerId, counterCardId: CardInstanceId): GameState {
    const derivedCounter = calculateCounter(state, counterCardId); // incomplete, need to update calculateCounter
    if (derivedCounter <= 0) throw new InvalidActionError(`Card ${counterCardId} has no counter value and cannot be played as a counter`);
    const counterCard = getCardInstance(state, counterCardId);
    if (counterCard.controller !== playerId) throw new InvalidActionError(`${counterCardId} is not owned by the defending player`);
    const battle = state.currentBattle;
    if (!battle) throw new InvalidActionError(`No current battle found, battle is corrupt`);
    state = updateCurrentBattle(state, {...battle, counter: battle.counter + derivedCounter});
    state = sendHandToTrash(state, playerId, [counterCardId], { kind: "PLAYER" });
    return emit(state, { type: "COUNTER_PLAYED", counterId: counterCardId, battle: battle, controller: playerId, cause: { kind: "PLAYER" } })
}

export function resolveBattle(state: GameState): GameState {
    state = logCurrentBattleForTurn(state);
    const battle = state.currentBattle;
    if (!battle) throw new InvalidActionError(`No current battle exists`);
    const attacker = getCardInstance(state, battle.attackerId);
    const defender = getCardInstance(state, battle.defenderId);
    if (attacker.class !== "LEADER" && attacker.class !== "CHARACTER") throw new InvalidActionError(`Not a valid attacker, current battle is corrupt`);
    if (defender.class !== "LEADER" && defender.class !== "CHARACTER") throw new InvalidActionError(`Not a valid defender, current battle is corrupt`);
    state = removeCurrentBattle(state);
    const attackerPower = calculatePower(state, battle.attackerId);
    const defenderPower = calculatePower(state, battle.defenderId);
    if (attackerPower >= defenderPower + battle.counter) {
        // leader hit
        // STATUS EFFECT: if attacker has banish, send life to trash and do not deal damage
        // STATUS EFFECT: if attacker has double attack, deal damage with a count of 2
        if (defender.class === "LEADER") {
            state = emit(state, { type: "BATTLE_RESOLVED", battle: battle, attackerPower: attackerPower, defenderPower: defenderPower + battle.counter, outcome: "HIT", cause: { kind: "BATTLE", sourceId: battle.attackerId } });
            return takeDamage(state, defender.controller, { kind: "BATTLE", sourceId: battle.attackerId });
        }
        if (defender.class === "CHARACTER") {
            state = emit(state, { type: "BATTLE_RESOLVED", battle: battle, attackerPower: attackerPower, defenderPower: defenderPower + battle.counter, outcome: "HIT", cause: { kind: "BATTLE", sourceId: battle.attackerId } });
            return removeCardsFromField(state, defender.controller, [battle.defenderId], "KO", "TOP", { kind: "BATTLE", sourceId: battle.attackerId });
        }
    }
    return emit(state, { type: "BATTLE_RESOLVED", battle: battle, attackerPower: attackerPower, defenderPower: defenderPower + battle.counter, outcome: "FAIL", cause: { kind: "BATTLE", sourceId: battle.attackerId } });
}