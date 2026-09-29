import type { Bookmark, BookmarksState } from '~types/bookmarks';
import type { BrowserApi } from '~types/browser-api';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

const NEW_FOLDER = '__new__';

/** The "Folder" field shared by the bookmark edit and add forms: the bar's own top level, every
 * existing top-level folder, and "New folder…", which reveals a name field of its own. */
function buildFolderPicker(
  state: BookmarksState,
  selectedFolderId: string | null,
): { label: HTMLLabelElement; select: HTMLSelectElement; newFolderInput: HTMLInputElement } {
  const select = el('select', 'bm-popup__select');
  const barOption = el('option', undefined, 'Bookmarks bar');
  barOption.value = '';
  select.append(barOption);
  for (const folder of state.folders.filter((candidate) => candidate.parentId === null)) {
    const option = el('option', undefined, folder.title);
    option.value = folder.id;
    select.append(option);
  }
  const newFolderOption = el('option', undefined, 'New folder…');
  newFolderOption.value = NEW_FOLDER;
  select.append(newFolderOption);
  select.value = selectedFolderId ?? '';

  const newFolderInput = el('input', 'bm-popup__input');
  newFolderInput.type = 'text';
  newFolderInput.placeholder = 'Folder name';
  newFolderInput.hidden = true;
  select.addEventListener('change', () => {
    newFolderInput.hidden = select.value !== NEW_FOLDER;
    if (!newFolderInput.hidden) newFolderInput.focus();
  });

  const label = el('label', 'bm-popup__label', 'Folder');
  label.append(select);
  return { label, select, newFolderInput };
}

/** What the picker built above resolves to, creating the typed-in new folder if that was chosen. */
async function resolveFolderId(
  api: BrowserApi,
  select: HTMLSelectElement,
  newFolderInput: HTMLInputElement,
): Promise<string | null> {
  if (select.value === NEW_FOLDER) {
    const title = newFolderInput.value.trim();
    return title ? (await api.bookmarks.addFolder(title, null)).id : null;
  }
  return select.value === '' ? null : select.value;
}

/**
 * The add/edit form for one bookmark: name, which folder, Remove, Done. With `bookmarkId`, edits
 * that specific bookmark (a bar item's right-click); without it, the star's own behavior -- the
 * current active tab's bookmark, added fresh if it does not have one yet.
 */
async function mountBookmarkEditView(
  root: HTMLElement,
  api: BrowserApi,
  bookmarkId?: string,
): Promise<void> {
  const tabsState = await api.tabs.getState();
  const active = tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId);
  const state = await api.bookmarks.get();
  const existing: Bookmark | null = bookmarkId
    ? (state.bookmarks.find((bookmark) => bookmark.id === bookmarkId) ?? null)
    : ((active ? state.bookmarks.find((bookmark) => bookmark.url === active.url) : undefined) ??
      null);

  const wrapper = el('div', 'bm-popup');
  wrapper.append(el('h2', 'bm-popup__header', existing ? 'Edit bookmark' : 'Bookmark added'));

  const titleInput = el('input', 'bm-popup__input');
  titleInput.type = 'text';
  titleInput.value = existing?.title ?? active?.title ?? active?.url ?? '';
  const titleLabel = el('label', 'bm-popup__label', 'Name');
  titleLabel.append(titleInput);

  const {
    label: folderLabel,
    select,
    newFolderInput,
  } = buildFolderPicker(state, existing?.folderId ?? null);

  const actions = el('div', 'bm-popup__actions');
  const removeButton = el('button', 'bm-popup__button bm-popup__button--danger', 'Remove');
  const doneButton = el('button', 'bm-popup__button bm-popup__button--primary', 'Done');
  actions.append(removeButton, doneButton);

  removeButton.addEventListener('click', () => {
    void (async () => {
      if (existing) await api.bookmarks.remove(existing.id);
      await api.bookmarks.closePopup();
    })();
  });
  doneButton.addEventListener('click', () => {
    void (async () => {
      const folderId = await resolveFolderId(api, select, newFolderInput);
      const title = titleInput.value.trim();
      if (existing) {
        await api.bookmarks.update(existing.id, { title, folderId });
      } else if (active) {
        await api.bookmarks.add(active.url, title, folderId);
      }
      await api.bookmarks.closePopup();
    })();
  });

  wrapper.append(titleLabel, folderLabel, newFolderInput, actions);
  root.append(wrapper);
  titleInput.focus();
  titleInput.select();
}

/** A folder's own contents: sub-folders (from "Add folder here…" in its right-click menu) first,
 * then its bookmarks; click a sub-folder to browse into it the same way (swapping this same
 * popover's own content in place), a bookmark to go there, or remove the folder itself. */
async function mountFolderView(
  root: HTMLElement,
  api: BrowserApi,
  folderId: string,
): Promise<void> {
  const state = await api.bookmarks.get();
  const folder = state.folders.find((candidate) => candidate.id === folderId);
  const subFolders = state.folders.filter((candidate) => candidate.parentId === folderId);
  const items = state.bookmarks.filter((bookmark) => bookmark.folderId === folderId);

  const wrapper = el('div', 'bm-popup');
  wrapper.append(el('h2', 'bm-popup__header', folder?.title ?? 'Folder'));

  const list = el('div', 'bm-popup__list');
  if (subFolders.length === 0 && items.length === 0) {
    list.append(el('p', 'bm-popup__empty', 'Nothing in this folder yet.'));
  }
  for (const subFolder of subFolders) {
    const row = el('button', 'bm-popup__row');
    const glyph = icon('folder');
    glyph.classList.add('icon--filled');
    row.append(glyph, el('span', 'bm-popup__row-label', subFolder.title));
    row.addEventListener('click', () => {
      root.replaceChildren();
      void mountFolderView(root, api, subFolder.id);
    });
    list.append(row);
  }
  for (const bookmark of items) {
    const row = el('button', 'bm-popup__row');
    const glyph = icon('star');
    glyph.classList.add('icon--filled');
    row.append(glyph, el('span', 'bm-popup__row-label', bookmark.title));
    row.title = bookmark.url;
    row.addEventListener('click', () => {
      void (async () => {
        await api.navigation.navigate(bookmark.url);
        await api.bookmarks.closePopup();
      })();
    });
    list.append(row);
  }

  const removeFolder = el('button', 'bm-popup__button bm-popup__button--danger', 'Remove folder');
  removeFolder.addEventListener('click', () => {
    void (async () => {
      await api.bookmarks.removeFolder(folderId);
      await api.bookmarks.closePopup();
    })();
  });

  wrapper.append(list, removeFolder);
  root.append(wrapper);
}

/** A folder's right-click menu: rename/delete it, or add a bookmark or a sub-folder inside it
 * (swapping this same popover's own content in place, like the bar's own add-menu does). */
async function mountFolderMenuView(
  root: HTMLElement,
  api: BrowserApi,
  folderId: string,
): Promise<void> {
  const state = await api.bookmarks.get();
  const folder = state.folders.find((candidate) => candidate.id === folderId);

  const wrapper = el('div', 'bm-popup bm-popup--compact');
  wrapper.append(el('h2', 'bm-popup__header', 'Rename folder'));

  const titleInput = el('input', 'bm-popup__input');
  titleInput.type = 'text';
  titleInput.value = folder?.title ?? '';
  const titleLabel = el('label', 'bm-popup__label', 'Name');
  titleLabel.append(titleInput);

  const list = el('div', 'bm-popup__list');
  const bookmarkRow = el('button', 'bm-popup__row');
  const bookmarkGlyph = icon('star');
  bookmarkGlyph.classList.add('icon--filled');
  bookmarkRow.append(bookmarkGlyph, el('span', 'bm-popup__row-label', 'Add bookmark here…'));
  const folderRow = el('button', 'bm-popup__row');
  const folderGlyph = icon('folder');
  folderGlyph.classList.add('icon--filled');
  folderRow.append(folderGlyph, el('span', 'bm-popup__row-label', 'Add folder here…'));
  list.append(bookmarkRow, folderRow);
  bookmarkRow.addEventListener('click', () => {
    root.replaceChildren();
    void mountAddBookmarkView(root, api, folderId);
  });
  folderRow.addEventListener('click', () => {
    root.replaceChildren();
    mountAddFolderView(root, api, folderId);
  });

  const actions = el('div', 'bm-popup__actions');
  const removeButton = el('button', 'bm-popup__button bm-popup__button--danger', 'Delete');
  const doneButton = el('button', 'bm-popup__button bm-popup__button--primary', 'Save');
  actions.append(removeButton, doneButton);

  removeButton.addEventListener('click', () => {
    void (async () => {
      await api.bookmarks.removeFolder(folderId);
      await api.bookmarks.closePopup();
    })();
  });
  doneButton.addEventListener('click', () => {
    void (async () => {
      await api.bookmarks.renameFolder(folderId, titleInput.value);
      await api.bookmarks.closePopup();
    })();
  });

  wrapper.append(titleLabel, list, actions);
  root.append(wrapper);
  titleInput.focus();
  titleInput.select();
}

/** Adding a bookmark by hand (the bar's empty-space right-click menu, or a folder's own
 * right-click menu -- `parentFolderId` pre-selects that folder instead of the bar's top level).
 * Name, URL, which folder. */
async function mountAddBookmarkView(
  root: HTMLElement,
  api: BrowserApi,
  parentFolderId: string | null = null,
): Promise<void> {
  const tabsState = await api.tabs.getState();
  const active = tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId);
  const state = await api.bookmarks.get();

  const wrapper = el('div', 'bm-popup');
  wrapper.append(el('h2', 'bm-popup__header', 'New bookmark'));

  const titleInput = el('input', 'bm-popup__input');
  titleInput.type = 'text';
  titleInput.value = active?.title ?? '';
  const titleLabel = el('label', 'bm-popup__label', 'Name');
  titleLabel.append(titleInput);

  const urlInput = el('input', 'bm-popup__input');
  urlInput.type = 'text';
  urlInput.placeholder = 'https://example.com';
  urlInput.value = active && /^https?:/.test(active.url) ? active.url : '';
  const urlLabel = el('label', 'bm-popup__label', 'URL');
  urlLabel.append(urlInput);

  const { label: folderLabel, select, newFolderInput } = buildFolderPicker(state, parentFolderId);

  const actions = el('div', 'bm-popup__actions');
  const cancelButton = el('button', 'bm-popup__button', 'Cancel');
  const addButton = el('button', 'bm-popup__button bm-popup__button--primary', 'Add');
  actions.append(cancelButton, addButton);

  cancelButton.addEventListener('click', () => {
    void api.bookmarks.closePopup();
  });
  addButton.addEventListener('click', () => {
    void (async () => {
      const url = urlInput.value.trim();
      if (!url) {
        urlInput.focus();
        return;
      }
      const folderId = await resolveFolderId(api, select, newFolderInput);
      await api.bookmarks.add(url, titleInput.value.trim() || url, folderId);
      await api.bookmarks.closePopup();
    })();
  });

  wrapper.append(titleLabel, urlLabel, folderLabel, newFolderInput, actions);
  root.append(wrapper);
  titleInput.focus();
  titleInput.select();
}

/** Adding a folder by hand (the bar's empty-space right-click menu, or a folder's own right-click
 * menu to nest one inside it -- `parentFolderId`): just its name. */
function mountAddFolderView(
  root: HTMLElement,
  api: BrowserApi,
  parentFolderId: string | null = null,
): void {
  const wrapper = el('div', 'bm-popup bm-popup--compact');
  wrapper.append(el('h2', 'bm-popup__header', 'New folder'));

  const titleInput = el('input', 'bm-popup__input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Folder name';
  const titleLabel = el('label', 'bm-popup__label', 'Name');
  titleLabel.append(titleInput);

  const actions = el('div', 'bm-popup__actions');
  const cancelButton = el('button', 'bm-popup__button', 'Cancel');
  const createButton = el('button', 'bm-popup__button bm-popup__button--primary', 'Create');
  actions.append(cancelButton, createButton);

  cancelButton.addEventListener('click', () => {
    void api.bookmarks.closePopup();
  });
  createButton.addEventListener('click', () => {
    void (async () => {
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        return;
      }
      await api.bookmarks.addFolder(title, parentFolderId);
      await api.bookmarks.closePopup();
    })();
  });

  wrapper.append(titleLabel, actions);
  root.append(wrapper);
  titleInput.focus();
}

/** The bar's empty-space right-click menu: choose to add a bookmark or a folder by hand, swapping
 * this same popover's own content in place (no new native round trip to open a bigger one). */
function mountAddMenuView(root: HTMLElement, api: BrowserApi): void {
  const wrapper = el('div', 'bm-popup');
  wrapper.append(el('h2', 'bm-popup__header', 'Add to bookmarks bar'));

  const list = el('div', 'bm-popup__list');
  const bookmarkRow = el('button', 'bm-popup__row');
  const bookmarkGlyph = icon('star');
  bookmarkGlyph.classList.add('icon--filled');
  bookmarkRow.append(bookmarkGlyph, el('span', 'bm-popup__row-label', 'New bookmark…'));
  const folderRow = el('button', 'bm-popup__row');
  const folderGlyph = icon('folder');
  folderGlyph.classList.add('icon--filled');
  folderRow.append(folderGlyph, el('span', 'bm-popup__row-label', 'New folder…'));
  list.append(bookmarkRow, folderRow);

  bookmarkRow.addEventListener('click', () => {
    root.replaceChildren();
    void mountAddBookmarkView(root, api);
  });
  folderRow.addEventListener('click', () => {
    root.replaceChildren();
    mountAddFolderView(root, api);
  });

  wrapper.append(list);
  root.append(wrapper);
}

/** Mounted instead of the full browser UI when the popover loads `?view=bookmarks-popup`. */
export function mountBookmarksPopup(root: HTMLElement, api: BrowserApi): void {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('kind');
  const id = params.get('id');
  if (kind === 'folder' && id) {
    void mountFolderView(root, api, id);
  } else if (kind === 'folder-menu' && id) {
    void mountFolderMenuView(root, api, id);
  } else if (kind === 'bookmark' && id) {
    void mountBookmarkEditView(root, api, id);
  } else if (kind === 'add-menu') {
    mountAddMenuView(root, api);
  } else {
    void mountBookmarkEditView(root, api);
  }
}
