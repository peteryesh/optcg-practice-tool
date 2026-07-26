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
  effect can be activated/paid at all. It is checked at staging/promotion and is
  carried onto the `EffectContext`; it is not a step. Conditionals that apply
  *mid*-resolution are `RequirementStep`s instead.
- **`SignalActivation` is what an effect listens for**, matched by `matchesActivation`
  in [emitter.ts](packages/engine/src/game/emitter.ts). `signal` and `subject` are the
  gate; `causeKind`, `source` and `fromZone` are optional narrowings where an omitted
  field matches anything. Two rules to know: asking for a field the signal does not
  carry **fails** rather than matching (a definition error must not fire on
  everything), and `causeKind`/`source` are deliberately separate — a `CardFilter`
  alone cannot tell "caused by a player" from "caused by an effect", since with no
  `sourceId` to test it simply fails. `cause` is mandatory on every signal.
- **Effect operations and costs never name a player.** No `EffectOperation` /
  `EffectCost` carries a `PlayerId`. Who acts is derived from the expressions:
  `EvalContext.self` is the controller of the card whose effect activated, `source`
  is that card. `DRAW` draws for `self`; an effect that makes the *opponent* act
  expresses that through its filters/target expression.

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
stage (snapshot capture + prevention checks at the head of every operation).

### Card data

Card definitions are fetched at runtime from a remote source
(`src/database/config.ts`, `definitions.ts`) and stored immutably on
`state.definitions`. Instances (`state.instances`) are per-game mutable copies
tracked by zone in `state.playerZones`.
