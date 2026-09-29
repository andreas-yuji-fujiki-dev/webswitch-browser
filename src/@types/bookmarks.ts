export interface BookmarkFolder {
  id: string;
  title: string;
  /** `null` means the folder itself sits directly in the bookmarks bar. */
  parentId: string | null;
  /** Milliseconds since the epoch; kept for display, no longer for ordering (see `order`). */
  createdAt: number;
  /** Where it sits among the bar's other top-level folders and bookmarks; lower is earlier.
   * Reassigned wholesale by `reorderBar` when the user drags something, not by creation time. */
  order: number;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  /** `null` means the bookmark sits directly in the bookmarks bar, not inside a folder. */
  folderId: string | null;
  /** Milliseconds since the epoch; kept for display, no longer for ordering (see `order`). */
  addedAt: number;
  /** Where it sits among the bar's other top-level folders and bookmarks; lower is earlier.
   * Reassigned wholesale by `reorderBar` when the user drags something, not by creation time. */
  order: number;
}

export interface BookmarksState {
  folders: BookmarkFolder[];
  bookmarks: Bookmark[];
}

export interface BookmarkChanges {
  title?: string;
  folderId?: string | null;
}

/**
 * `star`: add/edit the current tab's bookmark. `bookmark`: edit one specific bookmark by id
 * (a bar item's own right-click menu). `folder`: browse one top-level folder's contents (a bar
 * folder's left click). `folder-menu`: rename or delete one folder (its right-click menu).
 * `add-menu`: the bar's own empty-space right-click menu, to add a bookmark or a folder by hand.
 */
export type BookmarkPopupKind = 'star' | 'bookmark' | 'folder' | 'folder-menu' | 'add-menu';

/** One row of the bookmarks bar, folders and bookmarks merged and sorted by `order`. */
export type BookmarkBarEntry =
  { kind: 'folder'; item: BookmarkFolder } | { kind: 'bookmark'; item: Bookmark };

/** One entry of a new drag-and-drop order for the bar, sent whole to `reorderBar`. */
export interface BookmarkOrderEntry {
  kind: 'folder' | 'bookmark';
  id: string;
}

/** A loaded item before `BookmarksService.init()`'s `order` migration has run on it: everything
 * else a `BookmarkFolder`/`Bookmark` needs, but `order` is not guaranteed yet -- a file saved
 * before that field existed still parses, and still needs a value made up for it from the old
 * creation order, so nothing about existing bookmarks is lost or reshuffled the first time this
 * runs against one. */
export type LoadedBookmarkFolder = Omit<BookmarkFolder, 'order'> & { order?: number };
export type LoadedBookmark = Omit<Bookmark, 'order'> & { order?: number };
