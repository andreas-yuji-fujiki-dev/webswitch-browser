import GLib from 'gi://GLib?version=2.0';
import {
  HISTORY_DEDUPE_MS,
  HISTORY_FILENAME,
  HISTORY_MAX_ENTRIES,
  HISTORY_QUERY_MAX,
} from '../../core/config';
import { appendText, readText, writeText } from '../../core/files';
import { dataDir } from '../../core/paths';
import { isWebUrl } from '../../core/url';
import type { Unsubscribe } from '~types/common';
import type { HistoryEntry, HistoryVisit } from '~types/history';

function parseEntry(line: string): HistoryEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return null;
    const { url, title, visitedAt } = value as Record<string, unknown>;
    if (typeof url !== 'string' || typeof visitedAt !== 'number') return null;
    return { url, title: typeof title === 'string' ? title : '', visitedAt };
  } catch {
    return null;
  }
}

/**
 * Pages the user visited, kept in `~/.local/share/webswitch/history.jsonl` (one JSON object per
 * line) and never sent anywhere. New visits are appended; removing or clearing rewrites the file.
 * All disk access is asynchronous and the entries live in memory, oldest first.
 */
export class HistoryService {
  readonly filePath = GLib.build_filenamev([dataDir(), HISTORY_FILENAME]);
  private entries: HistoryEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private writeQueue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    const text = await readText(this.filePath);
    if (text === null) return;
    this.entries = text
      .split('\n')
      .map(parseEntry)
      .filter((entry): entry is HistoryEntry => entry !== null)
      .sort((a, b) => a.visitedAt - b.visitedAt);
    if (this.entries.length > HISTORY_MAX_ENTRIES) {
      this.entries = this.entries.slice(-HISTORY_MAX_ENTRIES);
      this.rewrite();
    }
  }

  onChanged(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  record(visit: HistoryVisit): void {
    if (!isWebUrl(visit.url)) return;
    const now = Date.now();
    const last = this.entries.at(-1);
    if (last?.url === visit.url && now - last.visitedAt < HISTORY_DEDUPE_MS) return;

    // `visitedAt` is the entry's identity, so two visits can never share one.
    const visitedAt = last && now <= last.visitedAt ? last.visitedAt + 1 : now;
    const entry: HistoryEntry = { url: visit.url, title: visit.title, visitedAt };
    this.entries.push(entry);
    this.enqueue(() => appendText(this.filePath, `${JSON.stringify(entry)}\n`));
    this.notify();
  }

  /** Newest first. */
  query(search: string, limit: number): HistoryEntry[] {
    const max = Math.min(Math.max(Math.trunc(limit) || 0, 1), HISTORY_QUERY_MAX);
    const needle = search.trim().toLowerCase();
    const result: HistoryEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && result.length < max; i--) {
      const entry = this.entries[i];
      if (!entry) continue;
      if (
        needle === '' ||
        entry.title.toLowerCase().includes(needle) ||
        entry.url.toLowerCase().includes(needle)
      ) {
        result.push(entry);
      }
    }
    return result;
  }

  remove(visitedAt: number): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.visitedAt !== visitedAt);
    if (this.entries.length === before) return;
    this.rewrite();
    this.notify();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.rewrite();
    this.notify();
  }

  private rewrite(): void {
    const text = this.entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    this.enqueue(() => writeText(this.filePath, text));
  }

  // Writes are chained so an append can never overtake the rewrite before it.
  private enqueue(write: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(write).catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
