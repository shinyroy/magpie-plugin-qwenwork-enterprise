# vendor/qoder.mjs

The shared QwenWork/Qoder adapter copied from
[harwinvoid/magpie-plugin-qwenwork](https://github.com/harwinvoid/magpie-plugin-qwenwork)
(snapshot of 2026-11-26, upstream SHA-256
`448f52d9bcfe3e2f20e3eb7dffb386e5ae0d87e4f4eaf3d2e20f5c76c4d4b63b`, MIT — see
`LICENSE` here).

It is **not** byte-identical to upstream: this fork carries one small patch,
because an enterprise account renews its device token under its organisation
identity (`target: "biz"` with the account's `team_id`), which the desktop client
also does. Upstream always renews as the public `"c"`.

The whole patch is four hunks:

1. `refreshDevice(site, refresh, chat = false, account)` — the account is passed
   in.
2. The refresh body becomes:

   ```js
   const target = account?.refreshTarget ?? site.deviceRefreshTarget
   body: {
     refresh_token: refresh,
     ...(target ? { target } : {}),
     ...(target === "biz" && account?.teamId ? { team_id: account.teamId } : {}),
   }
   ```

3. `renew()` passes the account: `refreshDevice(s, a.refresh, true, a)`.
4. `deviceToken()` passes the account:
   `refreshDevice(siteOf(site, a), a.deviceRefresh, !!a.deviceChat, a)`.

With no `account.refreshTarget` (a personal account) the body is exactly what
upstream sends, so nothing changes for the personal provider — verified by
running the upstream `check.mjs` against this copy.

When updating from upstream, re-apply these four hunks and re-run both
`node check.mjs` here and the upstream check.
