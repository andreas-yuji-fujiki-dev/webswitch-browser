export interface SearchEngine {
  name: string;
  /** `%s` is replaced with the URL-encoded query. */
  urlTemplate: string;
}
