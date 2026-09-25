export type Unsubscribe = () => void;

/** A parsed absolute URL. GJS has no `URL` global, so this comes from GLib.Uri (see core/url.ts). */
export interface ParsedUrl {
  /** Without the colon, lowercase: "https", "about", "file". */
  scheme: string;
  host: string | null;
  /** "https://example.com:8080"; null for URLs without a host (about:blank, file:...). */
  origin: string | null;
}
