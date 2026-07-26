import { produce } from 'immer';
import type { CardInstanceId, EffectId, EffectRef, EvalContext, GameAction, GameSignal, GameState, PlayerId, SignalActivation } from '../types';
import { getCardDef, getCardInstance, setGameEnd, stageEffectRef } from './mechanics';
import { evalCardFilter } from '../evaluator';

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
    const listeners = getListenerInstanceIds(state);

    // Cheap gate first: if no effect anywhere listens for this signal type, there
    // is no subject worth resolving. This ordering is what makes signalSubjects
    // safe to throw from — it never runs for the many signals nobody listens for.
    const anyListening = listeners.some(instanceId =>
        Object.values(getCardDef(state, instanceId).effectDefs ?? {})
            .some(effectDef => effectDef.activation.some(activation => activation.signal === signal.type))
    );
    if (!anyListening) return state;

    const subjects = signalSubjects(signal);

    for (const instanceId of listeners) {
        const card = getCardInstance(state, instanceId);
        const cardDef = getCardDef(state, instanceId);
        if (!cardDef.effectDefs) throw new Error(`${instanceId} has no effect on its card definition: ${cardDef.id}`);
        // The listening card is the source; the signal's subject is the candidate
        // being tested. That pairing is what makes a THIS subject mean "this very
        // card", so an opponent's copy evaluates the same filter and fails.
        const evalContext: EvalContext = { self: card.controller, source: instanceId };
        for (const effectId of Object.keys(cardDef.effectDefs)) {
            const effectDef = cardDef.effectDefs[effectId];
            // if (board state does not meet activation condition)
            //     continue;
            // Active zone gate. Listeners are scanned from every zone, decks and
            // hands included, so without this a card in the deck can activate off a
            // subject filter it happens to satisfy.
            //
            // NOTE: this reads the listener's CURRENT zone, which is only correct for
            // "on exit" effects (On K.O.) because CARD_REMOVED_FROM_FIELD is emitted
            // before the card is moved. When that ordering is normalised alongside the
            // pre-operation stage, exit effects must switch to matching signal.fromZone
            // in the same change, or they will stop staging silently.
            if (card.currentZone !== effectDef.activeZone) continue;
            // OR over activation entries — two matching entries still stage once.
            const activated = effectDef.activation.filter(activation =>
                matchesActivation(state, evalContext, signal, subjects, activation)
            );
            if (activated.length === 0) continue;
            state = stageEffectRef(state, card.controller, instanceId, effectId);
        }
    }
    return state;
}

// Does this signal satisfy everything the activation asks for?
//
// `signal` and `subject` are the gate proper; causeKind, source and fromZone are
// optional narrowings, and an omitted one matches anything — which is what keeps
// every activation written before they existed valid unchanged.
function matchesActivation(
    state: GameState,
    evalContext: EvalContext,
    signal: GameSignal,
    subjects: CardInstanceId[],
    activation: SignalActivation,
): CardInstanceId[] | null {
    if (activation.signal !== signal.type) return null;
    const matched = subjects.filter(subjectId => evalCardFilter(state, evalContext, subjectId, activation.subject));
    if (matched.length === 0) return null;
    
    // Not every signal carries an origin. Asking for one that the signal cannot
    // report is a definition error, so it fails rather than matching by default.
    if (activation.fromZone) {
        if (!("fromZone" in signal)) return null;
        if (!activation.fromZone.includes(signal.fromZone)) return null;
    }

    if (activation.causeKind && !activation.causeKind.includes(signal.cause.kind)) return null;

    if (activation.source) {
        // PLAYER, RULE and OVERFLOW causes name no card, so a source filter has
        // nothing to test — the case a bare CardFilter cannot tell apart from a
        // mismatch, and the reason causeKind and source are separate fields.
        if (!("sourceId" in signal.cause)) return null;
        if (!evalCardFilter(state, evalContext, signal.cause.sourceId, activation.source)) return null;
    }

    return matched;
}

// Which card(s) a signal is about, so the staging gate has a candidate to test
// EffectDef.activation[].subject against. Pure: signal in, instance ids out.
//
// Signals name their cards under different field names (instanceId, instanceIds,
// attackerId/defenderId), so this is the one place that heterogeneity is resolved.
//
// Only called once emit has confirmed an effect listens for this signal type, so
// throwing on an unhandled case reports a card asking for semantics that do not
// exist yet, rather than crashing on the hundreds of signals nobody listens to.
export function signalSubjects(signal: GameSignal): CardInstanceId[] {
    switch (signal.type) {
        // A single card in a single role.
        case "CHARACTER_PLAYED":
        case "STAGE_PLAYED":
        case "EVENT_PLAYED":
            return [signal.instanceId];

        // Multi-card movement signals
        case "CARDS_SENT_TO_TRASH":
        case "CARDS_SENT_TO_HAND":
        case "CARDS_SENT_TO_DECK":
        case "CARDS_SENT_TO_LIFE":
        case "CARDS_SENT_TO_LOOK":
            return signal.instanceIds;

        // Genuinely about no card. Note that staging cannot currently fire an
        // effect off a subject-less signal — `subjects.some(...)` over [] is
        // always false — so phase-keyed effects do not activate yet.
        case "PHASE_CHANGED":
            return [];

        // Everything else names cards in more than one role (attacker vs defender,
        // blocker vs attacker), or names many at once. Both are deferred: the role
        // question with combat effects, the multi-card question with fan-out-vs-once
        // and LKI snapshots.
        default:
            throw new Error(`signalSubjects has no subject mapping for signal type ${signal.type}`);
    }
}

function getListenerInstanceIds(state: GameState): CardInstanceId[] {
    return Object.keys(state.instances).filter(instanceId => {
        // DON must be filtered BEFORE the lookup — getCardDef throws for DON, and
        // any board with DON on it emits signals (DON_RESTED when paying a cost).
        if (state.instances[instanceId].class === "DON") return false;
        const cardDef = getCardDef(state, instanceId);
        return cardDef.effectDefs !== null && cardDef.effectDefs !== undefined;
    });
}