import type { CardInstanceId, PlayerId, Zone, Keyword, StackPosition, CardId, LifeOrientation } from './primitives';
import type { SignalType } from './signal';
import type { CardFilter, BoardCondition, AmountExpression, TargetExpression } from './expression';

export type EffectId = string;

// Effect as it is stored on the database
// Effect is stored on the definition as Record<EffectId, EffectDef>
export type EffectDef = {
    activatingSignals: SignalType[];
    condition?: BoardCondition;
    cost?: EffectCost;
    activeZone: Zone;
    oncePerTurn: boolean;
    optional: boolean;
    steps: EffectStep[];
}

export type EffectContext = {
    playerId: PlayerId;
    effectId: EffectId;
    instanceId: CardInstanceId;
    condition?: BoardCondition;
    cost?: EffectCost;
    optional: boolean;
    cursor: number;
    locals: Record<string, any>;
    steps: EffectStep[];
}

export type EffectFrame = Record<PlayerId, EffectRef[]>;

export type EffectRef = {
    cardId: CardId; // Reference to the card id to get the effect from
    effectId: EffectId; // Effect id to get from the card
    instanceId: CardInstanceId; // instance that activated the effect
}

export type EffectStep =
    | RequirementStep
    | PaymentStep
    | ResolutionStep;

// Requirement step is a conditional check on board condition
// Requirement step preceding a payment step should check for the ability to pay the cost
interface RequirementStep {
    requirement: BoardCondition;
    checkpoint?: true;
}

// Payment must always be preceded by requirement
// Payment step is a cost that must be paid to activate the effect, if it fails, the effect is aborted
// Cost does not require a check because it should already have been checked in the requirement step
interface PaymentStep {
    cost?: EffectCost;
    checkpoint?: true;
}

// Step to resolve the effect post requirement and payment, if any
// Contains the actual functionality of the effect
interface ResolutionStep {
    operation: EffectOperation;
    checkpoint?: true;
}

type EffectOperation =
    | { type: "REORDER"; from: "LOOK"; to: Zone; toPos: StackPosition }
    | { type: "LOOK"; from: Zone; fromPos?: StackPosition; amount: AmountExpression }
    | { type: "ADD_TO_HAND"; target?: TargetExpression; reveal?: boolean }
    | { type: "DRAW"; amount: AmountExpression }

// Add effect costs as we go
export type EffectCost =
    | { kind: "REST"; target?: TargetExpression }
    | { kind: "TRASH"; target?: TargetExpression }
    | { kind: "RETURN_TO_HAND"; target?: TargetExpression }
    | { kind: "RETURN_DON"; target?: TargetExpression }
    | { kind: "LIFE_TO_HAND"; amount: AmountExpression; lifePos: StackPosition }
    | { kind: "LIFE_TRASH"; amount: AmountExpression; lifePos: StackPosition }
    | { kind: "LIFE_FLIP"; amount: AmountExpression; lifePos: StackPosition; orientation: LifeOrientation }


// Status Effects
export type StatusEffectDef = {
    effectId: EffectId;
    type: StatusEffectType;
    modification: Modification;
    expiration: EffectDuration | null;
    affects?: CardFilter;
}

export type StatusEffect = {
    playerId: PlayerId;
    effectId: EffectId;
    instanceId: CardInstanceId;
    type: StatusEffectType;
    modification: Modification;
    expiration: EffectDuration | null;
    affects?: CardFilter;
}

export type EffectDuration =
    | { expiration: "END_OF_BATTLE" }
    | { expiration: "END_OF_REFRESH" }
    | { expiration: "END_OF_MAIN" }
    | { expiration: "END_OF_TURN" }
    | { expiration: "START_OF_NEXT_TURN" }
    | { expiration: "END_OF_NEXT_TURN" }
    | { expiration: "END_OF_OPP_NEXT_MAIN" }
    | { expiration: "END_OF_OPP_NEXT_TURN" }

export type Modification =
    | { type: "KEYWORD"; keyword: Keyword }
    | { type: "POWER"; amount: AmountExpression }
    | { type: "BASE_POWER"; value: AmountExpression }
    | { type: "COST"; amount: AmountExpression }
    | { type: "BASE_COST"; value: AmountExpression }
    | { type: "BASE_COUNTER"; value: AmountExpression }
    // add statuses here (cannot attack, cannot rest, cannot block, can attack active, etc.)

export type StatusEffectType =
    | { type: "INNATE" } // Keywords
    | { type: "PROJECTION" } // Sits on card definition, affects all other cards
    | { type: "MARK" } // Lives in state, has an expiration and is resistant to suppression