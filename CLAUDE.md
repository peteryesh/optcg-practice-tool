# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`sleapy` is a One Piece TCG (OPTCG) game engine and web client. It is a pnpm
workspace monorepo:

- `packages/engine` (`@optcg/engine`) — the game rules engine. A pure,
  deterministic reducer. This is where nearly all the logic lives.
- `apps/sleapy-web` (`sleapy`) — a React 19 + Vite + Tailwind + Zustand client
  that consumes the engine.

The engine is published as raw TypeScript (`main`/`types` point at
`src/index.ts`); it has no build step and is imported directly by the web app
through the workspace.

## Commands

Run from `packages/engine`:

- `pnpm test` / `pnpm test:watch` — vitest in watch mode
- `pnpm test:run` — vitest single run (use this for CI/one-shot)
- Run a single file: `pnpm test:run src/__tests__/operations/battle.test.ts`
- Run by name: `pnpm test:run -t "some test name"`

Test globals are **off** (`vitest.config.ts`) — `describe`/`it`/`expect` must be
imported explicitly. Tests live under `packages/engine/src/__tests__/`.

The engine has no standalone typecheck or lint. Type errors surface only through
the web app's build:

Run from `apps/sleapy-web`:

- `pnpm dev` — Vite dev server
- `pnpm build` — `tsc -b && vite build` (this is also the engine's typecheck path)
- `pnpm lint` — eslint

## Engine architecture

The engine models the game as `reducer(state, action) => state`. State is
immutable and every mutation goes through immer `produce`. Randomness is seeded
(`src/rng/`) so games are deterministic and replayable from `config.seeds` + the
action log.

### The core loop (this is the key concept)

1. `reducer` ([reducer.ts](packages/engine/src/reducer.ts)) validates the action,
   appends it to `gameLog`, dispatches to an `apply*` handler, clears the
   `decisionPoint`, then calls `advance`.
2. `advance` ([conductor.ts](packages/engine/src/conductor.ts)) repeatedly calls
   `step` until the game reaches a `decisionPoint` (needs player input) or a
   `winner`. `step` drives effect staging/promotion, the Trigger mechanic, and
   phase transitions off `state.phase`. A promoted effect is stepped by
   `advanceEffect` ([game/effects/stepper.ts](packages/engine/src/game/effects/stepper.ts)),
   which `step` delegates to — **one step per call**, since `advance` already loops
   to a fixed point. That branch runs ahead of the Trigger check and ahead of
   committing a new staging frame, so a resolving effect always finishes first.

So game progression is a pump: apply one player action, then auto-advance through
all forced state changes until the next decision is required. A `DecisionPoint`
(see `src/types/state.ts`) is the engine asking a specific player for a specific
kind of input.

### Decision points ↔ actions

Three files are kept in lockstep, keyed by `DecisionPoint['type']`:

- [validator.ts](packages/engine/src/validator.ts) — `validate(state, action)`
  returns an error string or `null`. `validActions` maps each decision point to
  the action types legal to answer it.
- [actionGen.ts](packages/engine/src/actionGen.ts) — `getLegalActions` generates
  the candidate actions for the current decision point, then filters them through
  `validate`.

When adding a mechanic, update the `DecisionPoint` union, `validActions`,
`actionGeneratorRouter`, and the reducer switch together.

### Layering (respect this direction of dependency)

- **actions** (`game/actions/`) — `apply*` functions invoked by the reducer, one
  per `GameAction`. Orchestrate operations.
- **operations** (`game/operations/`, incl. `zones/`) — zone-aware game-rule
  logic (play a card, draw, battle, life/don/deck manipulation). Operations
  `emit` signals.
- **mechanics** (`game/mechanics/`) — low-level state primitives (`moveCard`,
  `setActive`, `getZoneArray`, decision-point helpers). Pure state mutation, no
  game-rule intent. **Do not call mechanics like `moveCard`/`removeFromZone`
  directly at runtime** — go through an operation.

Both `game/mechanics/index.ts` and `game/operations/index.ts` barrel-export their
submodules.

### Signals & effects

- [emitter.ts](packages/engine/src/game/emitter.ts) — `emit(state, signal)` logs
  the signal, checks win conditions (lethal damage → `KNOCKOUT`, empty deck →
  `DECKOUT`), and stages the card effects whose activation lists that `SignalType`.
  Staging is currently signal-type match only — activation conditions, active-zone,
  and once-per-turn gating are not yet applied.
- Effects are data-driven. A card definition holds `EffectDef`s
  (`src/types/effect.ts`); an activated effect becomes an `EffectRef` (staged into
  `stagingFrame`, committed to `effectQueue`), then is promoted to an
  `EffectContext` (`currentEffect`). The conductor is *intended* to step that
  through its `EffectStep`s (requirement → payment → resolution), but that stepping
  is not yet implemented.
- Effect logic is expressed with a small DSL in
  [types/expression.ts](packages/engine/src/types/expression.ts) — `CardFilter`,
  `AmountExpression`, `BoardCondition`, `TargetExpression` — evaluated by
  [evaluator.ts](packages/engine/src/evaluator.ts) against an `EvalContext`
  (`{ self, source }`). Only `CardFilter` and `AmountExpression` are evaluated so
  far; `BoardCondition` and `TargetExpression` are defined but have no evaluator yet.
- `EffectDef.condition` is the **activation gate** — the board check for whether the
  effect can be activated/paid at all. It is carried onto the `EffectContext`; it is
  not a step. Conditionals that apply *mid*-resolution are `RequirementStep`s instead.
  **It is evaluated at resolution, against the live board, and failing fizzles** —
  the effect stages and promotes regardless, then resolves to nothing. "Never staged"
  was considered and rejected: it makes the failure unreportable, and it does not
  match a physical game where the card is already committed. Consumption is
  unaffected — the boundary is the cursor entering the first `ResolutionStep`, which a
  fizzle never reaches. actionGen reads the same predicate for a different purpose:
  deciding whether to *offer* an `[Activate: Main]` invoke. That gating applies to
  invokes only, never to `PLAY_CARD`.
- **Two temporal semantics, deliberately, in the same effect: subjects are frozen at
  signal time, board conditions are live at evaluation time.** "Draw 1 for each card
  discarded" must not re-derive its set from a mutated board; "if you have 15 or more
  cards in your trash" must not read a stale one. That is why subjects get snapshots
  and `BoardCondition` does not.
- **`SignalActivation` is what an effect listens for**, matched by `matchesActivation`
  in [emitter.ts](packages/engine/src/game/emitter.ts). `signal` and `subject` are the
  gate; `causeKind`, `source` and `fromZone` are optional narrowings where an omitted
  field matches anything. Two rules to know: asking for a field the signal does not
  carry **fails** rather than matching (a definition error must not fire on
  everything), and `causeKind`/`source` are deliberately separate — a `CardFilter`
  alone cannot tell "caused by a player" from "caused by an effect", since with no
  `sourceId` to test it simply fails. `cause` is mandatory on every signal.
- **Activation runs in two tiers.** Tier 1 is signal-level (`signal` plus the
  `SignalPredicates` bag: `causeKind`, `fromZone`, `source`, `phase`) — cheap
  predicates that touch no cards. Tier 2 is subject selection via `SubjectMatch`
  (`ANY_OF`/`ALL_OF`), the only tier that produces a value. `selectSubjects` in
  [emitter.ts](packages/engine/src/game/emitter.ts) owns the contract: `null` = did
  not activate, `[]` = activated and carries nothing, non-empty = carries these. The
  middle case is what lets a subject-less signal stage at all. `ALL_OF` must reject
  the empty set, or it is vacuously true and fires on every signal that named nothing.
- **`SignalActivation` is discriminated structurally** on
  `Extract<GameSignal, { subjects }>`, so a phase-keyed activation has no `subject`
  field *because the type says so* — no hand-maintained list to drift.
- **Battle is deliberately not modelled as subjects.** Combat signals name cards in
  several roles (attacker vs defender), carry no `subjects`, and fall into the
  subject-less arm, where `selectSubjects` **throws** if a card listens for one. That
  throw is a permanent design assertion, not a migration gap: "when attacking" and "on
  opponent's attack" are **phase-keyed**, watching a `BattlePhase` through the `phase`
  predicate and reading `state.currentBattle` at resolution. Never "fix" it by pushing
  combat into the flat-subjects arm.
- **A *subject* is a card the signal is about, captured as of the instant the
  signal's cause was determined** — identity, computed state at capture, and an
  optional role. Today subjects are live ids *derived* from the signal by
  `signalSubjects`; the settled direction (milestone 6a) is that signals **carry**
  their subjects as snapshots and `signalSubjects` is deleted. A subject filter
  therefore reads the board *as it was*, not as it is. The governing invariant:
  **carried subjects ≡ the set that satisfied the filter**, never the raw signal set
  — re-running a filter at resolution against a post-mutation board is the
  last-known-information trap itself.
- **Effect operations and costs never name a player.** No `EffectOperation` /
  `EffectCost` carries a `PlayerId`. Who acts is derived from the expressions:
  `EvalContext.self` is the controller of the card whose effect activated, `source`
  is that card. `DRAW` draws for `self`; an effect that makes the *opponent* act
  expresses that through its filters/target expression.

### Event cards — the play ordering is load-bearing

`playEvent` ([cards.ts:172-174](packages/engine/src/game/operations/cards.ts#L172-L174))
moves the card to `TRASH` **before** emitting `EVENT_PLAYED`. That is a game-rules
requirement, not an implementation detail. Real cards depend on it:

- *"If you have 15 or more cards in your trash, …"* — playable at 14, because the
  event itself is the 15th by the time its effect is gated.
- *"If you have 6 or more cards in your hand, draw 2"* — playable at 7, because the
  event has already left hand.

**Do not hoist `EVENT_PLAYED` above the `moveCard`.** "An event should be announced
when it is played, not after it reaches the trash" sounds right and silently breaks
every card of this shape. (Swapping the order of the two *emits* —
`CARDS_SENT_TO_TRASH` vs `EVENT_PLAYED` — is harmless; only the move must stay first.)

Consequences:

- **An event's `EffectDef.activeZone` must be `TRASH`.** The activeZone gate reads
  `card.currentZone` at emit time, which is already `TRASH`. Authoring `HAND` looks
  correct and stages nothing.
- **No predictive gating in actionGen.** `PLAY_CARD` is generated without checking the
  effect's condition, and should stay that way — gating it would require evaluating
  the condition against a hypothetical post-play board. A condition that fails simply
  resolves to nothing; surface the reason in the log rather than hiding the action.
- **An event has two distinct costs.** The DON and the card itself are spent by the
  *play action*, before the effect exists — so nothing refunds them and `abort` has
  nothing to undo. Any cost *inside* the effect is a `PaymentStep`, resolved after the
  event is already in the trash: the player is prompted to pay it and activate, or to
  decline and resolve only what does not depend on it.
- **Playing an event you cannot or will not pay for is legal and binding.** It is a
  common in-person mistake, and there are strategic reasons to decline an optional
  cost. The engine must not prevent it.
- **A condition that fails FIZZLES.** The effect stages, promotes, finds its condition
  false and resolves to nothing; the player loses the card. `EffectDef.condition` is
  evaluated at resolution against the live board — not as a staging gate — which is
  what makes the failure reportable in the log.

### Naming conventions

- **"trigger" is a reserved term.** It refers *only* to the OPTCG Trigger mechanic
  (the effect on a card dealt from life as damage — the `trigger` zone, the
  `TRIGGER` decision point, `CARD_SENT_TO_TRIGGER`). Never use
  "trigger"/`triggers`/`TRIGGERED` for general effect activation; use neutral terms
  (activation, listener, signal) instead.

### Work-in-progress notes

The **On-Play draw slice works end to end** — staging, promotion, the stepper and
`DRAW` resolution all run through the reducer, and two real cards (`OP04-045`,
`OP13-041`) are authored in `src/cards/` and tested against the registry.

Everything else is still stubbed. `ACTIVATE_EFFECT`, `CHOOSE_NEXT_EFFECT` and
`CHOOSE_TARGETS` return "not yet implemented" (validator/reducer/apply), so **two
effects staging off one signal deadlocks** — the conductor sets a
`RESOLVE_EFFECT_ORDER` decision point that no action can answer. `REQUIREMENT` and
`PAYMENT` steps throw from the stepper; every `EffectOperation` other than `DRAW`
throws from `executeResolution`. `evalBoardCondition` and `evalTargetExpression`
are unwritten, so `EffectDef.condition` is a commented-out stub in the staging
gate, and `oncePerTurn` is never read.

`signalSubjects` still throws for combat signals — they name cards in more than one
role (attacker vs defender) and a flat subject list cannot tell them apart.
Subject-less signals return `[]`, which means phase-keyed effects cannot stage,
since the subject filter has nothing to match against.

Both of those are **symptoms of subjects being derived rather than carried**, and
both are fixed by the same change (`EFFECT_PLAN.md` milestone 6a): signals gain a
`subjects` field, roles become a field on the subject, `SignalActivation`
discriminates structurally on whether that field exists, and `signalSubjects` is
deleted. Note the ids on signals are **write-only today** — populated at ~51 emit
sites, read in exactly two places, both inside `signalSubjects` itself — so that
migration has no read side to chase. Until it lands, `signalSubjects`'s throw is the
migration tracker: it means "this signal type is not supported yet".

**Signal emission ordering is deliberately inconsistent in three places.** The
convention is mutate-then-emit, and everything follows it except:

- `_removeCardFromField` ([cards.ts:193](packages/engine/src/game/operations/cards.ts#L193))
  — `CARD_REMOVED_FROM_FIELD` fires before `moveCard`, and after the DON detach.
- `takeDamage` ([life.ts:49,52](packages/engine/src/game/operations/zones/life.ts#L49-L52))
  — `DAMAGE_TAKEN` / `LIFE_DAMAGED` fire before the card moves to `trigger`.
- `resolveBattle` ([battle.ts:91-97](packages/engine/src/game/operations/battle.ts#L91-L97))
  — `BATTLE_RESOLVED` fires before the damage/K.O. consequence.

These are the three sites that need last-known-information about the subject
*before* it is destroyed, and emitting early is a partial stand-in for that. It
only helps the staging gate (which evaluates synchronously inside `emit`); effect
*resolution* still sees the post-mutation board. **Do not normalize these
individually** — the ordering is fixed as part of introducing a pre-operation
stage, whose two halves are separable: snapshot capture (milestone 6a, a pure read,
no design needed) and prevention checks (milestone 6b, the hard part). Capture is
what these three sites are reaching for. **The fix is to move the *capture* early, not
the *emit*** — once a subject carries a snapshot, the two decouple and all three
normalise to mutate-then-emit with nothing lost.

**The capture rule: always pre-mutation.** A subject is the card as it was
immediately before the cause took effect — one rule, no entry/exit split (settled
2026-08-07, superseding "capture at the point where the state the signal describes is
true"). Signals are past-tense and descriptive, so this is just what last-known
information means.

The reason there is no post-mutation case: **you never need a snapshot to read
post-mutation state, because the live board already is that state.** Snapshots exist
solely to preserve what the mutation destroys. A post-capture snapshot is a frozen
copy of a board you could still read. Concretely, `_removeCardFromField` detaches DON
*before* it emits, so `CARD_REMOVED_FROM_FIELD` is already lossy for computed power
today — pre-capture fixes that and post-capture cannot.

Capture is **not** "head of the operation" — `cardsDraw` knows a count, not which
instances, so there is no subject set to snapshot until the deck has been read.
Head-of-operation is where the *prevention* hook goes (milestone 6b); the two are
different positions and fusing them breaks the draw case.

Corollary — **`activeZone` is the zone the listener is in at emit time, and the gate
keeps reading the LIVE zone.** Once every site is mutate-then-emit that is uniform with
no special-casing: On-Play is `CHARACTERS` (moved, then emitted), an event is `TRASH`
(the convention documented above), and On-K.O. becomes `TRASH` for the same reason. The
On-K.O. row is the only change, and nothing is authored against it yet — but it must
land in the *same change* as the emit reordering, because the failure is silent staging.

Two alternatives were rejected. Reading the **captured** zone breaks On-Play: under
pre-capture that is `HAND`, which fails against `activeZone: CHARACTERS`. Narrowing
On-K.O. with `fromZone: [CHARACTERS]` fails too — the activeZone gate runs *before* the
activation is consulted, so a card already in `TRASH` is filtered out whatever the
activation says, and `CARD_REMOVED_FROM_FIELD` carries no `fromZone` field for it to
match. None is needed: that signal only fires for field departures, and `removalMethod`
discriminates K.O. from bounce within it.

### Card data

Card definitions are fetched at runtime from a remote source
(`src/database/config.ts`, `definitions.ts`) and stored immutably on
`state.definitions`. Instances (`state.instances`) are per-game mutable copies
tracked by zone in `state.playerZones`.
