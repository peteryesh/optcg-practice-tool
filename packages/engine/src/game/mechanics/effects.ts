import { produce } from "immer";
import { CardInstanceId, CardSnapshot, EffectContext, EffectId, GameState, PlayerId } from "../../types";
import { getCardDef } from "./helpers";

// Builds the effect in its FINAL shape at staging. There is no lighter intermediate
// form to promote from later — see the note on EffectContext for why the reference
// split was removed.
//
// `steps` and `condition` are references into the card definition, which is immutable
// for the life of the game, so this allocates a small object and nothing more.
//
// `subjects` arrives already filtered by the activation's SubjectMatch and is stored
// verbatim. Storing it here rather than re-deriving it at resolution is the point: by
// then the board has moved on, and re-running the filter would read a post-mutation
// world. What the effect carries is what satisfied the filter at signal time.
export function stageEffect(state: GameState, playerId: PlayerId, instanceId: CardInstanceId, effectId: EffectId, subjects: CardSnapshot[]): GameState {
    const cardDef = getCardDef(state, instanceId);
    if (!cardDef.effectDefs) throw new Error(`${instanceId} does not have an effect on its card definition on ${cardDef.id}`);
    const effectDef = cardDef.effectDefs[effectId];
    if (!effectDef) throw new Error(`${cardDef.id} has no effect ${effectId}`);
    const effectContext: EffectContext = {
        playerId: playerId,
        effectId: effectId,
        instanceId: instanceId,
        condition: effectDef.condition,
        steps: effectDef.steps,
        subjects: subjects,
        cursor: 0,
        locals: {},
    };
    return produce(state, draft => {
        draft.stagingFrame[playerId].push(effectContext);
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

// Move an already-built effect out of the queue and make it current. No transform:
// the object in the frame IS the object that resolves.
//
// The index is computed against `state` rather than `draft` on purpose. Immer hands
// back proxies for drafted elements, so `draft.array.indexOf(original)` would never
// match; reading the plain array first lets object identity do the work. Identity is
// also what makes this exact — matching on `instanceId` alone picked the wrong entry
// whenever one card staged two effects.
export function promoteEffect(state: GameState, effectContext: EffectContext): GameState {
    if (!state.effectQueue[0]) throw new Error(`No effect frame found in the queue`);
    const playerId = effectContext.playerId;
    const idx = state.effectQueue[0][playerId].indexOf(effectContext);
    if (idx < 0) throw new Error(`Effect ${effectContext.effectId} on ${effectContext.instanceId} is not in the current frame for ${playerId}`);
    return produce(state, draft => {
        draft.effectQueue[0][playerId].splice(idx, 1);
        draft.currentEffect = effectContext;
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