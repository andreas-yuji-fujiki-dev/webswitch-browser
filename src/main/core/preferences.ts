import WebKit from 'gi://WebKit?version=6.0';
import type { SettingsReader } from '~types/settings';

/** The settings of a tab's web view that the user can change while the browser runs. */
export function applyTabPreferences(settings: WebKit.Settings, prefs: SettingsReader): void {
  settings.set_enable_smooth_scrolling(prefs.get('smoothScrolling'));
  settings.set_enable_page_cache(prefs.get('pageCache'));
  settings.set_media_playback_requires_user_gesture(prefs.get('blockAutoplay'));
  settings.set_enable_webgl(prefs.get('webgl'));
  // Right click > Inspect Element and the WebKit inspector depend on this. Whether F12 opens
  // anything is a keybinding now (remove the shortcut on the Keybindings page to turn it off).
  settings.set_enable_developer_extras(true);
}

/**
 * What a view is given when it is created and cannot change afterwards. With GPU compositing,
 * fixed/sticky headers jump and text flickers while scrolling fast on a 144 Hz hybrid laptop (a
 * bare WebView does it too; drawing in software did not), so the GPU is opt-in.
 */
export function applyStartupTabPreferences(settings: WebKit.Settings, prefs: SettingsReader): void {
  settings.set_hardware_acceleration_policy(
    prefs.get('gpuAcceleration')
      ? WebKit.HardwareAccelerationPolicy.ALWAYS
      : WebKit.HardwareAccelerationPolicy.NEVER,
  );
}

/** What belongs to the tabs' network session rather than to one view. */
export function applySessionPreferences(
  session: WebKit.NetworkSession,
  prefs: SettingsReader,
): void {
  session.set_itp_enabled(prefs.get('trackingPrevention'));
  session
    .get_cookie_manager()
    .set_accept_policy(
      prefs.get('thirdPartyCookies') === 'always'
        ? WebKit.CookieAcceptPolicy.ALWAYS
        : WebKit.CookieAcceptPolicy.NO_THIRD_PARTY,
    );
}
