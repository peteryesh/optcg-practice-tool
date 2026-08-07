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

**Direction change, 2026-08-07.** Subjects move *onto the signals* as captured snapshots rather than
being derived from them at emit time. Milestone 6a is pulled ahead for it, and milestone 1 splits:
1a (plumb the channel) ships now and is unaffected; 1b (split the gate from the payload) waits,
because 6a deletes the piece 1b would otherwise have to invent. Rationale under "Subjects live on
the signal"; the reversal it supersedes is noted in the pre-operation workstream.

---

# The plan — milestones and why

## 1. Give effects access to their subject *(IN FLIGHT — split into 1a/1b, 2026-08-07)*

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
    subject: { kind: "ANY_OF", filter: { kind: "CONTROLLER", controller: "SELF" } },
    causeKind: ["EFFECT"],
    source: { kind: "TYPE", cardType: "Navy" },   // "Navy" is a real type string in the card data
    fromZone: ["HAND"],
}],
steps: [{ kind: "RESOLUTION", operation: { type: "DRAW", amount: { kind: "SUBJECT_COUNT" } } }]
```

### 1a. Plumb the channel — no gate change, no card migration

Ships the driving card **on its own**: "≥1 subject matched the filter" is already a correct fire
condition for it under today's gate, so all ~10 authoring sites keep their current syntax.

Every item here is agnostic to whether a subject is an id or a snapshot, so **none of it is
invalidated by 6a**. Alias the element type (`type Subject = CardInstanceId` now) and the later swap
is localized.

- [x] `signalSubjects` returns `instanceIds` for the five `CARDS_SENT_TO_*` signals
- [x] `matchesActivation` returns `CardInstanceId[] | null`; emitter flatMaps + dedupes into
      `matchedSubjects` and passes it to `stageEffectRef`
- [ ] `stageEffectRef` — param exists, not yet written onto the ref object
- [ ] `EffectRef.subjects` / `EffectContext.subjects` types — REQUIRED, `[]` legal. Coherent because
      of STAGE-ONCE: one ref per event regardless of subject count, so there is always exactly one
      array to fill.
- [ ] `buildCurrentEffect` copies ref → context
- [ ] `EvalContext.subjects?` — **optional, and that is load-bearing.** Absent means "no activating
      signal in scope", which is NOT "the signal named nothing". Two callers are legitimately
      signal-less: the staging gate (mid-decision about what the subjects even are) and
      `StatusEffectDef.affects`. Handing those `[]` makes `SUBJECT_COUNT` answer `0` instead of
      reporting that the question was unanswerable.
- [ ] `evalContextOf` threads it — easiest to miss, fails silently
- [ ] `AmountExpression` gains `SUBJECT_COUNT`; evaluator branch throws when subjects absent
- [ ] STALE TEST: `staging.test.ts > signalSubjects > "throws for a multi-card signal"` asserts the
      old deferral; should assert it returns the ids. **This is the one red in the current baseline**
      (259 pass / 1 fail).

### 1b. Split the gate from the payload — BLOCKED ON 6a, deliberately

**One filter, two consumers**: the gate reads its *cardinality*, the payload reads its *extension*.
Today they are the same operation — `matched.length === 0 → null` (`emitter.ts:87`) — so "activated,
carries nothing" is unrepresentable, which is why subject-less signals can never stage.

Splitting it needs the `SubjectMatch` wrapper (see settled decisions), and the wrapper's membership
depends on 6a. **Do not build a `NONE` member**: it is exactly what subjects-on-signals deletes, and
building it means authoring it onto every phase-keyed card and then removing it.

Cost of waiting: phase-keyed effects stay blocked until 6a lands. Accepted.

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

Needs `evalBoardCondition` + wiring `def.condition` in **at resolution, not at the staging gate** —
see the condition-timing decision under Structural. NOTE: the commented stub sitting in the staging
loop (`emitter.ts`, "if board state does not meet activation condition / continue") is in the WRONG
PLACE and should be deleted rather than filled in. `BoardCondition` currently
cannot express either real example: `ZONE_SIZE` has **no comparison operator** ("8 or more" vs "5 or
less") and **no controller scoping** ("your hand"). Replace it with a compare leaf over two
`AmountExpression`s — `COUNT` already scopes via a `CONTROLLER` filter, making `ZONE_SIZE` strictly
weaker. No callers to migrate.

## 6. Give the engine a moment *before* a mutation

**Split into 6a and 6b (2026-08-07).** Capture and prevention were treated as one hook. They are
separable, and only capture is on the critical path — prevention is the hard design (replacement
priority, who intervenes, ordering), capture is mechanical.

### 6a. Snapshot capture — subjects move onto the signals *(PULLED AHEAD, ahead of milestone 3)*

**Why it is worth pulling ahead: it is net deletion.** It removes `signalSubjects` entirely, removes
the `anyListening` gate's reason to exist, removes `SubjectMatch.NONE`, removes the combat throw, and
removes the three deliberately-early emit orderings. Almost every open item below traces back to
subjects being *derived* from signals instead of *carried* by them.

Signals that name cards gain a `subjects` field; `SignalActivation` becomes discriminated on whether
that field exists. See "Subjects live on the signal" under settled decisions for the full shape.

**The mechanic: move the CAPTURE early, not the EMIT.** The three early-emit sites emit early because
that is currently the only way to see pre-mutation state. Once a subject carries a snapshot, the two
decouple — capture before the mutation, emit after it — and all three normalise to mutate-then-emit
with nothing lost.

The capture rule. Not "head of the operation" (a draw knows a count, not which cards), and **not
"always before the mutation"** — that is right for exit signals and wrong for entry ones. Capture
`CHARACTER_PLAYED` before the move and `zoneAtCapture` is `HAND`, breaking every On-Play effect:

> **Capture at the point where the state the signal describes is true.** Entry signals describe the
> post-move world; exit signals describe the pre-move one.

This maps onto what the code already does: entry signals are mutate-then-emit and capture at emit
time; the three exit sites capture early and emit late.

**Corollary — the activeZone gate gets a uniform rule, and the On-K.O. trap dissolves.** Read the
listener's **captured** zone when the listener is one of the signal's subjects, its live zone
otherwise. On-Play: listener is the subject, captured post-move as `CHARACTERS`, passes. On-K.O.:
listener is the subject, captured pre-move as `CHARACTERS`, passes. A bystander ("when *another* of
your characters is K.O.'d") is not a subject and reads live, which is correct. No `fromZone`
special-casing — it stays an ordinary activation narrowing rather than a load-bearing rescue.

Sizing (measured 2026-08-07): 26 of 31 signal variants name cards; ~51 emit sites populate them;
`signal.instanceId(s)` is **read in exactly two places, both inside `signalSubjects`**. The ids are
write-only today, so this is a write-side migration with no read side to chase.

### 6b. Prevention / replacement / continuous "cannot be X"

**Why:** the remaining needs of the original milestone 6 — continuous protection, replacement
effects, and the veto half of the pre-operation hook. Still the biggest item and still not to be done
piecemeal. See the workstream section for the query-vs-signal sizing question, which applies to 6b
only; 6a needs no such decision because capture is a pure read.

## 7. Teach signals about roles

**Largely subsumed by 6a.** Roles become a field on the subject rather than an ambiguity in a flat
list, and the discriminated `SignalActivation` falls out structurally instead of being hand-cut.

**Why it remains a milestone:** the role *vocabulary* still has to be designed against real card
text. The signals needing it: `ATTACK_DECLARED` (attacker/defender), `ATTACK_REDIRECTED`
(attacker/from/to), `BLOCKER_DECLARED` (blocker/attacker/prevDefender), `COUNTER_PLAYED`,
`BATTLE_RESOLVED`, `DON_ATTACHED` (don + target), `DON_DETACHED` (don + origin).

Rule for what becomes a subject: **a card reference is a subject if the activation language should be
able to filter on it.** `cause.sourceId` is deliberately NOT one — it has its own `source` filter,
and keeping them separate is what lets an activation tell "caused by a player" from "caused by an
effect".

---

# Settled design decisions — do not re-litigate

## Signals are the activation language (2026-07-26)
- **Signals are legitimate vocabulary in the ACTIVATION layer.** A neutral "occurrence"/"event"
  abstraction was proposed and **REJECTED** — the engine owns both signals and definitions, so
  abstracting buys nothing and costs type safety.
- **`SignalActivation` is FLAT, not discriminated** — *superseded 2026-08-07, see "Subjects live on
  the signal". The escape clause fired: subject-carrying vs subject-less IS the second signal shape.*
  Original reasoning, still valid for why it was not built earlier: flat covered every signal shape
  in use, and the union only pays off when a second shape arrives. Shipped:
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

## Subjects live on the signal (2026-08-07)

- **DEFINITION. A *subject* is a card the signal is about, captured as of the instant the signal's
  cause was determined.** It carries identity, computed state at capture, and an optional role. The
  vocabulary is kept (nothing better survives contact — "affected" is wrong for `ATTACK_DECLARED`,
  "participants" is worse), but the meaning is now LKI, not a live id. That definition does real
  work: it tells an author a subject filter reads the board *as it was*.
- **Signals CARRY their subjects; nothing derives them.** `signalSubjects` exists only because
  signals name cards under inconsistent field names (`instanceId`, `instanceIds`,
  `attackerId`/`defenderId`). Put the field on the signal and the translation layer has nothing to
  translate. **Replace `instanceIds`, never duplicate it** — two sources of truth drift, and the
  read side is already empty (two reads, both inside `signalSubjects` itself).
- **Migrate by category, not big bang.** A signal type either has `subjects` (converted) or its old
  id field (not yet), and `signalSubjects` shrinks into a shim handling only the unconverted. Its
  existing throw is already the migration tracker: it means "this signal type is not supported yet".
  Delete the shim when it is empty. Movement signals first — that is what the driving cards need.
- **GOVERNING INVARIANT: carried subjects ≡ the set that satisfied the filter.** Never the raw signal
  set. "Draw for each card discarded" and "draw for each RED card discarded" differ *only* in the
  filter; the payload follows the filter in both. Re-running a filter at resolution against a
  post-mutation board is the LKI trap itself.
- **Activation runs in TWO TIERS, in this order.** Tier 1 = signal-level (`signal`, `causeKind`,
  `fromZone`, `source`) — cheap predicates, touches no cards. Tier 2 = subject selection — the only
  tier that produces a value. Today the subject filter runs *first* (`emitter.ts:86`); reorder it.
- **RETURN CONTRACT, the crux.** `null` = did not activate · `[]` = activated, carries nothing ·
  non-empty = activated, carries these. One extracted function (`selectSubjects`) owns it.
  ```
  ANY_OF   → matches.length === 0 ? null : matches
  ALL_OF   → raw.length > 0 && all raw match ? raw : null
  ```
  `ALL_OF` must reject an empty set or it is vacuously true and fires on every subject-less signal.
  Its payload is always the full raw set, so it is a **pure gate refinement** — it buys nothing on
  the carrying side. Driving card: *"Destroy all your own characters. If they were all 1-cost, …"*
  (note it must filter on `COST`, not `POWER` — see the snapshot caveat below).
- **`SubjectMatch` is MANDATORY on every subject-carrying activation**, deliberately verbose. An
  optional field makes a forgotten filter silent, and the effect it breaks is On-Play — the most
  common in the game — by turning "when this is played" into "when *anyone* plays a character".
  Verbosity is not a cost in practice: real filters are `ANY_OF: opponent's characters`, not
  `ANY_OF: ANY`.
- **NO `NONE` MEMBER.** `signalSubjects` switches on nothing but `signal.type`, so subject-carrying
  is a *static property of the signal type* and `NONE` can never be false for a well-formed
  definition — a check that can only pass is not a check. Once signals carry subjects the partition
  is structural (`Extract<GameSignal, { subjects: … }>`), needs no hand-maintained list, and cannot
  drift. Phase-keyed activations then have no `subject` field at all, because the type says so.
- **Board-wide "all" is a `BoardCondition`, not a subject quantifier.** *"If you have 5 characters
  and all are {Navy}"* asks about the character area, which no signal named. Authoring it as
  `ALL_OF` quantifies over a one-element set and passes far too easily. Needs milestone 5's compare
  leaf: `COUNT(CHARACTERS, TYPE Navy) >= 5 AND COUNT(CHARACTERS, NOT(TYPE Navy)) == 0`.
- **`CardSnapshot` becomes the UNIVERSAL input to `evalCardFilter`.** Not a second evaluation mode —
  live evaluation is "a snapshot taken now", LKI is "a snapshot taken then", and the only difference
  is when it was captured. Otherwise `CardFilter` forks into live and frozen paths across its three
  users (activation subjects, `StatusEffectDef.affects`, actionGen gating), which is the split that
  rots. Caveat: definition-derived facts (colour, cost, name, type) survive a mutation anyway;
  mutable computed ones (power with DON, rested, prior zone) are the reason capture exists.
- **DON needs care in capture.** `getCardDef` throws for DON, and `DON_ADDED`/`DON_RESTED`/
  `DON_ATTACHED` all name DON instances. `getListenerInstanceIds` already filters DON before the
  lookup for this reason; snapshot capture must too.
- **Cost accepted: `gameLog` gets heavier**, since every signal now carries snapshots. Replay is seed
  + action log, so correctness is unaffected; this is memory only.

## Structural
- **Operations never name a player.** No `EffectOperation`/`EffectCost` carries a PlayerId. Who acts
  derives from expressions: `EvalContext.self` = controller of the activating card. `DRAW` draws for
  `self`; an opponent-acting effect says so through its filters.
- **`condition` stays on BOTH EffectDef and EffectContext** — the gate for whether the effect can be
  activated/paid at all, in place of an initial requirement step. Mid-resolution conditionals are
  RequirementSteps. (`cost` is the one removed from both — payment steps own it.)
- **`condition` is evaluated at RESOLUTION, against the live board, and failing FIZZLES** (settled
  2026-08-07). Not "never staged". The effect stages, promotes, finds its condition false and
  resolves to nothing — which is what makes the failure loggable, and what matches the physical game:
  you have already committed the card. Consumption is unaffected, since invariant 3 puts the
  boundary at the cursor entering the first ResolutionStep, which a fizzle never reaches.
  actionGen's separate read of `condition` — gating whether to *offer* an `[Activate: Main]` invoke —
  is the same predicate at a different moment, and applies to invokes only, never to `PLAY_CARD`.
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

# Deferred workstream — the pre-operation stage (milestone 6b, do NOT do piecemeal)

One function at the head of EVERY operation covering replacement/prevention hooks and continuous
"cannot be X" checks. **Snapshot capture split out into 6a** and is no longer deferred — it is a pure
read, needs none of the design below, and unblocks the subject channel on its own.

**The sizing question, still open: is it a synchronous QUERY or a SIGNAL?** A query (pure read of
`statusEffects`, shaped like `calculatePower`) covers snapshot capture + veto, keeps operations
atomic, and is cheap. A signal routed through staging/queue lets an effect resolve mid-operation,
forcing every operation to become resumable — very expensive. OPTCG protection looks overwhelmingly
continuous, so the query probably suffices. **Verify against real card text before committing.**

**Snapshots vs subjects were separated, and have been RE-COUPLED (2026-08-07 — reversal).** The
earlier call was that the matched-subject set is plain ids needing no capture-before-mutate. That
holds in isolation but loses on the whole: keeping them separate means building a subject channel of
ids, then rebuilding every consumer of it when snapshots land — and paying for `signalSubjects`,
`SubjectMatch.NONE`, the combat throw and the three early emits in the meantime, all of which
subjects-on-signals deletes outright. Re-coupled as milestone 6a; see "Subjects live on the signal".

What survives from the original call: **store the FILTERED match, never the raw signal id array.**
Re-running the filter at resolution evaluates it against a post-mutation board, which is the LKI trap
itself. That is now the governing invariant.

**Three pre-mutation emits are an early, informal stab at this same need** (audited 2026-07-25). The
convention is otherwise uniformly mutate-then-emit; exactly three sites emit early, and they are
exactly the three that will need snapshots. **Do NOT normalize them on their own** — fix the ordering
when 6a lands, so the information they reach for early has a real home. Once a subject carries a
snapshot taken before the mutation, emit ordering stops mattering and all three normalise to
mutate-then-emit.
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
**silently**. ~~So `signal.fromZone` matching must land in the SAME change as the reordering.~~
**Superseded 2026-08-07:** the captured-zone rule in 6a handles both directions uniformly, so no
`fromZone` special-case is needed — but the *silence* of the failure still stands, so the captured-zone
rule must land in the same change as the reordering.

**While in there:** `declareBlocker` and `redirectAttack` (battle.ts) mutate BEFORE validating — not
a live bug (the throw discards state) but the same shape, and a pre-op stage would absorb those
checks. Minor: `playEvent` emits `CARDS_SENT_TO_TRASH` before `EVENT_PLAYED`, causally backwards.

**DANGER on that last one (2026-08-07).** Swapping the two emits is safe. Hoisting `EVENT_PLAYED`
above the `moveCard` is NOT — the card being in the trash before `EVENT_PLAYED` fires is a game-rules
requirement, and silently breaks *"if you have 15 or more cards in your trash"* (playable at 14) and
*"if you have 6 or more cards in your hand"* (playable at 7). Pin it with a test before touching
`playEvent`. See the event-card section in CLAUDE.md.

---

# Open questions
- **Does paying a COST count as "by an effect"?** (`[Activate: Main] You may trash 1 card from your
  hand: ...`) Extremely common in OPTCG; the engine cannot currently distinguish a cost payment from
  an effect operation. **Settle BEFORE `EffectCost` execution is written.**
- ~~**Phase-keyed effects cannot activate**~~ — **SETTLED 2026-08-07.** Answer: milestone 6a. Once
  signals carry their subjects, `SignalActivation` discriminates structurally and a phase-keyed
  activation simply has no `subject` field. All three options previously listed here (optional
  `subject`, listener-as-own-subject, keying phase effects off something other than `activation`)
  are rejected — each papers over a derivation that should not exist.
- **`EFFECT_INVOKED` timing** — main-phase-only vs a general timing marker.
- **`SUBJECT_COUNT` shape.** Bare leaf (`{ kind: "SUBJECT_COUNT" }` → `subjects.length`, throw when
  absent) vs a `filter?: CardFilter` re-narrowing at consumption time. The leaf is recommended:
  scaling is already `MULTIPLY(SUBJECT_COUNT, LITERAL n)`, and a consumption-side filter re-reads a
  post-mutation board. **Settle before 1a lands** — the evaluator branch is written against it. (The
  WIP branch at `evaluator.ts:113` has a `value: AmountExpression` field that recurses without ever
  reading subjects; it is a placeholder, not a design.)

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
