// QwenWork 企业版（旗舰版 · 专属域名 / VPC）provider for magpie / OpenCode.
//
// The protocol is the personal QwenWork provider's — the PKCE device flow, the
// COSY envelope and the agent_chat_generation codec all live in
// vendor/qoder.mjs — but every request goes to the account's own VPC instance,
// the hosts QwenWork's desktop client builds from its custom-domain setting:
//
//   https://<instance>.vpc.qwenwork.cn           sign-in page / web
//   https://<instance>-openapi.vpc.qwenwork.cn   accounts, tokens, usage
//   https://<instance>-gateway.vpc.qwenwork.cn   models, agent_chat_generation
//
// The instance is asked once, at sign-in, and kept on the account; renewals,
// model listings and chats are served from the same hosts afterwards. An
// account that carries no instance is refused rather than sent to the public
// gateway, so an enterprise token never leaves the enterprise hosts.
//
// Enterprise (premiumIam) deployments usually ship their own OAuth client id
// in their deployment profile; set QWENWORK_ENT_CLIENT_ID to it. Without one
// the personal client id is used, which the enterprise gateway may refuse.
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

// ---- the instance's hosts ----------------------------------------------------

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

// instanceName is what the user typed as QwenWork's custom-domain prefix: a
// bare prefix ("acme"), one of the instance's hosts (acme.vpc.qwenwork.cn,
// acme-openapi.… or acme-gateway.…), or an https:// address with no path.
// Anything else (http://, an IP, another domain, a path or query) names none.
function instanceName(input, domain) {
  let e = String(input ?? '').trim().toLowerCase()
  if (!e || !domain) return undefined
  if (/^[a-z][a-z\d+.-]*:\/\//.test(e)) {
    let u
    try { u = new URL(e) } catch { return undefined }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '' && u.pathname !== '/')) return undefined
    e = u.hostname
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(e)) return undefined
  let name = e
  if (e.endsWith('.' + domain)) {
    name = e.slice(0, e.length - domain.length - 1)
    for (const suffix of ['-openapi', '-gateway']) if (name.endsWith(suffix)) name = name.slice(0, -suffix.length)
  } else if (e.includes('.')) return undefined
  return NAME_RE.test(name) && name.length <= 63 ? name : undefined
}

function requireInstance(input, domain) {
  const name = instanceName(input, domain)
  if (!name) throw new Error(`${NAME}: "${String(input ?? '').slice(0, 100)}" is not a VPC instance — enter its prefix (letters, digits, -) or https://<instance>.${domain}`)
  return name
}

// hostsFor is the instance's three hosts, the paths unchanged, as QwenWork's
// desktop builds them: <instance>.…, <instance>-openapi.… and <instance>-gateway.…
function hostsFor(name, domain) {
  return {
    web: `https://${name}.${domain}`,
    openapi: `https://${name}-openapi.${domain}`,
    api: `https://${name}-gateway.${domain}`,
  }
}

// num renders a credit count as magpie shows one: no trailing zeros, at most
// two decimals (1982.1652 -> "1982.17", 2000 -> "2000").
const num = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  return String(Math.round(n * 100) / 100)
}

// enterpriseUsage reads the account's plan, organisation and credits off its
// own instance's account-context. A deployment whose account-context lives
// elsewhere can name the path with QWENWORK_ENT_ACCOUNT_CONTEXT_PATH.
function enterpriseUsage({ domain, accountContextPath }) {
  return async (getAuth) => {
    let signIn = 'kept'
    try {
      const a = await getAuth()
      if (a?.type !== 'oauth' || !String(a.access ?? '').trim()) return { error: `${NAME}：尚未登录`, signIn: 'expired' }
      if (a.expires > 0 && a.expires <= Date.now()) return { error: `${NAME}：登录已过期，请重新登录`, signIn: 'expired' }
      const name = instanceName(a.vpc, domain)
      if (!name) return { error: `${NAME}：该账号未绑定专属域名实例，请重新登录企业版`, signIn: 'expired' }
      const res = await fetch(hostsFor(name, domain).openapi + accountContextPath, {
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
  const domain = setting('VPC_DOMAIN').toLowerCase()
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..')) throw new Error('QWENWORK_ENT_VPC_DOMAIN must be a DNS name such as vpc.qwenwork.cn')
  const clientId = setting('CLIENT_ID')
  const rsa = setting('RSA_PUBLIC_KEY').replaceAll('\\n', '\n')
  try { if (createPublicKey(rsa).asymmetricKeyType !== 'rsa') throw new Error() } catch { throw new Error('QWENWORK_ENT_RSA_PUBLIC_KEY must be an RSA public key in PEM form') }
  const instance = optional('VPC_INSTANCE') ? requireInstance(optional('VPC_INSTANCE'), domain) : undefined
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
    // Only `<instance>.<domain>` and its -openapi/-gateway hosts are served.
    vpcDomain: domain,
    // The adapter prefixes this under the host's own system messages.
    systemPrompt: 'You are QwenWork Enterprise (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.',
  }
  const { makePlugin } = await import('./vendor/qoder.mjs')
  const plugin = await makePlugin(site)({ client })

  // The adapter offers a public sign-in and, because vpcDomain is set, a VPC
  // one. This provider serves the VPC one only: an enterprise plugin should
  // never sign a personal account in, and its tokens stay on the instance.
  const vpc = plugin.auth.methods.find((m) => Array.isArray(m.prompts) && m.prompts.some((p) => p.key === 'vpc'))
  if (!vpc) throw new Error(`${NAME}: the vendored adapter offers no enterprise VPC sign-in`)
  const adapterAuthorize = vpc.authorize
  vpc.label = `登录 ${NAME}（专属域名）`
  vpc.authorize = async (inputs) => {
    const answer = await adapterAuthorize(instance ? { vpc: instance } : inputs)
    const adapterCallback = answer.callback
    return {
      ...answer,
      instructions: '在浏览器中登录企业账号，并授权这台设备',
      // An enterprise account renews under its organisation identity ("biz"
      // with its team), which the desktop also reads from account-context.
      // Record that on the account, so a renewal is signed the same way.
      async callback() {
        const account = await adapterCallback()
        try {
          const name = instanceName(account?.vpc, domain)
          if (!name) return account
          const res = await fetch(hostsFor(name, domain).openapi + accountContextPath, {
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
  if (instance) {
    vpc.prompts = []
  } else {
    vpc.prompts = [{
      type: 'text',
      key: 'vpc',
      message: `企业专属域名实例前缀（acme 对应 acme.${domain}），也可填完整域名`,
      placeholder: `acme 或 acme.${domain}`,
      validate: (v) => (instanceName(v, domain) ? undefined : `不是有效的实例：填 acme 或 https://acme.${domain}`),
    }]
  }
  plugin.auth.methods = [vpc]
  plugin.auth.icon = pluginIcon
  plugin.auth.usage = enterpriseUsage({ domain, accountContextPath })

  // An account without a VPC instance is refused before its token could be
  // signed onto the public hosts the base site names.
  const innerLoader = plugin.auth.loader
  plugin.auth.loader = async (getAuth) => {
    const a = await getAuth()
    if (a?.type === 'oauth' && !instanceName(a.vpc, domain)) throw new Error(`${NAME}：账号未绑定专属域名实例，请重新登录企业版`)
    return innerLoader(getAuth)
  }
  const innerModels = plugin.provider.models
  plugin.provider.models = async (provider, ctx) => {
    if (ctx?.auth?.type === 'oauth' && !instanceName(ctx.auth.vpc, domain)) return provider.models
    return innerModels(provider, ctx)
  }

  const innerConfig = plugin.config
  plugin.config = async (config) => {
    // a user's own api override wins over the instance's gateway
    const userApi = config?.provider?.[ID]?.api
    await innerConfig(config)
    const p = config?.provider?.[ID]
    if (p && instance && !userApi) p.api = hostsFor(instance, domain).api
  }
  return plugin
}
