import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import type { DrmBrowser } from '~types/drm';
import { parseUrl } from '../../core/url';
import { chromeArguments, prepareProfile } from './drm-launch';
import { DRM_BROWSERS, DRM_HOSTS } from './drm-sites';

/**
 * WebKitGTK has no DRM, so Netflix, Spotify's web player and the like cannot play in a tab. This
 * hands those pages to a Chromium-family browser, in an app window (no tabs, no address bar) with
 * its own profile, so nothing of the user's normal profile is touched. The other browser is a
 * separate program with its own network behavior: Webswitch itself still makes no requests.
 */
export class DrmService {
  private browser: DrmBrowser | null | undefined;

  /** True when `url` is a page that needs DRM. */
  needsDrm(url: string): boolean {
    const host = parseUrl(url)?.host?.toLowerCase();
    if (!host) return false;
    return DRM_HOSTS.some((site) =>
      site.startsWith('=') ? host === site.slice(1) : host === site || host.endsWith(`.${site}`),
    );
  }

  /**
   * Opens `url` in a Chromium app window. Returns false (and does nothing) when the URL does not
   * need DRM or no capable browser is installed, so the caller can load it in the tab as usual.
   */
  handOff(url: string): boolean {
    if (!this.needsDrm(url)) return false;
    const browser = this.findBrowser();
    if (!browser) return false;
    prepareProfile();
    try {
      Gio.Subprocess.new(chromeArguments(browser.path, url, false), Gio.SubprocessFlags.NONE);
      return true;
    } catch {
      return false;
    }
  }

  /** The Chromium-family browser used for DRM pages, or null when none is installed. */
  findBrowser(): DrmBrowser | null {
    if (this.browser !== undefined) return this.browser;
    for (const { command, name } of DRM_BROWSERS) {
      const path = GLib.find_program_in_path(command);
      if (path !== null) {
        this.browser = { path, name };
        return this.browser;
      }
    }
    this.browser = null;
    return null;
  }
}
