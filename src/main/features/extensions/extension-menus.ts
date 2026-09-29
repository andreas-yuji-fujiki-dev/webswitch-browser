import Gio from 'gi://Gio?version=2.0';
import WebKit from 'gi://WebKit?version=6.0';
import { matchesAny } from '~shared/match-pattern';
import type { ExtensionsService } from './extensions.service';
import type { ExtensionCall, MenuItemProps, MenuTarget } from '~types/extensions';

/**
 * `chrome.contextMenus`: items an extension adds to the menu of the page. They are appended to
 * WebKit's own menu when it opens (when the right click is on something the item asked for) and,
 * when chosen, reported to the extension with what was under the pointer.
 */
export class ExtensionMenus {
  private readonly items = new Map<string, Map<string, MenuItemProps>>();
  /** The actions of the menu on screen: they must outlive the call that built it. */
  private live: Gio.SimpleAction[] = [];
  private counter = 0;

  constructor(
    private readonly service: ExtensionsService,
    private readonly clicked: (
      extension: string,
      info: Record<string, unknown>,
      view: WebKit.WebView,
    ) => void,
  ) {}

  forget(id: string): void {
    this.items.delete(id);
  }

  handle(extension: string, call: ExtensionCall): unknown {
    const items = this.items.get(extension) ?? new Map<string, MenuItemProps>();
    this.items.set(extension, items);
    const props = (call.props ?? {}) as MenuItemProps;
    switch (call.op) {
      case 'contextMenus.create':
        if (items.has(String(props.id))) {
          throw new Error(`Cannot create item with duplicate id ${String(props.id)}`);
        }
        items.set(String(props.id), props);
        return undefined;
      case 'contextMenus.update': {
        const key = String(call.id);
        const known = items.get(key);
        if (!known) throw new Error(`Cannot find menu item with id ${key}`);
        items.set(key, { ...known, ...props, id: known.id });
        return undefined;
      }
      case 'contextMenus.remove': {
        const key = String(call.id);
        items.delete(key);
        for (const [childKey, child] of items) {
          if (child.parentId !== undefined && String(child.parentId) === key)
            items.delete(childKey);
        }
        return undefined;
      }
      default:
        items.clear();
        return undefined;
    }
  }

  /** What the pointer was over, as the menu needs to know it. */
  static targetOf(hit: WebKit.HitTestResult): MenuTarget {
    return {
      link: hit.context_is_link(),
      image: hit.context_is_image(),
      media: hit.context_is_media(),
      editable: hit.context_is_editable(),
      selection: hit.context_is_selection(),
      linkUrl: hit.context_is_link() ? hit.get_link_uri() : '',
      srcUrl: hit.context_is_image()
        ? hit.get_image_uri()
        : hit.context_is_media()
          ? hit.get_media_uri()
          : '',
    };
  }

  /** Adds the extensions' items to a menu that is about to open. */
  populate(view: WebKit.WebView, menu: WebKit.ContextMenu, target: MenuTarget): void {
    this.live = [];
    const contexts = new Set<string>(['all']);
    if (target.link) contexts.add('link');
    if (target.image) contexts.add('image');
    if (target.editable) contexts.add('editable');
    if (target.selection) contexts.add('selection');
    if (target.media) {
      contexts.add('video');
      contexts.add('audio');
    }
    if (contexts.size === 1) {
      contexts.add('page');
      contexts.add('frame');
    }
    const pageUrl = view.get_uri();
    const { linkUrl, srcUrl } = target;
    for (const extension of this.service.active()) {
      if (!(extension.manifest.permissions ?? []).includes('contextMenus')) continue;
      const own = this.items.get(extension.summary.id);
      if (!own || own.size === 0) continue;
      const shown = [...own.values()].filter(
        (item) =>
          item.visible !== false &&
          (item.contexts ?? ['page']).some((context) => contexts.has(context)) &&
          (item.documentUrlPatterns === undefined ||
            matchesAny(item.documentUrlPatterns, pageUrl)) &&
          (item.targetUrlPatterns === undefined ||
            matchesAny(item.targetUrlPatterns, linkUrl || srcUrl)),
      );
      const top = shown.filter(
        (item) => item.parentId === undefined || !own.has(String(item.parentId)),
      );
      if (top.length === 0) continue;
      const build = (item: MenuItemProps): WebKit.ContextMenuItem => {
        if (item.type === 'separator') return WebKit.ContextMenuItem.new_separator();
        const title =
          (item.title ?? '').replace(/%s/g, '').replace(/&/g, '') || extension.summary.name;
        const children = shown.filter(
          (child) => child.parentId !== undefined && String(child.parentId) === String(item.id),
        );
        if (children.length > 0) {
          const submenu = WebKit.ContextMenu.new();
          for (const child of children) submenu.append(build(child));
          return WebKit.ContextMenuItem.new_with_submenu(title, submenu);
        }
        const action = new Gio.SimpleAction({ name: `wsext-menu-${String(++this.counter)}` });
        action.set_enabled(item.enabled !== false);
        action.connect('activate', () => {
          void this.report(
            extension.summary.id,
            item,
            view,
            { pageUrl, linkUrl, srcUrl },
            contexts,
          );
        });
        this.live.push(action);
        return WebKit.ContextMenuItem.new_from_gaction(action, title, null);
      };
      menu.append(WebKit.ContextMenuItem.new_separator());
      // Several top-level items of one extension go under a submenu named after it, like Chrome does.
      if (top.length > 1) {
        const submenu = WebKit.ContextMenu.new();
        for (const item of top) submenu.append(build(item));
        menu.append(WebKit.ContextMenuItem.new_with_submenu(extension.summary.name, submenu));
      } else if (top[0]) {
        menu.append(build(top[0]));
      }
    }
  }

  private async report(
    extension: string,
    item: MenuItemProps,
    view: WebKit.WebView,
    where: { pageUrl: string; linkUrl: string; srcUrl: string },
    contexts: Set<string>,
  ): Promise<void> {
    let selectionText = '';
    if (contexts.has('selection')) {
      const value = await view
        .evaluate_javascript('String(getSelection())', -1, null, null, null)
        .catch(() => null);
      selectionText = value?.to_string() ?? '';
    }
    this.clicked(
      extension,
      {
        menuItemId: item.id,
        ...(item.parentId === undefined ? {} : { parentMenuItemId: item.parentId }),
        pageUrl: where.pageUrl,
        frameUrl: where.pageUrl,
        ...(where.linkUrl === '' ? {} : { linkUrl: where.linkUrl }),
        ...(where.srcUrl === '' ? {} : { srcUrl: where.srcUrl }),
        ...(selectionText === '' ? {} : { selectionText }),
        editable: contexts.has('editable'),
        checked: false,
        wasChecked: false,
      },
      view,
    );
  }
}
