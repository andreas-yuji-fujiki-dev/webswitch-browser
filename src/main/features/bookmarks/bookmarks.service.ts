import GLib from 'gi://GLib?version=2.0';
import { BOOKMARKS_FILENAME } from '../../core/config';
import { readText, writeText } from '../../core/files';
import { dataDir } from '../../core/paths';
import type { Unsubscribe } from '~types/common';
import type {
  Bookmark,
  BookmarkChanges,
  BookmarkFolder,
  BookmarkOrderEntry,
  BookmarksState,
  LoadedBookmark,
  LoadedBookmarkFolder,
} from '~types/bookmarks';

function isFolder(value: unknown): value is LoadedBookmarkFolder {
  if (typeof value !== 'object' || value === null) return false;
  const { id, title, parentId, createdAt } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof title === 'string' &&
    (parentId === null || typeof parentId === 'string') &&
    typeof createdAt === 'number'
  );
}

function isBookmark(value: unknown): value is LoadedBookmark {
  if (typeof value !== 'object' || value === null) return false;
  const { id, title, url, folderId, addedAt } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof title === 'string' &&
    typeof url === 'string' &&
    (folderId === null || typeof folderId === 'string') &&
    typeof addedAt === 'number'
  );
}

/**
 * Bookmarked pages and the folders that hold them, kept as one JSON object in
 * `~/.local/share/webswitch/bookmarks.json`. A `folderId`/`parentId` of `null` means "shown
 * directly in the bookmarks bar" — there is no separate id for the bar's own top level, the way
 * Chrome has a dedicated "Bookmarks bar" folder; here the bar just shows whatever has no folder.
 */
export class BookmarksService {
  readonly filePath = GLib.build_filenamev([dataDir(), BOOKMARKS_FILENAME]);
  private folders: BookmarkFolder[] = [];
  private bookmarks: Bookmark[] = [];
  private readonly listeners = new Set<(state: BookmarksState) => void>();
  private writeQueue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    const text = await readText(this.filePath);
    if (text === null) return;
    let loadedFolders: LoadedBookmarkFolder[] = [];
    let loadedBookmarks: LoadedBookmark[] = [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) return;
      const { folders, bookmarks } = parsed as Record<string, unknown>;
      if (Array.isArray(folders)) loadedFolders = folders.filter(isFolder);
      if (Array.isArray(bookmarks)) loadedBookmarks = bookmarks.filter(isBookmark);
    } catch {
      // A corrupted file starts empty rather than crashing the browser.
    }
    // A file saved before `order` existed: give everything the same relative order it already
    // had (oldest first), all folders and bookmarks sharing one sequence, same as a fresh add.
    const byAge = [
      ...loadedFolders.map((item) => ({ item, at: item.createdAt })),
      ...loadedBookmarks.map((item) => ({ item, at: item.addedAt })),
    ].sort((a, b) => a.at - b.at);
    let migrated = false;
    byAge.forEach(({ item }, index) => {
      if (item.order === undefined) {
        item.order = index;
        migrated = true;
      }
    });
    this.folders = loadedFolders as BookmarkFolder[];
    this.bookmarks = loadedBookmarks as Bookmark[];
    if (migrated) this.persist();
  }

  private nextOrder(): number {
    const orders = [...this.folders, ...this.bookmarks].map((item) => item.order);
    return orders.length === 0 ? 0 : Math.max(...orders) + 1;
  }

  getState(): BookmarksState {
    return { folders: [...this.folders], bookmarks: [...this.bookmarks] };
  }

  onChanged(listener: (state: BookmarksState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  find(url: string): Bookmark | null {
    return this.bookmarks.find((bookmark) => bookmark.url === url) ?? null;
  }

  /** Adding a URL that is already bookmarked updates that bookmark instead of duplicating it. */
  add(url: string, title: string, folderId: string | null): Bookmark {
    const existing = this.find(url);
    if (existing) {
      existing.title = title.trim() || existing.title;
      existing.folderId = folderId;
      this.persist();
      return existing;
    }
    const bookmark: Bookmark = {
      id: GLib.uuid_string_random(),
      url,
      title: title.trim() || url,
      folderId,
      addedAt: Date.now(),
      order: this.nextOrder(),
    };
    this.bookmarks.push(bookmark);
    this.persist();
    return bookmark;
  }

  update(id: string, changes: BookmarkChanges): void {
    const bookmark = this.bookmarks.find((candidate) => candidate.id === id);
    if (!bookmark) return;
    if (changes.title !== undefined) bookmark.title = changes.title.trim() || bookmark.title;
    if (changes.folderId !== undefined) bookmark.folderId = changes.folderId;
    this.persist();
  }

  remove(id: string): void {
    const before = this.bookmarks.length;
    this.bookmarks = this.bookmarks.filter((bookmark) => bookmark.id !== id);
    if (this.bookmarks.length === before) return;
    this.persist();
  }

  addFolder(title: string, parentId: string | null): BookmarkFolder {
    const folder: BookmarkFolder = {
      id: GLib.uuid_string_random(),
      title: title.trim() || 'New folder',
      parentId,
      createdAt: Date.now(),
      order: this.nextOrder(),
    };
    this.folders.push(folder);
    this.persist();
    return folder;
  }

  renameFolder(id: string, title: string): void {
    const folder = this.folders.find((candidate) => candidate.id === id);
    if (!folder || title.trim() === '') return;
    folder.title = title.trim();
    this.persist();
  }

  /** A whole new order for the bar's top-level items, sent by the renderer after a drag-drop:
   * simplest to just renumber everything named, rather than juggle fractional positions. Ids
   * not in `order` (nested inside a folder, so not draggable in the bar) are left alone. */
  reorderBar(order: BookmarkOrderEntry[]): void {
    order.forEach((entry, index) => {
      const item =
        entry.kind === 'folder'
          ? this.folders.find((candidate) => candidate.id === entry.id)
          : this.bookmarks.find((candidate) => candidate.id === entry.id);
      if (item) item.order = index;
    });
    this.persist();
  }

  /** Also removes every bookmark and sub-folder inside it, recursively. */
  removeFolder(id: string): void {
    const toRemove = new Set<string>([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const folder of this.folders) {
        if (folder.parentId !== null && toRemove.has(folder.parentId) && !toRemove.has(folder.id)) {
          toRemove.add(folder.id);
          grew = true;
        }
      }
    }
    const before = this.folders.length;
    this.folders = this.folders.filter((folder) => !toRemove.has(folder.id));
    if (this.folders.length === before) return;
    this.bookmarks = this.bookmarks.filter(
      (bookmark) => bookmark.folderId === null || !toRemove.has(bookmark.folderId),
    );
    this.persist();
  }

  private persist(): void {
    this.emit();
    const text = JSON.stringify({ folders: this.folders, bookmarks: this.bookmarks }, null, 2);
    this.writeQueue = this.writeQueue
      .then(() => writeText(this.filePath, text))
      .catch(() => undefined);
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
