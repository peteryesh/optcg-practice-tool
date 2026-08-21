import { produce } from "immer";
import type { GameState, PlayerZones } from "../types/state";
import type { CardInstance, CardDef } from "../types/card";
import type { CardId, CardInstanceId, PlayerId, Zone } from "../types/primitives";
import type { EffectContext, EffectDef, EffectId, EffectStep } from "../types/effect";
import { getZoneArray } from "../game/mechanics/helpers";
import { assertValidGameState } from "./invariants";

function emptyZones(): PlayerZones {
    return {
        characters: [],
        deck: [],
        donActive: [],
        donDeck: [],
        donRested: [],
        hand: [],
        leader: [],
        life: [],
        look: [],
        stage: [],
        trash: [],
        trigger: [],
    };
}

export function createTestState(
    players: PlayerId[] = ["p1", "p2"],
    instances: Record<CardInstanceId, CardInstance> = {},
    zoneOverrides: Partial<Record<PlayerId, Partial<PlayerZones>>> = {},
    definitions: Record<string, CardDef> = {},
): GameState {
    const playerZones: Record<PlayerId, PlayerZones> = {};
    for (const id of players) {
        playerZones[id] = { ...emptyZones(), ...zoneOverrides[id] };
    }

    const allDefinitions = { ...definitions };
    for (const instance of Object.values(instances)) {
        if (instance.class === "DON") continue;
        if (!allDefinitions[instance.cardId]) {
            allDefinitions[instance.cardId] = {
                id: instance.cardId,
                name: instance.cardId,
                class: instance.class,
                colors: [],
                types: [],
                attributes: [],
                aliases: [],
                restrictions: [],
            };
        }
    }

    return {
        version: 0,
        config: {
            gameId: "test",
            playerIds: players,
            seeds: {
                game: BigInt(0) as any,
                players: Object.fromEntries(players.map(id => [id, BigInt(0) as any])),
            },
        },
        setup: {
            coinFlipWinner: players[0],
            firstPlayer: players[0],
            mulligan: Object.fromEntries(players.map(id => [id, "PENDING" as const])),
        },
        rngCursors: {
            game: BigInt(0),
            players: Object.fromEntries(players.map(id => [id, BigInt(0)])),
        },
        definitions: allDefinitions,
        instances,
        playerZones,
        turnOrder: players,
        turn: 1,
        turnPlayerId: players[0],
        phase: "MAIN",
        cardsPlayedThisTurn: [],
        currentBattle: null,
        battlesThisTurn: [],
        decisionPoint: null,
        currentEffect: null,
        effectQueue: [],
        stagingFrame: Object.fromEntries(players.map(id => [id, []])),
        statusEffects: [],
        gameLog: [],
        winner: null,
        endReason: null,
    };
}

let _nextId = 1;
export function resetIds() { _nextId = 1; }

export function makeCharacterInstance(
    overrides: Partial<{ instanceId: CardInstanceId; controller: PlayerId; cardId: string; currentZone: Zone; }> = {}
): CardInstance {
    const instanceId = overrides.instanceId ?? `card-${_nextId++}`;
    return {
        instanceId,
        cardId: overrides.cardId ?? "test-card",
        controller: overrides.controller ?? "p1",
        class: "CHARACTER",
        currentZone: overrides.currentZone ?? "DECK",
        isRested: false,
        attachedDon: [],
        playedOnTurns: [],
        effectsUsedThisTurn: {},
        flipped: false,
    };
}

export function makeDonInstance(
    overrides: Partial<{ instanceId: CardInstanceId; controller: PlayerId; currentZone: Zone; }> = {}
): CardInstance {
    const instanceId = overrides.instanceId ?? `don-${_nextId++}`;
    const currentZone = overrides.currentZone ?? "DON_DECK";
    return {
        instanceId,
        class: "DON",
        controller: overrides.controller ?? "p1",
        currentZone,
        isRested: currentZone === "DON_RESTED",
        attachedTo: null,
        donValue: 1,
    };
}

export function makeStageInstance(
    overrides: Partial<{ instanceId: CardInstanceId; controller: PlayerId; cardId: string; currentZone: Zone; }> = {}
): CardInstance {
    const instanceId = overrides.instanceId ?? `stage-${_nextId++}`;
    return {
        instanceId,
        cardId: overrides.cardId ?? "test-stage",
        controller: overrides.controller ?? "p1",
        class: "STAGE",
        currentZone: overrides.currentZone ?? "DECK",
        isRested: false,
        attachedDon: [],
        playedOnTurns: [],
        effectsUsedThisTurn: {},
        flipped: false,
    };
}

export function makeEventInstance(
    overrides: Partial<{ instanceId: CardInstanceId; controller: PlayerId; cardId: string; currentZone: Zone; }> = {}
): CardInstance {
    const instanceId = overrides.instanceId ?? `event-${_nextId++}`;
    return {
        instanceId,
        cardId: overrides.cardId ?? "test-event",
        controller: overrides.controller ?? "p1",
        class: "EVENT",
        currentZone: overrides.currentZone ?? "DECK",
        isRested: false,
        playedOnTurns: [],
        effectsUsedThisTurn: {},
        flipped: false,
    };
}

export function makeLeaderInstance(
    overrides: Partial<{ instanceId: CardInstanceId; controller: PlayerId; cardId: string; }> = {}
): CardInstance {
    const instanceId = overrides.instanceId ?? `leader-${_nextId++}`;
    return {
        instanceId,
        cardId: overrides.cardId ?? "test-leader",
        controller: overrides.controller ?? "p1",
        class: "LEADER",
        currentZone: "LEADER",
        isRested: false,
        attachedDon: [],
        effectsUsedThisTurn: {},
    };
}

// Out-of-band board authoring for tests only: register an instance in state and
// append its id to a zone array directly — no operations, no signals, no log. Keeps
// `currentZone` (and `controller`, if a different one is passed) consistent with the
// zone the card lands in. Real, in-game placement must go through an operation; this
// only fabricates a starting position to assert against. Appends to the end of the
// zone array — place cards in the order you want them, or override `controller` to
// drop a card into an opponent's zone.
export function placeCard(
    state: GameState,
    instance: CardInstance,
    zone: Zone,
    controller: PlayerId = instance.controller,
): GameState {
    return produce(state, draft => {
        draft.instances[instance.instanceId] = { ...instance, controller, currentZone: zone };
        getZoneArray(draft, controller, zone).push(instance.instanceId);
    });
}

// ---------------------------------------------------------------------------
// Effect authoring
// ---------------------------------------------------------------------------

// The simplest activating effect: fires when this very card is played, active
// while it sits on the field, and does nothing. Override only the part under test.
export function makeEffectDef(overrides: Partial<EffectDef> = {}): EffectDef {
    return {
        activation: [{ signal: "CHARACTER_PLAYED", subject: { kind: "ANY_OF", filter: { kind: "THIS" } } }],
        activeZone: "CHARACTERS",
        oncePerTurn: false,
        steps: [],
        ...overrides,
    };
}

// A RESOLUTION step drawing a fixed number of cards. Pass a whole
// AmountExpression instead when the point of the test is the evaluation.
export function makeDrawStep(amount: number): EffectStep {
    return {
        kind: "RESOLUTION",
        operation: { type: "DRAW", amount: { kind: "LITERAL", value: amount } },
    };
}

// Builds the `definitions` argument for createTestState, with effects attached
// to one cardId. `cost` defaults to 0 for two reasons: calculateCost throws on an
// undefined cost, and a 0-cost card is playable with no DON on the board.
export function withEffect(
    cardId: CardId,
    effectDefs: Record<EffectId, EffectDef>,
    overrides: Partial<CardDef> = {},
): Record<CardId, CardDef> {
    return {
        [cardId]: {
            id: cardId,
            name: cardId,
            class: "CHARACTER",
            cost: 0,
            colors: [],
            types: [],
            attributes: [],
            aliases: [],
            restrictions: [],
            ...overrides,
            effectDefs,
        },
    };
}

// ---------------------------------------------------------------------------
// Full board fixture
// ---------------------------------------------------------------------------

export const BOARD_LEADER = "TEST-LEADER";
export const BOARD_FILLER = "TEST-FILLER";

const boardLeaderDef: CardDef = {
    id: BOARD_LEADER, name: BOARD_LEADER, class: "LEADER", power: 5000, life: 5,
    colors: [], types: [], attributes: [], aliases: [], restrictions: [],
};

const boardFillerDef: CardDef = {
    id: BOARD_FILLER, name: BOARD_FILLER, class: "CHARACTER", cost: 0, power: 1000,
    colors: [], types: [], attributes: [], aliases: [], restrictions: [],
};

export type GameBoard = {
    state: GameState;
    // Instances created for each player's hand, in the order their cardIds were
    // requested — this is how a test names the card it wants to play.
    hands: Record<PlayerId, CardInstance[]>;
};

// A realistic mid-game board, assembled directly rather than played into.
//
// Driving a real game to this point would mean walking setup, mulligan and N
// turns of the phase machine — which tests the phase machine, not whatever the
// test is actually about. A test should fail for one reason.
//
// DON defaults to the game cap of 10 active so cost never has to be reasoned
// about: every card in the pool is affordable and cost drops out as a variable.
//
// The state is checked with assertValidGameState before it is returned, because
// a hand-built board can be malformed in ways a real game never produces, and a
// test passing against an unreachable state is worse than no test.
export function makeGameBoard(opts: {
    players?: PlayerId[];
    definitions?: Record<CardId, CardDef>;
    hands?: Partial<Record<PlayerId, CardId[]>>;
    deckSize?: number;
    lifeSize?: number;
    donActive?: number;
    turnPlayer?: PlayerId;
} = {}): GameBoard {
    const players = opts.players ?? ["p1", "p2"];
    const deckSize = opts.deckSize ?? 10;
    const lifeSize = opts.lifeSize ?? 5;
    const donActive = opts.donActive ?? 10;
    const turnPlayer = opts.turnPlayer ?? players[0];

    const instances: Record<CardInstanceId, CardInstance> = {};
    const zones: Partial<Record<PlayerId, Partial<PlayerZones>>> = {};
    const hands: Record<PlayerId, CardInstance[]> = {};

    const register = (instance: CardInstance): CardInstanceId => {
        instances[instance.instanceId] = instance;
        return instance.instanceId;
    };

    for (const controller of players) {
        const leader = makeLeaderInstance({ controller, cardId: BOARD_LEADER });
        const deck = Array.from({ length: deckSize }, () =>
            makeCharacterInstance({ controller, cardId: BOARD_FILLER, currentZone: "DECK" }));
        const life = Array.from({ length: lifeSize }, () =>
            makeCharacterInstance({ controller, cardId: BOARD_FILLER, currentZone: "LIFE" }));
        const don = Array.from({ length: donActive }, () =>
            makeDonInstance({ controller, currentZone: "DON_ACTIVE" }));
        const hand = (opts.hands?.[controller] ?? []).map(cardId =>
            makeCharacterInstance({ controller, cardId, currentZone: "HAND" }));

        hands[controller] = hand;
        zones[controller] = {
            leader: [register(leader)],
            deck: deck.map(register),
            life: life.map(register),
            donActive: don.map(register),
            hand: hand.map(register),
        };
    }

    const base = createTestState(players, instances, zones, {
        [BOARD_LEADER]: boardLeaderDef,
        [BOARD_FILLER]: boardFillerDef,
        ...opts.definitions,
    });

    const state: GameState = {
        ...base,
        turn: 1,
        turnPlayerId: turnPlayer,
        phase: "MAIN",
        decisionPoint: { type: "MAIN_ACTION", player: turnPlayer },
    };

    assertValidGameState(state);
    return { state, hands };
}

// A promoted effect parked at the start of its step list. Stands in for what
// promoteEffect would have built, so resolution and stepping can be tested
// without staging a signal first.
export function makeEffectContext(overrides: Partial<EffectContext> = {}): EffectContext {
    return {
        playerId: "p1",
        effectId: "effect-1",
        instanceId: "card-1",
        // Defaults to the "activated, carries nothing" case — correct for any test
        // whose effect is not about its subjects. Override to assert on them.
        subjects: [],
        cursor: 0,
        // null, not [] — no selection is running. `[]` would claim one is open
        // before any step has executed.
        selected: null,
        locals: {},
        steps: [],
        ...overrides,
    };
}
