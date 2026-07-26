import type { GameAction } from './action';
import type { GameState } from './state';
import type { PlayerId, EndReason } from './primitives';
import type { GameSeeds } from './state';
import type { Nonce } from '../rng/seeds';
import { GameSignal } from './signal';

// A single entry in the flat, chronological game log.
// The engine does not consume the log; it is a narration/replay record.
// The originating action for any entry is the nearest preceding ACTION entry.
export type LogEntry =
    | { kind: "ACTION"; action: GameAction }
    | { kind: "SIGNAL"; signal: GameSignal };

export type SecureGameSeeds = GameSeeds & {
    nonce: Nonce;
    nonceCommitment?: string;
};

export type GameRecord = {
    seeds: GameSeeds;
    gameLog: LogEntry[];
    winner: PlayerId | null;
    endReason: EndReason | null;
    turnCount: number;
};

type ServerGameRecord = Omit<GameRecord, "seeds"> & {
    seeds: SecureGameSeeds;
};