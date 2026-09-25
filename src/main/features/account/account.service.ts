import GLib from 'gi://GLib?version=2.0';
import type WebKit from 'gi://WebKit?version=6.0';
import '../../core/webkit-async';
import { GOOGLE_ACCOUNT_URL, GOOGLE_SIGN_IN_URL } from '../../core/config';
import type { Unsubscribe } from '~types/common';
import type { AccountState } from '~types/account';

// Cookies that exist only while someone is signed in to a Google account.
const SESSION_COOKIES = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID']);
const GOOGLE_URI = 'https://accounts.google.com/';
const REFRESH_DEBOUNCE_MS = 200;

/**
 * "Signing in with Google" is just visiting Google's sign-in page: the session lives in cookies that
 * every Google site (YouTube, Gmail) and every "Sign in with Google" button already reads. This
 * service never talks to Google. It only looks at the local cookie jar to know whether the user is
 * signed in, so the menu can show it.
 */
export class AccountService {
  private signedIn = false;
  private refreshTimer: number | null = null;
  private readonly listeners = new Set<(state: AccountState) => void>();

  constructor(private readonly session: WebKit.NetworkSession) {}

  async init(): Promise<void> {
    this.signedIn = await this.readSignedIn();
    this.session.get_cookie_manager().connect('changed', () => {
      this.scheduleRefresh();
    });
  }

  getState(): AccountState {
    return { signedIn: this.signedIn };
  }

  /** Where the User button goes: the sign-in page, or the account page once signed in. */
  entryUrl(): string {
    return this.signedIn ? GOOGLE_ACCOUNT_URL : GOOGLE_SIGN_IN_URL;
  }

  onChanged(listener: (state: AccountState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async readSignedIn(): Promise<boolean> {
    const cookies = await this.session.get_cookie_manager().get_cookies(GOOGLE_URI, null);
    const now = Date.now() / 1000;
    return cookies.some((cookie) => {
      const expires = cookie.get_expires();
      return (
        SESSION_COOKIES.has(cookie.get_name()) && (expires === null || expires.to_unix() > now)
      );
    });
  }

  // Signing in or out changes several cookies at once; look once when they settle.
  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) GLib.source_remove(this.refreshTimer);
    this.refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DEBOUNCE_MS, () => {
      this.refreshTimer = null;
      void this.readSignedIn().then((signedIn) => {
        if (signedIn === this.signedIn) return;
        this.signedIn = signedIn;
        for (const listener of this.listeners) listener(this.getState());
      });
      return GLib.SOURCE_REMOVE;
    });
  }
}
