import { produce } from 'immer';
import type { CardInstanceId, CardSnapshot, EvalContext, GameSignal, GameState, SignalActivation, SignalType } from '../types';
import { getCardDef, getCardInstance, setGameEnd, stageEffect } from './mechanics';
import { evalCardFilter } from '../evaluator';
import { captureSnapshot } from './snapshot';

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

    // Cheap gate first: if no effect anywhere listens for this signal type, there is
    // nothing to select subjects for. This ordering is what makes selectSubjects safe
    // to throw from — it never runs for the many signals nobody listens for, so an
    // unconverted signal only blows up when a card actually asks to hear it.
    const anyListening = listeners.some(instanceId =>
        Object.values(getCardDef(state, instanceId).effectDefs ?? {})
            .some(effectDef => effectDef.activation.some(activation => activation.signal === signal.type))
    );
    if (!anyListening) return state;

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

            // GATE AND PAYLOAD ARE SEPARATE READS of the same results, and collapsing
            // them is what previously made `[]` unrepresentable. `null` from every
            // entry means the effect did not activate; a single non-null entry means it
            // did, even when what it carries is empty.
            const results = effectDef.activation.map(activation =>
                matchesActivation(state, evalContext, signal, activation)
            );
            if (results.every(result => result === null)) continue;

            // OR over activation entries — two matching entries still stage ONCE, with
            // the union of what they carried. Deduped by identity, which works because
            // each entry filters the same carried array and so yields the same objects.
            const matchedSubjects = [...new Set(results.filter(r => r !== null).flat())];
            state = stageEffect(state, card.controller, instanceId, effectId, matchedSubjects);
        }
    }
    return state;
}

/**
 * Does this signal satisfy the activation, and if so what does it carry?
 *
 * THE RETURN CONTRACT, which the whole staging gate rests on:
 *   null      — did not activate
 *   []        — activated, carries nothing
 *   non-empty — activated, carries these
 *
 * The middle case is the one that did not exist before. Deriving "did it activate"
 * from "is the payload empty" made subject-less signals unable to stage at all, which
 * is why phase-keyed effects were unwritable.
 *
 * TWO TIERS, in this order. Tier 1 is signal-level and touches no cards, so it runs
 * first — no point snapshot-filtering a whole subject list only to discard it on a
 * causeKind mismatch. Tier 2 is subject selection, the only tier producing a value.
 */
function matchesActivation(
    state: GameState,
    evalContext: EvalContext,
    signal: GameSignal,
    activation: SignalActivation,
): CardSnapshot[] | null {
    // ---- TIER 1: predicates over the signal ----
    if (activation.signal !== signal.type) return null;

    // Not every signal carries every field. Asking for one the signal cannot report
    // is a definition error, so it fails rather than matching by default.
    if (activation.fromZone) {
        if (!("fromZone" in signal)) return null;
        if (!activation.fromZone.includes(signal.fromZone)) return null;
    }

    if (activation.phase) {
        if (!("nextPhase" in signal)) return null;
        if (!activation.phase.includes(signal.nextPhase)) return null;
    }

    if (activation.causeKind && !activation.causeKind.includes(signal.cause.kind)) return null;

    if (activation.source) {
        // PLAYER, RULE and OVERFLOW causes name no card, so a source filter has
        // nothing to test — the case a bare CardFilter cannot tell apart from a
        // mismatch, and the reason causeKind and source are separate fields.
        if (!("sourceId" in signal.cause)) return null;
        // The cause is a live id, not a subject, so it is snapshotted at the moment of
        // the question. The source CAUSED the signal rather than being the thing
        // mutated by it, so there is nothing for a mutation to have destroyed.
        const sourceSnapshot = captureSnapshot(state, signal.cause.sourceId);
        if (!evalCardFilter(state, evalContext, sourceSnapshot, activation.source)) return null;
    }

    // ---- TIER 2: subject selection ----
    return selectSubjects(state, evalContext, signal, activation);
}

// Signal types that genuinely name no card. Anything not in here and not carrying
// `subjects` has simply not been converted, which is a different thing and must not
// be silently treated as subject-less.
const SUBJECTLESS_SIGNALS: ReadonlySet<SignalType> = new Set<SignalType>([
    "PHASE_CHANGED",
]);

/**
 * Tier 2 — turn the signal's carried subjects into a payload, or decide the effect
 * did not activate. Sole owner of the three-value contract described above.
 */
function selectSubjects(
    state: GameState,
    evalContext: EvalContext,
    signal: GameSignal,
    activation: SignalActivation,
): CardSnapshot[] | null {
    if (!("subject" in activation)) {
        // The type put this activation in the subject-less arm. That is correct for a
        // signal which genuinely names no card, and the effect activates on tier 1
        // alone — this is the `[]` case, and it is what makes phase-keyed effects work.
        if (SUBJECTLESS_SIGNALS.has(signal.type)) return [];

        // Otherwise the type is lying: the signal DOES name cards, it just has no
        // `subjects` field yet, so `Extract` misfiled it. Two populations end up here,
        // and both should fail loudly rather than activate on nothing:
        //   - not yet migrated (DON attach/detach)
        //   - role-shaped, and deliberately never migrating (combat) — battle
        //     abilities are phase-keyed instead. See SignalActivation.
        throw new Error(
            `Signal ${signal.type} names cards but does not carry subjects; it cannot be listened for with a subject-less activation`,
        );
    }

    // Subjects are already frozen, so this filter reads the board AS IT WAS. Re-running
    // it later against the live board is the last-known-information trap itself, and
    // the governing invariant is that what gets carried is exactly what satisfied the
    // filter — never the raw signal set.
    const raw = "subjects" in signal ? signal.subjects : [];
    const matched = raw.filter(subject => evalCardFilter(state, evalContext, subject, activation.subject.filter));

    switch (activation.subject.kind) {
        case "ANY_OF":
            return matched.length === 0 ? null : matched;
        case "ALL_OF":
            // The empty set must FAIL, or ALL_OF is vacuously true and fires on every
            // signal that named nothing. The payload is the full raw set, because
            // "all of them matched" means all of them are what the effect is about.
            return raw.length > 0 && matched.length === raw.length ? raw : null;
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