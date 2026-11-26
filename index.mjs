// QwenWork 企业版（旗舰版 · 专属域名）provider for magpie / OpenCode.
//
// The enterprise flagship serves the sign-in page, the account API and the
// model gateway on ONE host — the enterprise's own domain, as its management
// console shows it:
//
//   https://gehua.vpc.qwenwork.cn/device/selectAccounts   sign-in
//   https://gehua.vpc.qwenwork.cn/api/v1/...              accounts, tokens, usage
//   https://gehua.vpc.qwenwork.cn/algo/...                models, agent chats
//
// There is no -openapi / -gateway split on the flagship: those hosts do not
// exist (NXDOMAIN), and polling them is why a sign-in can sit at "signing in"
// forever. The host is kept on the account, so renewals, model listings and
// chats stay on it. A record without a host is refused rather than sent to the
// public gateway.
//
// The host is asked once at sign-in, or preset with QWENWORK_ENT_DOMAIN.
// Enterprise (premiumIam) deployments usually ship their own OAuth client id;
// set QWENWORK_ENT_CLIENT_ID to it.
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

const defaults = JSON.parse(readFileSync(new URL('./defaults.json', import.meta.url), 'utf8'))
// The provider's picture, as magpie reads it: a data:image URI on the auth hook.
const pluginIcon = (() => {
  try { return `data:image/png;base64,${readFileSync(new URL('./icon.png', import.meta.url)).toString('base64')}` } catch { return '' }
})()

const ID = 'qwenwork-ent'
const NAME = 'QwenWork 企业版'
const DEFAULT_ACCOUNT_CONTEXT = '/api/v1/adapter/user/account-context?include=user,plan,quota'

function setting(name) {
  const value = (process.env['QWENWORK_ENT_' + name] ?? defaults[name])?.trim()
  if (!value) throw new Error(`QWENWORK_ENT_${name} is not configured`)
  return value
}
function optional(name) {
  return (process.env['QWENWORK_ENT_' + name] ?? defaults[name] ?? '').trim() || undefined
}
function origin(name) {
  let url
  try { url = new URL(setting(name)) } catch { throw new Error(`QWENWORK_ENT_${name} must be an https address`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`QWENWORK_ENT_${name} must be an https origin`)
  return url.origin
}

// ---- the enterprise's host ---------------------------------------------------

const HOST_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/

// enterpriseHost is what the user typed: the enterprise's domain as the
// console shows it ("gehua.vpc.qwenwork.cn"), an https:// address with no
// path, or a bare prefix ("gehua") that takes the configured VPC suffix.
// Anything else (http://, an IP, a port, a path or query, a loopback or
// intranet suffix) names none.
function enterpriseHost(input, suffix) {
  let e = String(input ?? '').trim().toLowerCase()
  if (!e) return undefined
  if (/^[a-z][a-z\d+.-]*:\/\//.test(e)) {
    let u
    try { u = new URL(e) } catch { return undefined }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '' && u.pathname !== '/')) return undefined
    e = u.hostname
  } else if (e.includes('/') || e.includes(':') || e.includes('?') || e.includes('#')) return undefined
  if (!e.includes('.')) e = `${e}.${suffix}`
  if (e.length > 253 || !HOST_RE.test(e)) return undefined
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(e)) return undefined
  return e
}

function requireHost(input, suffix) {
  const host = enterpriseHost(input, suffix)
  if (!host) throw new Error(`${NAME}: "${String(input ?? '').slice(0, 100)}" is not an enterprise domain — enter gehua or https://gehua.${suffix}`)
  return host
}

// num renders a credit count as magpie shows one: no trailing zeros, at most
// two decimals (1982.1652 -> "1982.17", 2000 -> "2000").
const num = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  return String(Math.round(n * 100) / 100)
}

// enterpriseUsage reads the account's plan, organisation and credits off the
// same enterprise host. A deployment whose account-context lives elsewhere can
// name the path with QWENWORK_ENT_ACCOUNT_CONTEXT_PATH.
function enterpriseUsage({ accountContextPath }) {
  return async (getAuth) => {
    let signIn = 'kept'
    try {
      const a = await getAuth()
      if (a?.type !== 'oauth' || !String(a.access ?? '').trim()) return { error: `${NAME}：尚未登录`, signIn: 'expired' }
      if (a.expires > 0 && a.expires <= Date.now()) return { error: `${NAME}：登录已过期，请重新登录`, signIn: 'expired' }
      const host = a.enterpriseHost
      if (typeof host !== 'string' || !HOST_RE.test(host)) return { error: `${NAME}：账号未记录企业域名，请重新登录企业版`, signIn: 'expired' }
      const res = await fetch(`https://${host}${accountContextPath}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${a.access}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 401 || res.status === 403) return { error: `${NAME}：登录已失效，请重新登录`, signIn: 'expired' }
      if (!res.ok) return { error: `${NAME}：读取用量失败（HTTP ${res.status}）`, signIn }
      const ctx = (await res.json())?.data ?? {}
      const out = { signIn }
      const org = [ctx.organization?.orgName, ctx.organization?.org_name, ctx.user?.orgName, ctx.user?.org_name].find((v) => typeof v === 'string' && v.trim())?.trim() ?? ''
      const planName = typeof ctx.plan?.name === 'string' ? ctx.plan.name.trim() : ''
      if (org || planName) out.plan = [org, planName].filter(Boolean).join(' · ')
      const refresh = ctx.plan?.next_refresh_date ?? ctx.plan?.next_due_date
      if (refresh) out.until = new Date(refresh).toISOString()
      const windows = []
      const addPool = (q, label) => {
        if (!q || typeof q !== 'object' || Array.isArray(q)) return
        const total = Number(q.total)
        const remaining = Number(q.remaining)
        const used = Number.isFinite(Number(q.used)) ? Number(q.used) : total - remaining
        if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used < 0) return
        const poolName = typeof q.name === 'string' && q.name.trim() ? q.name.trim() : label
        windows.push({ name: poolName, used: Math.min(100, (100 * used) / total), display: `${num(used)} / ${num(total)} credits` })
      }
      addPool(ctx.quota, 'Credits')
      const team = ctx.organization?.quota ?? ctx.orgQuota ?? ctx.teamQuota
      if (team && team !== ctx.quota) addPool(team, 'Team credits')
      if (windows.length) out.windows = windows
      return out
    } catch (e) {
      return { error: `${NAME}：${String(e?.message ?? e)}`, signIn }
    }
  }
}

export async function QwenWorkAuthPlugin({ client }) {
  const suffix = setting('VPC_DOMAIN').toLowerCase()
  if (!HOST_RE.test(suffix)) throw new Error('QWENWORK_ENT_VPC_DOMAIN must be a DNS name such as vpc.qwenwork.cn')
  const clientId = setting('CLIENT_ID')
  const rsa = setting('RSA_PUBLIC_KEY').replaceAll('\\n', '\n')
  try { if (createPublicKey(rsa).asymmetricKeyType !== 'rsa') throw new Error() } catch { throw new Error('QWENWORK_ENT_RSA_PUBLIC_KEY must be an RSA public key in PEM form') }
  // QWENWORK_ENT_DOMAIN presets the enterprise host; VPC_INSTANCE stays as an
  // alias for a bare prefix.
  const presetInput = optional('DOMAIN') ?? optional('VPC_INSTANCE')
  const preset = presetInput ? requireHost(presetInput, suffix) : undefined
  const accountContextPath = optional('ACCOUNT_CONTEXT_PATH') ?? DEFAULT_ACCOUNT_CONTEXT
  const teamOverride = optional('TEAM_ID')
  const site = {
    id: ID, name: NAME, clientId,
    web: origin('WEB'), openapi: origin('OPENAPI'), api: origin('API'),
    rsaKey: rsa,
    cosyVersion: setting('COSY_VERSION'),
    // an enterprise sign-in sends no redirect_uri; a deployment that wants
    // one sets QWENWORK_ENT_REDIRECT
    redirect: optional('REDIRECT') ?? '',
    deviceOnly: true,
    deviceRefreshTarget: optional('REFRESH_TARGET') ?? 'c',
    modelScene: 'qwork',
    listAllModels: true,
    clientType: optional('CLIENT_TYPE') ?? '6',
    businessProduct: optional('BUSINESS_PRODUCT') ?? 'qoder_work',
    sessionType: optional('SESSION_TYPE') ?? 'qoder_work',
    userInfoPath: optional('USER_INFO_PATH') ?? '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing',
    normalizeUser: v => (v?.data ?? v)?.user ?? (v?.data ?? v),
    models: [],
    // The adapter prefixes this under the host's own system messages.
    systemPrompt: 'You are QwenWork Enterprise (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.',
  }
  const { makePlugin, _internal } = await import('./vendor/qoder.mjs')
  const plugin = await makePlugin(site)({ client })

  // One host for sign-in, accounts and models. vpc is set so the adapter
  // records "(host)" on the account and requires a named user.
  const siteFor = (host) => ({ ...site, web: `https://${host}`, openapi: `https://${host}`, api: `https://${host}`, redirect: '', vpc: host, enterpriseHost: host })

  const signIn = async (inputs) => {
    const host = preset ?? enterpriseHost(inputs?.domain, suffix)
    if (!host) throw new Error(`${NAME}：请输入企业域名（或设置 QWENWORK_ENT_DOMAIN）`)
    const answer = await _internal.deviceSignIn(siteFor(host))
    const adapterCallback = answer.callback
    return {
      ...answer,
      instructions: '在浏览器中登录企业账号，并授权这台设备',
      // An enterprise account renews under its organisation identity ("biz"
      // with its team), which the desktop also reads from account-context.
      // Record that on the account, so a renewal is signed the same way.
      async callback() {
        const account = { ...(await adapterCallback()), enterpriseHost: host }
        try {
          const res = await fetch(`https://${host}${accountContextPath}`, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${account.access}` },
            signal: AbortSignal.timeout(20_000),
          })
          if (!res.ok) return account
          const ctx = (await res.json())?.data ?? {}
          const user = ctx.user ?? {}
          const org = ctx.organization ?? {}
          const teamId = teamOverride ?? [user.team_id, user.teamId, org.team_id, org.teamId, ctx.team_id, ctx.teamId].find((v) => typeof v === 'string' && v.trim())
          const biz = !!teamOverride || user.is_biz === true || user.isBiz === true || !!teamId || !!org.orgId
          if (!biz) return account
          return { ...account, refreshTarget: 'biz', ...(teamId ? { teamId } : {}) }
        } catch {
          return account
        }
      },
    }
  }

  plugin.auth.methods = [{
    type: 'oauth',
    label: preset ? `登录 ${NAME}（${preset}）` : `登录 ${NAME}（输入企业域名）`,
    prompts: preset ? [] : [{
      type: 'text',
      key: 'domain',
      message: `企业的千问办公旗舰版域名（管理后台地址栏里的域名，如 gehua.${suffix}）`,
      placeholder: `gehua.${suffix}`,
      validate: (v) => (enterpriseHost(v, suffix) ? undefined : `不是有效域名：填 gehua 或 https://gehua.${suffix}`),
    }],
    authorize: signIn,
  }]
  plugin.auth.icon = pluginIcon
  plugin.auth.usage = enterpriseUsage({ accountContextPath })

  // An account without a host is refused before its token could be signed
  // onto the public gateway the base site names.
  const hasHost = (a) => typeof a?.enterpriseHost === 'string' && HOST_RE.test(a.enterpriseHost)
  const innerLoader = plugin.auth.loader
  plugin.auth.loader = async (getAuth) => {
    const a = await getAuth()
    if (a?.type === 'oauth' && !hasHost(a)) throw new Error(`${NAME}：账号未记录企业域名，请重新登录企业版`)
    return innerLoader(getAuth)
  }
  const innerModels = plugin.provider.models
  plugin.provider.models = async (provider, ctx) => {
    if (ctx?.auth?.type === 'oauth' && !hasHost(ctx.auth)) return provider.models
    return innerModels(provider, ctx)
  }

  const innerConfig = plugin.config
  plugin.config = async (config) => {
    // a user's own api override wins over the enterprise host
    const userApi = config?.provider?.[ID]?.api
    await innerConfig(config)
    const p = config?.provider?.[ID]
    if (p && preset && !userApi) p.api = `https://${preset}`
  }
  return plugin
}
