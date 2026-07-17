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
   `winner`. `step` drives triggers, effect resolution, and phase transitions off
   `state.phase`.

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
  `DECKOUT`), and stages any card effects that listen for that `SignalType`.
- Effects are data-driven. A card definition holds `EffectDef`s
  (`src/types/effect.ts`); an activated effect becomes an `EffectRef` (staged),
  then an `EffectContext` (`currentEffect`) that the conductor steps through as a
  list of `EffectStep`s (requirement → payment → resolution).
- Effect logic is expressed with a small DSL in
  [types/expression.ts](packages/engine/src/types/expression.ts) — `CardFilter`,
  `AmountExpression`, `BoardCondition`, `TargetExpression` — evaluated by
  [evaluator.ts](packages/engine/src/evaluator.ts) against an `EvalContext`
  (`{ self, source }`).

### Work-in-progress notes

The effect system is mid-migration to the expression/DSL model. Expect stubs:
`ACTIVATE_EFFECT`, `CHOOSE_NEXT_EFFECT`, `CHOOSE_TARGETS`, and blocker handling
return "not yet implemented". [game/effects.ts](packages/engine/src/game/effects.ts)
is marked `REMOVE` and references an older shape (`pendingEffects`,
`EffectSequence`) that no longer matches the types — do not model new code on it;
use `conductor.ts` + the current `EffectContext`/`EffectStep` types instead.

### Card data

Card definitions are fetched at runtime from a remote source
(`src/database/config.ts`, `definitions.ts`) and stored immutably on
`state.definitions`. Instances (`state.instances`) are per-game mutable copies
tracked by zone in `state.playerZones`.
