# vendor/qoder.mjs

The shared QwenWork/Qoder adapter copied from
[harwinvoid/magpie-plugin-qwenwork](https://github.com/harwinvoid/magpie-plugin-qwenwork)
(snapshot of 2026-11-26, upstream SHA-256
`448f52d9bcfe3e2f20e3eb7dffb386e5ae0d87e4f4eaf3d2e20f5c76c4d4b63b`, MIT — see
`LICENSE` here).

It is **not** byte-identical to upstream. This fork carries five small
patches, all of them the same behaviour magpie's community QwenWork plugin has:

## 1. An enterprise flagship serves everything on one host

`siteOf` returns the account's `enterpriseHost` for web, openapi and api:

```js
if (typeof a?.enterpriseHost === "string" && a.enterpriseHost) {
  const base = `https://${a.enterpriseHost}`
  return { ...site, web: base, openapi: base, api: base, vpc: a.enterpriseHost, redirect: "" }
}
```

QwenWork's flagship does **not** split into `<host>-openapi` / `<host>-gateway`
(those names are NXDOMAIN); polling them leaves the sign-in stuck.

## 2. An enterprise account renews as `biz` with its team

`refreshDevice(site, refresh, chat = false, account)` now reads the account's
own identity:

```js
const target = account?.refreshTarget ?? site.deviceRefreshTarget
body: {
  refresh_token: refresh,
  ...(target ? { target } : {}),
  ...(target === "biz" && account?.teamId ? { team_id: account.teamId } : {}),
}
```

and both call sites (`renew`, `deviceToken`) pass the account. With no
`account.refreshTarget` (a personal account) the body is exactly what upstream
sends.

## 3. The single-host sign-in is reachable from the provider

`_internal` also exports `deviceSignIn`, so `index.mjs` can start the device
flow against the enterprise's one host without the adapter's split-host VPC
method.

## 4. A hiccup in the gateway's own backend is retryable, not a bad request

The enterprise gateway answers an upstream failure with a 400 and a fixed
53-byte body, `{"code":"400","message":"Error in upstream response"}` — the
same body a genuinely out-of-range `max_tokens` gets. Replaying a request that
received one succeeds, so the 400 describes the backend, not the request:
`failure()` hands it back as a 503 so the caller retries instead of ending its
turn.

```js
if (status === 400 && /error in upstream response/i.test(msg)) return { status: 503, message: msg }
```

## 5. That hiccup is retried here, not left to the caller

Reporting it as a 503 assumes the caller retries a 5xx. Not every agent does —
one that treats 503 as final ends the turn exactly as a 400 did. So `answer()`
takes the first attempt plus a `send` that makes another, and asks again while
the failure arrived before any of the reply was passed on:

```js
const worth = !attempt.aborted && retriable(attempt.status, attempt.message)
if (!worth || n > RETRY_ATTEMPTS) return errorResponse(attempt.error)
```

`retriable()` answers the same question the 503 does: the gateway's own backend
failed, not our request. Three attempts, 400 ms doubling. A 429 is never
retried (it spends quota), a cancellation is never retried, and once the reply
has started streaming nothing is retried — a half-sent answer cannot be taken
back, so a late failure still ends the stream with an error.

Each attempt signs a fresh COSY envelope, so the retry carries a new request id
and date rather than repeating a signature the gateway may already have seen.

Everything else is upstream. The upstream `check.mjs` still passes against this
copy (personal accounts take the unchanged path). When updating from upstream,
re-apply these hunks and run both checks.
