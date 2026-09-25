export interface AccountState {
  /** True while the browser holds a Google session cookie. Read locally, never asked of Google. */
  signedIn: boolean;
}
