/**
 * Redirect only the bare messages landing page to Lectio's "Nyeste" folder.
 *
 * Lectio uses query parameters for server-rendered message states. In
 * particular, thread pages now canonicalize themselves to
 * `?type=visbesked&id=<threadId>`. Treating every URL without `mappeid` as the
 * landing page sends those valid states straight back to the message list.
 */
export function shouldRedirectMessagesToNewest(
  pathname: string,
  search: string,
  enabled: boolean,
): boolean {
  if (!enabled || !/\/beskeder2\.aspx$/i.test(pathname)) return false;
  return new URLSearchParams(search).size === 0;
}
