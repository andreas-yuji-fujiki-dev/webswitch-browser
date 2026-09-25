export interface HistoryEntry {
  url: string;
  title: string;
  /** Milliseconds since the epoch. Unique, so it doubles as the entry's identity. */
  visitedAt: number;
}

export interface HistoryVisit {
  url: string;
  title: string;
}
