/**
 * Server-only client-IP extraction.
 *
 * getRequest() from "@tanstack/react-start/server" may never appear - even in
 * a dynamic import() - inside a module reachable from the client import graph;
 * the build's import protection rejects the specifier outright. Keeping it in
 * a *.server module (which client code only ever reaches through a lazy
 * import inside a handler) is the sanctioned boundary.
 */
import { getRequest } from "@tanstack/react-start/server";

import { extractClientIp } from "./uploadAbuse.server";

/** The caller's real IP, read from the actual incoming Request inside a createServerFn handler. */
export function currentClientIpFromRequest(): string {
  return extractClientIp(getRequest().headers);
}
