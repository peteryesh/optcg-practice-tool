import { produce } from 'immer';
import type { GameState, DecisionPoint } from '../types/state';
import type { PlayerId } from '../types/primitives';
import type { EffectStep } from '../types/effect';
import type { CardFilter } from '../types/expression';

// REMOVE

// Called after any operation that may have staged new effects.
// Decides whether to auto-promote, request player ordering, or do nothing.
export function processEffects(state: GameState): GameState {
    if (state.currentEffect !== null) return state;

    const orderedPlayers = [
        state.turnPlayerId,
        ...state.turnOrder.filter(id => id !== state.turnPlayerId),
    ];

    for (const playerId of orderedPlayers) {
        const staged = state.pendingEffects[playerId];
        if (!staged || staged.length === 0) continue;

        if (staged.length === 1) {
            return advanceCurrentEffect(promoteEffect(state, playerId));
        }

        return produce(state, draft => {
            draft.decisionPoint = { type: "NEXT_EFFECT", playerId };
        });
    }

    return state;
}

// Called when a player resolves a NEXT_EFFECT decision by choosing which sequence runs first.
export function promoteChosenEffect(state: GameState, playerId: PlayerId, sequenceId: string): GameState {
    return advanceCurrentEffect(promoteEffect(state, playerId, sequenceId));
}

// Advances execution of currentEffect. Runs AUTO steps inline, pauses on PLAYER steps.
// When the sequence is exhausted, clears currentEffect and calls processEffects.
export function advanceCurrentEffect(state: GameState): GameState {
    if (!state.currentEffect) return state;

    while (true) {
        const current = state.currentEffect;
        if (!current || current.steps.length === 0) break;
        const step = current.steps[0];

        if (step.type === "CONDITION") {
            const passes = evaluateCondition(state, step.check);
            const onTrue = step.onTrue;
            state = produce(state, draft => {
                draft.currentEffect!.steps.shift();
                if (passes) {
                    draft.currentEffect!.steps.unshift(...onTrue);
                }
            });
            continue;
        }

        if (step.resolution.kind === "AUTO") {
            state = executeStep(state, step);
            state = produce(state, draft => {
                draft.currentEffect!.steps.shift();
            });
            continue;
        }

        // PLAYER resolution — pause and wait for input
        return produce(state, draft => {
            draft.decisionPoint = decisionPointForStep(current, step, state);
        });
    }

    // Sequence exhausted — clear and check for more staged effects
    state = produce(state, draft => {
        draft.currentEffect = null;
    });
    return processEffects(state);
}

function promoteEffect(state: GameState, playerId: PlayerId, sequenceId?: string): GameState {
    return produce(state, draft => {
        const staged = draft.pendingEffects[playerId];
        const idx = sequenceId
            ? staged.findIndex(s => s.sequenceId === sequenceId)
            : 0;
        if (idx === -1) throw new Error(`Effect ${sequenceId} not found in staging for ${playerId}`);
        const [sequence] = staged.splice(idx, 1);
        draft.currentEffect = sequence;
    });
}

function evaluateCondition(_state: GameState, _check: CardFilter): boolean {
    // TODO: evaluate CardFilter against state
    throw new Error('evaluateCondition not yet implemented');
}

function executeStep(state: GameState, _step: EffectStep): GameState {
    // TODO: dispatch to step execution based on _step.type
    return state;
}

function decisionPointForStep(
    _sequence: EffectSequence,
    step: EffectStep,
    _state: GameState,
): DecisionPoint {
    // _state is needed to compute validTargets from step.target filter
    throw new Error(`decisionPointForStep not yet implemented for step type: ${step.type}`);
}
