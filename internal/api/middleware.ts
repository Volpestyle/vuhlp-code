export type Handler = (req: Request) => Promise<Response>;
export type Middleware = (req: Request, next: Handler) => Promise<Response>;

export function loggingMiddleware(logger: Console = console): Middleware {
  return async (req, next) => {
    const start = Date.now();
    const res = await next(req);
    const duration = Date.now() - start;
    logger.info("http", {
      method: req.method,
      path: new URL(req.url).pathname,
      ua: req.headers.get("user-agent") ?? "",
      duration_ms: duration,
    });
    return res;
  };
}

export function recoverMiddleware(logger: Console = console): Middleware {
  return async (req, next) => {
    try {
      return await next(req);
    } catch (err) {
      logger.error("panic", err);
      return new Response(null, { status: 500 });
    }
  };
}

export function authMiddleware(token: string): Middleware {
  const trimmed = token.trim();
  if (!trimmed) {
    return async (_, next) => next(_);
  }
  return async (req, next) => {
    const auth = req.headers.get("authorization") ?? "";
    const prefix = "Bearer ";
    if (!auth.startsWith(prefix) || auth.slice(prefix.length).trim() !== trimmed) {
      return new Response(null, { status: 401 });
    }
    return next(req);
  };
}

export function corsMiddleware(): Middleware {
  return async (req, next) => {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }
    const res = await next(req);
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

export function applyMiddleware(handler: Handler, middlewares: Middleware[]): Handler {
  return middlewares.reduceRight(
    (next, middleware) => {
      return (req) => middleware(req, next);
    },
    handler,
  );
}
