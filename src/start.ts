import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly to keep server functions protected
// from cross-site requests.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * /api/health/live and /api/health/ready are answered HERE, at the request-
 * middleware layer - not by the route files' own beforeLoad (api.health.
 * live.ts/api.health.ready.ts), even though those exist and also throw a
 * Response. Verified empirically, not assumed: a route's beforeLoad/loader
 * throwing a raw Response does NOT short-circuit to a raw HTTP response in
 * this pinned @tanstack/react-start version - it gets treated as a render
 * error and caught by __root.tsx's own error boundary instead (confirmed by
 * curling a running `wrangler dev` instance of the actual production build
 * and seeing __root.tsx's "Something went wrong!" page, not JSON). Only a
 * `Response` returned or thrown from a REQUEST middleware - errorMiddleware
 * above already proves this pattern works - is caught by start-server-core's
 * own request-handling loop (`if (err instanceof Response) return err`,
 * confirmed by reading createStartHandler.js) before routing ever runs. This
 * middleware runs first (request middleware runs in array order, and this
 * project's requestMiddleware array is deliberately ordered before
 * errorMiddleware/csrfMiddleware, though the exact JSON body these endpoints
 * return is built by buildLiveHealthPayload()/buildReadyHealthPayload(),
 * re-exported unchanged from their route files - see those files' own
 * docblocks for why the route files still exist despite the actual response
 * being delivered from here).
 */
const healthCheckMiddleware = createMiddleware().server(async ({ request, next }) => {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/health/live") {
    const { buildLiveHealthPayload } = await import("./routes/api.health.live");
    return Response.json(buildLiveHealthPayload());
  }

  if (pathname === "/api/health/ready") {
    const { buildReadyHealthPayload } = await import("./routes/api.health.ready");
    const { payload, httpStatus } = await buildReadyHealthPayload();
    return Response.json(payload, { status: httpStatus });
  }

  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [healthCheckMiddleware, errorMiddleware, csrfMiddleware],
}));
