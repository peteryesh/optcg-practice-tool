import { produce } from "immer";
import { CardInstanceId, EffectContext, EffectDef, EffectId, EffectRef, GameState, PlayerId } from "../../types";
import { getCardDef, getCardInstance } from "./helpers";

export function stageEffectRef(state: GameState, playerId: PlayerId, instanceId: CardInstanceId, effectId: EffectId, subjects: CardInstanceId[]): GameState {
    const cardDef = getCardDef(state, instanceId);
    if (!cardDef.effectDefs) throw new Error(`${instanceId} does not have an effect on its card definition on ${cardDef.id}`);
    const effectRef = {
        cardId: cardDef.id,
        effectId: effectId,
        instanceId: instanceId
    }
    return produce(state, draft => {
        draft.stagingFrame[playerId].push(effectRef);
    })
}

export function commitEffectFrame(state: GameState): GameState {
    return produce(state, draft => {
        draft.effectQueue.push(draft.stagingFrame);
        draft.stagingFrame = Object.fromEntries(state.config.playerIds.map(id => [id, []]));
    });
}

export function removeCurrentFrame(state: GameState): GameState {
    return produce(state, draft => {
        draft.effectQueue.shift();
    });
}

export function promoteEffect(state: GameState, effectRef: EffectRef): GameState {
    const card = getCardInstance(state, effectRef.instanceId);
    const effectDefs = state.definitions[effectRef.cardId].effectDefs;
    if (!effectDefs) throw new Error(`No effect def found for card id ${effectRef.cardId}`);
    if (!state.effectQueue[0]) throw new Error(`No effect frame found in the queue`);
    return produce(state, draft => {
        const idx = state.effectQueue[0][card.controller].map(ref => ref.instanceId).indexOf(effectRef.instanceId);
        if (idx < 0) throw new Error(`No effect ref that matched instance ${card.instanceId}`)
        draft.effectQueue[0][card.controller].splice(idx, 1);
        const effectDef = effectDefs[effectRef.effectId];
        draft.currentEffect = buildCurrentEffect(state, effectRef, effectDef);
    });
}

export function clearCurrentEffect(state: GameState): GameState {
    return produce(state, draft => {
        draft.currentEffect = null;
    });
}

export function advanceEffectCursor(state: GameState): GameState {
    return produce(state, draft => {
        if (!draft.currentEffect) throw new Error(`Cannot advance the cursor with no current effect`);
        draft.currentEffect.cursor += 1;
    });
}

function buildCurrentEffect(state: GameState, effectRef: EffectRef, effectDef: EffectDef): EffectContext {
    return {
        playerId: getCardInstance(state, effectRef.instanceId).controller,
        effectId: effectRef.effectId,
        instanceId: effectRef.instanceId,
        condition: effectDef.condition,
        steps: effectDef.steps,
        cursor: 0,
        locals: {}
    }
}