import type { CardClass, Color, Attribute, Zone, CardInstanceId, PlayerId } from './primitives';
import type { CardSnapshot } from './card';

export type EvalContext = {
    self: PlayerId;
    source: CardInstanceId;
    /**
     * What the activating signal was about, if there IS an activating signal in scope.
     *
     * OPTIONAL, and the distinction is load-bearing: absent means "no signal in
     * scope", which is NOT the same as "the signal named nothing" (that is `[]`). Two
     * callers are legitimately signal-less — the staging gate, which is still deciding
     * what the subjects are, and `StatusEffectDef.affects`, which never has one.
     * Handing those `[]` would make `SUBJECT_COUNT` answer 0 instead of reporting that
     * the question was unanswerable.
     */
    subjects?: CardSnapshot[];
};

export type CardFilter =
    | { kind: "ANY" }
    | { kind: "THIS" }
    | { kind: "CONTROLLER"; controller: "SELF" | "OPPONENT" | "ANY" }
    | { kind: "NAME"; name: string }              // checks name and aliases
    | { kind: "CLASS"; cardClass: CardClass }
    | { kind: "COST"; op: ">=" | "<=" | "==" | ">" | "<"; value: number, base: boolean }
    | { kind: "POWER"; op: ">=" | "<=" | "==" | ">" | "<"; value: number, base: boolean }
    | { kind: "COUNTER"; op: ">=" | "<=" | "==" | ">" | "<"; value: number, base: boolean }
    | { kind: "COLOR"; color: Color }
    | { kind: "TYPE"; cardType: string }          // OPTCG group/affiliation
    | { kind: "ATTRIBUTE"; attribute: Attribute }
    | { kind: "RESTED"; isRested: boolean }
    | { kind: "FLIPPED"; isFlipped: boolean }
    | { kind: "AND"; filters: CardFilter[] }
    | { kind: "OR"; filters: CardFilter[] }
    | { kind: "NOT"; filter: CardFilter };

    
    // Can be compositions of expressions
    // MULTIPLY can be COUNT * LITERAL, LITERAL * LITERAL but what would be the point
export type AmountExpression =
    | { kind: "LITERAL"; value: number } // literal number, hard coded
    | { kind: "COUNT"; zones: Zone[]; filter: CardFilter } // count based on some game state value
    // How many subjects the activating signal carried — "draw 1 for each card
    // trashed". A BARE LEAF on purpose: it has no `filter`, because the subjects were
    // already filtered by the activation's SubjectMatch, and re-narrowing them here
    // would read a post-mutation board. Scaling is MULTIPLY(SUBJECT_COUNT, LITERAL n).
    | { kind: "SUBJECT_COUNT" }
    | { kind: "ADD"; left: AmountExpression; right: AmountExpression }
    | { kind: "SUBTRACT"; left: AmountExpression; right: AmountExpression }
    | { kind: "MULTIPLY"; left: AmountExpression; right: AmountExpression }
    | { kind: "RANGE"; min: AmountExpression; max: AmountExpression }
    
export type BoardCondition =
    | { kind: "AND"; conditions: BoardCondition[] }
    | { kind: "OR"; conditions: BoardCondition[] }
    | { kind: "NOT"; condition: BoardCondition }
    | { kind: "ZONE_SIZE"; zones: Zone[]; amount: AmountExpression };

export type TargetExpression =
    | { kind: "SELF_TARGET" } // Target's only self
    | { kind: "SELECTOR_TARGET"; zones: Zone[]; filter?: CardFilter } // Affects all that meet criteria, no decision
    | { kind: "PLAYER_CHOICE_TARGET"; amount: AmountExpression; zones: Zone[]; filter?: CardFilter } // Affects selected by player decision