# Effect system build plan

## Where things stand

**The On-Play draw slice is COMPLETE** (Phase 1, 2026-07-25). `reducer(state, PLAY_CARD)` takes an
On-Play character from hand through staging → commit → promotion → `advanceEffect` →
`executeResolution` → `cardsDraw` → back to `MAIN_ACTION`, in one call. Two real cards
(`OP04-045` King, `OP13-041` Izo) authored in `src/cards/` and tested against the real registry.

Everything else is stubbed. `REQUIREMENT`/`PAYMENT` throw from the stepper; every
`EffectOperation` but `DRAW` throws; `evalBoardCondition`/`evalTargetExpression` unwritten so
`def.condition` is a commented stub; `oncePerTurn` never read; `signalSubjects` throws on combat
signals.

---

# The plan — milestones and why

## 1. Give effects access to their subject *(IN FLIGHT)*

**Why:** an effect currently knows *that* it activated but not *what it activated on*. That is the
missing half of every reactive effect — any card saying "that character", "those cards" or "for
each" is unwritable until the matched subject set survives past the staging gate. The gate is
currently the only thing that ever sees it.

Immediate payoff: counting ("draw 1 for each card trashed"). Larger payoff: targeting, which reads
the same channel through a different expression type.

Driving card (hypothetical): *"When a {Navy} card trashes cards from your hand by an effect, draw 1
card for each card trashed."*
```ts
activation: [{
    signal: "CARDS_SENT_TO_TRASH",
    subject: { kind: "CONTROLLER", controller: "SELF" },
    causeKind: ["EFFECT"],
    source: { kind: "TYPE", cardType: "Navy" },   // "Navy" is a real type string in the card data
    fromZone: ["HAND"],
}],
steps: [{ kind: "RESOLUTION", operation: { type: "DRAW", amount: { kind: "SUBJECT_COUNT" } } }]
```
The whole ACTIVATION block already works. Remaining:
- [x] `signalSubjects` returns `instanceIds` for the five `CARDS_SENT_TO_*` signals
- [x] `matchesActivation` returns `CardInstanceId[] | null`; emitter flatMaps + dedupes into
      `matchedSubjects` and passes it to `stageEffectRef`
- [ ] `stageEffectRef` — param exists, not yet written onto the ref object
- [ ] `EffectRef.subjects` / `EffectContext.subjects` types
- [ ] `buildCurrentEffect` copies ref → context
- [ ] `EvalContext.subjects?` — **optional**: staging builds an EvalContext with no effect in
      existence, and `StatusEffectDef.affects` evaluates filters with no subjects either
- [ ] `evalContextOf` threads it — easiest to miss, fails silently
- [ ] `AmountExpression` gains `SUBJECT_COUNT`; evaluator branch throws when subjects absent
- [ ] STALE TEST: `staging.test.ts > signalSubjects > "throws for a multi-card signal"` asserts the
      old deferral; should assert it returns the ids

## 2. Close the On-Play slice

**Why:** so "the slice works" has no asterisk. One untested path: playing into a FULL character zone
routes `CHARACTER_PLAYED` through `displaceCard` rather than `playCharacter`, after a removal. A full
board is an ordinary mid-game state.

## 3. Let the language be shaped by the cards, not one card at a time

**Why:** every card examined so far has forced a language change, and that continues as long as
requirements arrive one card at a time. Survey the 2,631-card corpus (`raw_effect` on every row):
cluster by ability keyword, verb, and what each construct needs. Converts reactive design into
informed design.

**This decides the order of 4–7.** Whichever covers the most real cards goes next; right now that is
guesswork.

## 4. Let two effects coexist

**Why:** two cards watching one signal is an ordinary board and currently **hard-stops the game** —
the conductor sets `RESOLVE_EFFECT_ORDER`, and `CHOOSE_NEXT_EFFECT` throws "not yet implemented" in
validator/reducer/actionGen. Most likely thing to break a real playtest.

Forces the **EffectRef identity bug**: `promoteEffect` locates a ref by
`.map(r => r.instanceId).indexOf(...)` (mechanics/effects.ts), so one card staging two effects
splices the wrong one; `CHOOSE_NEXT_EFFECT` carries only `{playerId, effectId}` and cannot name an
instance. Natural key is the composite `(instanceId, effectId)`. Also `EffectRef.cardId` is
redundant (derivable via `getCardDef`).

## 5. Let effects be conditional

**Why:** most printed effects have an "if". Without it every effect that activates must resolve, so
the whole class of "draw 1 if you have 8 or more DON!!" is off the table — simple cards otherwise.

Needs `evalBoardCondition` + wiring `def.condition` into the staging gate. `BoardCondition` currently
cannot express either real example: `ZONE_SIZE` has **no comparison operator** ("8 or more" vs "5 or
less") and **no controller scoping** ("your hand"). Replace it with a compare leaf over two
`AmountExpression`s — `COUNT` already scopes via a `CONTROLLER` filter, making `ZONE_SIZE` strictly
weaker. No callers to migrate.

## 6. Give the engine a moment *before* a mutation

**Why:** four separate needs reduce to one missing hook — LKI snapshot capture, continuous
protection ("cannot be K.O.'d by effects"), replacement effects, and the three signals that fire
early because they are reaching for exactly this. Piecemeal = four retrofits into every operation.
Together = one change. Biggest item, most expensive to get wrong later. See the workstream section.

## 7. Teach signals about roles

**Why:** combat effects and phase-keyed effects **cannot activate at all**. `signalSubjects` throws
on signals naming cards in several roles (attacker vs defender), and subject-less signals return `[]`
so `subjects.some(...)` is always false. A whole category of card is unreachable.

This is where splitting `SignalActivation` into a discriminated union keyed on `SignalType` starts
paying for itself (per-signal fields, `attacker`/`defender`, `from`/`to`; the union becomes the
coverage check the throw stands in for).

---

# Settled design decisions — do not re-litigate

## Signals are the activation language (2026-07-26)
- **Signals are legitimate vocabulary in the ACTIVATION layer.** A neutral "occurrence"/"event"
  abstraction was proposed and **REJECTED** — the engine owns both signals and definitions, so
  abstracting buys nothing and costs type safety.
- **`SignalActivation` is FLAT, not discriminated.** The union was designed and deliberately not
  built; flat covers every signal shape in use, and the union only pays off when a second signal
  *shape* arrives (see milestone 7). Shipped:
  ```ts
  { signal: SignalType; subject: CardFilter;
    causeKind?: SignalCause["kind"][]; source?: CardFilter; fromZone?: Zone[] }
  ```
  Optional narrowings, omitted = match anything. **Asking for a field the signal does not carry FAILS
  rather than matching** — a definition error must not fire on everything.
- **`causeKind` and `source` are TWO fields, not one predicate.** A `CausePredicate` wrapper was
  rejected as over-structured. Genuinely different checks: a `CardFilter` alone cannot tell "caused
  by a player" from "caused by an effect", because with no `sourceId` to test it simply fails,
  conflating no-cause with wrong-cause. Named `source` despite the conceptual collision with
  `EvalContext.source` ("the card whose effect is evaluating").
- **`cause` is MANDATORY on every signal.** `ATTACK_DECLARED`/`COUNTER_PLAYED`/`BATTLE_RESOLVED` had
  none; added at their emit sites in battle.ts. `BATTLE_RESOLVED` names the attacker as source, which
  makes "when a battle my character was in resolves" expressible through the normal `source` filter.
  Those three ops do not take a `signalCause` param, so values are hardcoded — an effect that forces
  an attack would need it threaded through.
- **STAGE-ONCE, never fan-out.** One event = one EffectRef = one resolution = one `oncePerTurn`
  consumption. Multiplicity lives in the DATA (`SUBJECT_COUNT`), never in the number of refs. Fan-out
  would make the consumption boundary and `oncePerTurn` incoherent.
- **Multiple effects on ONE card** watching the same signal stage independently and resolve
  sequentially — trust card designers not to make same-card effects order-dependent. Genuine clashes
  are between MULTIPLE CARDS; that is what the staging frame is for.
- **One effect with TWO matching activation entries → UNION of subject sets**, deduped, insertion
  order preserved (`flatMap` + `Set`). Decided by implementation.
- **Expressions stay pure board queries.** `CardFilter`/`BoardCondition`/`TargetExpression` are used
  outside activation (`StatusEffectDef.affects`, actionGen gating an `[Activate: Main]`), so they
  must not assume a signal.
- **Everything activates through emit, including invoked abilities.** actionGen gates a Main ability
  on `def.condition` to decide action legality; invoking emits a signal that stages normally.
- **Status effects sit outside activation entirely** — passive alterations read during calculation,
  cleaned up on expiry. They never stage.

## Structural
- **Operations never name a player.** No `EffectOperation`/`EffectCost` carries a PlayerId. Who acts
  derives from expressions: `EvalContext.self` = controller of the activating card. `DRAW` draws for
  `self`; an opponent-acting effect says so through its filters.
- **`condition` stays on BOTH EffectDef and EffectContext** — the gate for whether the effect can be
  activated/paid at all, in place of an initial requirement step. Mid-resolution conditionals are
  RequirementSteps. (`cost` is the one removed from both — payment steps own it.)
- **Split the two conditions:** authored GATING requirements (board state) vs DERIVED affordability
  (computed from cost, never hand-written — kills the double-count trap).
- **`bind` (write) / `REF` (read).** `bind?: string` on the step base; REF is an EXPRESSION leaf, not
  a step field, added to TargetExpression/CardFilter/AmountExpression. Phase-1 REF =
  identity/set/count. NOTE: REF is for STEP-PRODUCED data. The activation's subjects are a different
  channel — always present, no path analysis needed.
- **`done` vs `abort` distinct terminals.** `abort` = pre-commitment, does NOT consume the use;
  `done` = success, consumes it. End-of-branch is `done`. `abort` illegal after the first
  ResolutionStep.
- **EffectCost atomic.** Single-part per PaymentStep; multi-line cost = sequential MANDATORY payment
  steps in card order. No `ALL` combinator.
- **Effect analyzer** = path-aware def-use over the jump graph: every REF defined on all paths before
  use, `EffectValue.kind` matches its host, every payment requirement-covered, multi-part payments
  non-optional after the first. Becomes load-bearing once effects move from TS to data.
- **CardSnapshot** = identity (instanceId, cardId) + mutable computed fields only
  (power/cost/counter/keywords/controller/attachedDon/rested/flipped/zoneAtCapture). Def data
  recoverable via cardId. Live-vs-frozen read EXPLICIT via `EffectValue` kind (CARDS = live,
  SNAPSHOTS = frozen).
- **Terminology: "activate" → "invoke".** "activation" is RESERVED for the generic concept (an effect
  staging off any signal), baked into `SignalActivation`. The manual player-initiated Main ability
  must not reuse it: rename `EFFECT_ACTIVATED`→`EFFECT_INVOKED`, `ACTIVATE_EFFECT`→`INVOKE_EFFECT`.
  Never "trigger" (reserved — see the naming conventions in CLAUDE.md).

## Invariants with the highest retrofit cost
1. **Typed locals = the only cross-step data channel.** `locals: Record<string, EffectValue>`,
   `EffectValue = CARDS | SNAPSHOTS | NUMBER | BOOL`. Define the union before REF consumes it; `any`
   locals is the trap.
2. **DecisionPoint = derived projection, single source of legality.** Built once at pause time from
   the resolved TargetExpression; `validate`/`actionGen` read ONLY the decisionPoint. Direction is
   step→decisionPoint, never two independent authorings. This is where `CHOOSE_TARGETS` gets defined.
3. **Consumption boundary = cursor entering the first ResolutionStep.** One point = use marked in
   `effectsUsedThisTurn`, `abort` no longer legal, past-here-can't-rewind. Depends on all gating
   conditions sitting before any cost — satisfied by putting the gate in `def.condition`.
4. **Control flow = flat step list + `goto`/labels + `done`/`abort` terminals** — NOT nested groups,
   so `cursor` stays a single int and resume stays trivial.
5. **Test discipline (from Phase 1, keep it).** Stepper tests assert progress/order through OPERATION
   RESULTS (cards moved), not the cursor; exactly one test reads `cursor`, labelled as pinning
   invariant 4. Throws asserted bare, no message matching. The deferred goto/terminal work rewrites
   cursor semantics — brittle tests would all break.

---

# Deferred workstream — the pre-operation stage (milestone 6, do NOT do piecemeal)

One function at the head of EVERY operation covering LKI snapshot capture, replacement/prevention
hooks, and continuous "cannot be X" checks.

**The sizing question, still open: is it a synchronous QUERY or a SIGNAL?** A query (pure read of
`statusEffects`, shaped like `calculatePower`) covers snapshot capture + veto, keeps operations
atomic, and is cheap. A signal routed through staging/queue lets an effect resolve mid-operation,
forcing every operation to become resumable — very expensive. OPTCG protection looks overwhelmingly
continuous, so the query probably suffices. **Verify against real card text before committing.**

**Snapshots vs subjects were coupled and have been separated.** The matched-subject set (milestone 1)
is plain ids and needs no capture-before-mutate. Snapshots are only required when reading MUTABLE
COMPUTED state after the mutation (power with DON, prior zone); definition-derived facts (colour,
cost, name, type) survive. When snapshots land: store the FILTERED match, never the raw signal id
array — re-running the filter at resolution evaluates it against a post-mutation board, which is the
LKI trap itself.

**Three pre-mutation emits are an early, informal stab at this same need** (audited 2026-07-25). The
convention is otherwise uniformly mutate-then-emit; exactly three sites emit early, and they are
exactly the three that will need snapshots. **Do NOT normalize them on their own** — fix the ordering
when the pre-operation function lands, so the information they reach for early has a real home.
- `_removeCardFromField` (cards.ts) — `CARD_REMOVED_FROM_FIELD` before `moveCard`, AND after the DON
  detach, so it is already lossy for computed power.
- `takeDamage` (life.ts) — `DAMAGE_TAKEN`/`LIFE_DAMAGED` before `sendTopLifeToTrigger` moves the card.
- `resolveBattle` (battle.ts) — `BATTLE_RESOLVED` after `removeCurrentBattle` but before the
  damage/KO consequence. A third convention again.

**What pre-emit buys, and does not:** it helps the STAGING GATE (emit evaluates the subject filter
synchronously, card still on the field) but does NOTHING for resolution — staging only pushes a ref;
promotion/resolution run later, after every mutation.

**On-exit activeZone is coupled to this.** NOT currently broken: `CARD_REMOVED_FROM_FIELD` fires
pre-mutation so the card is still in CHARACTERS and a naive `currentZone === activeZone` check passes
for On-K.O. today. Once that emit moves after `moveCard`, every On-K.O. effect stops staging
**silently**. So `signal.fromZone` matching must land in the SAME change as the reordering.

**While in there:** `declareBlocker` and `redirectAttack` (battle.ts) mutate BEFORE validating — not
a live bug (the throw discards state) but the same shape, and a pre-op stage would absorb those
checks. Minor: `playEvent` emits `CARDS_SENT_TO_TRASH` before `EVENT_PLAYED`, causally backwards.

---

# Open questions
- **Does paying a COST count as "by an effect"?** (`[Activate: Main] You may trash 1 card from your
  hand: ...`) Extremely common in OPTCG; the engine cannot currently distinguish a cost payment from
  an effect operation. **Settle BEFORE `EffectCost` execution is written.**
- **Phase-keyed effects cannot activate** — subject-less signals return `[]`. Options: optional
  `subject` meaning "gate on signal type alone"; subject-less signals return the listener itself; or
  key phase effects off something other than `activation`. Part of milestone 7.
- **`EFFECT_INVOKED` timing** — main-phase-only vs a general timing marker.

# Known bugs, not blocking
- **Deckout timing.** `emit` checks after EVERY signal and ends the game the moment a deck is empty,
  so drawing your last card loses immediately. OPTCG's rule is losing when you MUST draw and cannot.
  Pinned by an integration test that documents current behaviour.
- **`toCardDef` does not normalise case.** Remote data sends `"Blue"`/`"Slash"`; engine unions are
  `'BLUE'`/`'SLASH'`. Any card built through that path has colours no `COLOR` filter will match.
  Silent, because the `Card` type mis-declares the remote shape. `name`/`types` stay as printed.
- **`cost: null` vs `undefined`** — leaders come back with `null` where `CardDef` declares
  `cost?: number`. Check `calculateCost`.
- Evaluator: `RANGE` AmountExpression throws; `base` flag ignored on COST/POWER/COUNTER filters.

# Remaining backlog (each = new step-kind/gate + own tests)
Costs/payments (7 `EffectCost` kinds) → PAYMENT step, test the abort branch · targeting
(`evalTargetExpression`, `CHOOSE_TARGETS`, TARGET binding) · `optional` decline + `oncePerTurn` ·
remaining resolution ops (LOOK, REORDER, ADD_TO_HAND) · status effects subsystem (apply/read/expire,
wire into cost/counter/power calc) · **ChoiceStep** (sole purpose: emit a decisionPoint between 2+
choices; the answer drives a `goto` to the chosen labelled branch — the modal keystone) ·
**`CardFilter.value` → `AmountExpression`** (agreed end state; uniform comparand unlocks
relational/REF/CARD_STAT/COUNT comparands — real migration, time it WITH CARD_STAT) · **CARD_STAT**
(value extraction from a bound card, read LIVE; `bind` writes → `REF` reads identity/set →
`CARD_STAT` reads a stat off it).
