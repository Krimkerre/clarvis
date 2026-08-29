"""A reverse proxy in front of code-server, for grading Stage 9's proxied axis.

**A spike, and it says so.** NERVIS.md §13.3 asks a production proxy for
authenticated access, CSRF, origin validation, secure cookies, redaction, idle
timeouts and a published browser matrix. None of that is here. This exists to
answer the questions the matrix asks — does the workbench load under a base
path, does the WebSocket upgrade survive a hop, does Clarvis behave the same —
and those are answered by forwarding bytes faithfully, which is all it does.

Run:  ravis/.venv/bin/python proxy_spike.py [--base /code] [--port 8795]
"""

from __future__ import annotations

import argparse
import asyncio
import posixpath
import sys

import httpx
import websockets
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket
import uvicorn

UPSTREAM = "http://127.0.0.1:8080"
BASE = "/code"

# Hop-by-hop headers, which belong to one connection and must not be forwarded.
HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
}


def upstream_path(path: str) -> str | None:
    """The path as code-server should see it, or `None` when it is not ours.

    **`None` is the finding.** The first version forwarded everything and only
    stripped the prefix when it happened to be there, so `/healthz` — with no
    base path at all — reached code-server through the proxy. A proxy mounted at
    a prefix that answers outside it is an open proxy to its upstream on every
    path, which is precisely §13.3's "no arbitrary upstream proxying".
    """
    # **Normalised before the prefix is tested, not after.** `/code/../healthz`
    # arrives at the app unresolved — uvicorn does not collapse it — so a naive
    # `startswith` accepted it and code-server resolved it upstream, walking out
    # of the prefix. §13.3 asks for normalised paths, and this is what that
    # sentence is protecting.
    path = posixpath.normpath(path)
    if not BASE:
        return path
    if path == BASE:
        return "/"
    if path.startswith(BASE + "/"):
        return path[len(BASE):] or "/"
    return None


def forwarded_for(host: str) -> str:
    """RFC 7239's header, which is how code-server is told the browser's host.

    `getHost` honours `Forwarded` before the Host header, so this is the
    supported way to keep the origin check running rather than fighting the
    HTTP client over which Host it sets.
    """
    return f"host={host};proto=http" if host else "proto=http"


async def forward(request: Request) -> Response:
    client: httpx.AsyncClient = request.app.state.client
    inside = upstream_path(request.url.path)
    if inside is None:
        return Response("not proxied", status_code=404)
    target = UPSTREAM + inside
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    # **The proxy has to say who the browser thinks it is talking to.**
    # code-server's `authenticateOrigin` compares the Origin header against the
    # Host — and reads `Forwarded` first when there is one. Without this the
    # upstream sees Host 127.0.0.1:8080 against Origin 127.0.0.1:8795 and
    # refuses; with the Origin *dropped* it skips the check entirely, which is
    # worse. Saying it plainly is the only version that keeps the check running
    # and passing.
    headers["forwarded"] = forwarded_for(request.headers.get("host", ""))
    body = await request.body()
    answered = await client.request(
        request.method, target, params=request.url.query, headers=headers,
        content=body or None, follow_redirects=False, timeout=30.0,
    )
    out = {k: v for k, v in answered.headers.items() if k.lower() not in HOP}
    # Base-path rewriting, and the only rewrite this spike does: an absolute
    # redirect to `/` would take a browser out of the proxy entirely.
    location = out.get("location")
    if location and location.startswith("/") and not location.startswith(BASE):
        out["location"] = BASE + location
    return Response(answered.content, status_code=answered.status_code, headers=out)


async def bridge(socket: WebSocket) -> None:
    """One WebSocket, proxied both ways — upstream first, then accepted.

    **The ordering is the finding.** The first version accepted the client
    socket and *then* dialled code-server, which turns an upstream `401` into a
    socket that opens and immediately closes: a browser reports that as a
    dropped connection, so "you are logged out" arrives looking like "the server
    fell over". Connecting first and accepting only on success makes the proxy
    tell the truth the upstream told it — and it is the shape §13.3's
    unauthorized test is asking for.
    """
    inside = upstream_path(socket.url.path)
    if inside is None:
        await socket.close(code=1008)
        return
    target = "ws://127.0.0.1:8080" + inside
    if socket.url.query:
        target += "?" + socket.url.query
    # Origin travels, because the alternative is silently disabling the
    # upstream's own CSRF defence: code-server's `authenticateOrigin` opens with
    # "A missing origin probably means the source is non-browser … let it
    # through". A proxy that strips Origin turns that into a hole, and the
    # workbench connects *because* the check never ran.
    passed = {
        name: value for name, value in socket.headers.items()
        if name.lower() in ("cookie", "origin", "sec-websocket-protocol")
    }
    passed["Forwarded"] = forwarded_for(socket.headers.get("host", ""))
    try:
        upstream = await websockets.connect(
            target, additional_headers=passed,
            max_size=None, open_timeout=10,
        )
    except Exception as failure:  # noqa: BLE001 - a refusal is an ordinary answer
        print(f"ws refused upstream: {type(failure).__name__}: {failure}", file=sys.stderr)
        # Closed without accepting, which Starlette sends as an HTTP failure
        # rather than as a WebSocket close — the client never sees a connection.
        await socket.close(code=1008)
        return

    await socket.accept()
    try:
        async def to_upstream() -> None:
            while True:
                message = await socket.receive()
                if message["type"] == "websocket.disconnect":
                    await upstream.close()
                    return
                if message.get("bytes") is not None:
                    await upstream.send(message["bytes"])
                elif message.get("text") is not None:
                    await upstream.send(message["text"])

        async def to_client() -> None:
            async for chunk in upstream:
                if isinstance(chunk, bytes):
                    await socket.send_bytes(chunk)
                else:
                    await socket.send_text(chunk)

        await asyncio.gather(to_upstream(), to_client())
    except Exception as failure:  # noqa: BLE001 - a spike reports and closes
        print(f"ws: {type(failure).__name__}: {failure}", file=sys.stderr)
    finally:
        await upstream.close()
        try:
            await socket.close()
        except Exception:
            pass


def build() -> Starlette:
    # Starlette 1.x removed `on_event`; a lifespan is the supported shape and is
    # what the real proxy would use anyway.
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(app: Starlette):
        app.state.client = httpx.AsyncClient()
        yield
        await app.state.client.aclose()

    return Starlette(lifespan=lifespan, routes=[
        WebSocketRoute("/{path:path}", bridge),
        Route("/{path:path}", forward,
              methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
    ])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="/code")
    parser.add_argument("--port", type=int, default=8795)
    arguments = parser.parse_args()
    BASE = arguments.base.rstrip("/")  # noqa: F811 - module-level switch for a spike
    globals()["BASE"] = BASE
    print(f"proxying {UPSTREAM} at http://127.0.0.1:{arguments.port}{BASE or '/'}")
    uvicorn.run(build(), host="127.0.0.1", port=arguments.port, log_level="warning")
