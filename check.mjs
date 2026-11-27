// Offline integration check of the QwenWork 企业版 (dedicated domain) provider.
// Covered:
// - The enterprise host is one host: sign-in, accounts and models all go to
//   <domain>, never to an -openapi / -gateway host (those do not exist).
// - Only an https host (or a bare prefix that takes the VPC suffix) is
//   accepted; loopback, intranet suffixes, ports and paths are refused.
// - Device login, model listing, chat and refresh target that host.
// - An account without a host is refused before its token is used.
// - Chat is rewritten as QwenWork's agent_chat_generation request: the host's
//   tools ride along, and tool calls come back structured.
// - Usage reports the organisation, plan and credits from the host.
// - An enterprise account renews as "biz" with its team.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { QwenWorkAuthPlugin } from './index.mjs'
import { _internal } from './vendor/qoder.mjs'

const names = ['CLIENT_ID', 'VPC_DOMAIN', 'WEB', 'OPENAPI', 'API', 'RSA_PUBLIC_KEY', 'COSY_VERSION', 'DOMAIN', 'VPC_INSTANCE', 'REDIRECT', 'ACCOUNT_CONTEXT_PATH', 'USER_INFO_PATH', 'REFRESH_TARGET', 'TEAM_ID']
const savedEnv = Object.fromEntries(names.map(k => [k, process.env['QWENWORK_ENT_' + k]]))
const originalFetch = globalThis.fetch
const checks = []
let requests = 0
let agentChats = []
try {
  for (const k of names) delete process.env['QWENWORK_ENT_' + k]
  globalThis.fetch = () => { requests++; throw new Error('Unexpected network request') }
  const defaults = await QwenWorkAuthPlugin({ client: {} })
  assert.equal(defaults.auth.provider, 'qwenwork-ent')
  assert.equal(defaults.auth.methods.length, 1)
  const method = defaults.auth.methods[0]
  assert.ok(method.prompts?.some(p => p.key === 'domain'), 'the sign-in asks for the enterprise domain')
  const prompt = method.prompts.find(p => p.key === 'domain')
  assert.equal(typeof prompt.validate('gehua'), 'undefined')
  assert.equal(typeof prompt.validate('http://gehua.vpc.qwenwork.cn'), 'string')
  const defaultLogin = new URL((await method.authorize({ domain: 'gehua' })).url)
  assert.equal(defaultLogin.origin, 'https://gehua.vpc.qwenwork.cn')
  assert.equal(defaultLogin.pathname, '/device/selectAccounts')
  assert.equal(defaultLogin.searchParams.get('client_id'), 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
  assert.equal(defaultLogin.searchParams.get('redirect_uri'), null, 'an enterprise sign-in sends no redirect_uri')
  assert.equal(requests, 0)
  checks.push('Verified enterprise defaults produce a single-host login URL without network access')

  for (const ok of ['gehua', 'GEHUA', 'gehua.vpc.qwenwork.cn', 'https://gehua.vpc.qwenwork.cn', 'https://gehua.vpc.qwenwork.cn/']) {
    assert.equal(new URL((await method.authorize({ domain: ok })).url).origin, 'https://gehua.vpc.qwenwork.cn', ok)
  }
  for (const bad of ['http://gehua.vpc.qwenwork.cn', 'gehua.vpc.qwenwork.cn/path', 'https://gehua.vpc.qwenwork.cn:8443', 'https://user:pass@gehua.vpc.qwenwork.cn', 'gehua.vpc.qwenwork.cn?x=1', '10.0.0.1', 'x.local', 'x.internal', '']) {
    await assert.rejects(method.authorize({ domain: bad }), /企业域名|not an enterprise domain/i, bad)
  }
  checks.push('Only a single https host is accepted; loopback, ports and paths are refused')

  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const values = {
    CLIENT_ID: 'integration-fixture-client', VPC_DOMAIN: 'vpc.example.invalid',
    WEB: 'https://web.example.invalid', OPENAPI: 'https://account.example.invalid', API: 'https://model.example.invalid',
    RSA_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }), COSY_VERSION: 'fixture-version',
  }
  for (const [k, v] of Object.entries(values)) process.env['QWENWORK_ENT_' + k] = v
  for (const bad of ['http://web.example.invalid', 'https://user:pass@web.example.invalid', 'https://web.example.invalid/path']) {
    process.env.QWENWORK_ENT_WEB = bad
    await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /QWENWORK_ENT_WEB/)
  }
  process.env.QWENWORK_ENT_WEB = values.WEB
  process.env.QWENWORK_ENT_RSA_PUBLIC_KEY = 'invalid'
  await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /QWENWORK_ENT_RSA_PUBLIC_KEY/)
  process.env.QWENWORK_ENT_RSA_PUBLIC_KEY = values.RSA_PUBLIC_KEY
  process.env.QWENWORK_ENT_VPC_DOMAIN = 'https://vpc.example.invalid'
  await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /QWENWORK_ENT_VPC_DOMAIN/)
  process.env.QWENWORK_ENT_VPC_DOMAIN = values.VPC_DOMAIN
  process.env.QWENWORK_ENT_DOMAIN = 'http://acme.vpc.example.invalid'
  await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /not an enterprise domain/i)
  delete process.env.QWENWORK_ENT_DOMAIN
  checks.push('Endpoint, RSA key, suffix and preset validation reject invalid inputs')

  let auth
  let rejectRefresh = false
  const agentReplies = []
  const sse = (delta, finish = null) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) })}\n\n`
  const HOST = 'acme.vpc.example.invalid'
  globalThis.fetch = async (input, init = {}) => {
    requests++
    const url = new URL(input)
    assert.equal(url.hostname, HOST, 'every request stays on the enterprise host')
    if (url.pathname.startsWith('/api/v1/')) {
      const body = init.body ? JSON.parse(init.body) : undefined
      switch (url.pathname) {
        case '/api/v1/deviceToken/poll':
          assert.ok(url.searchParams.get('verifier'))
          return Response.json({ token: 'fixture-device-access', refresh_token: 'fixture-device-refresh', user_id: 'fixture-user', expires_in: 3600 })
        case '/api/v1/adapter/user/account-context':
          return Response.json({ data: {
            user: { id: 'fixture-user', name: 'Fixture', email: '', team_id: 'team-fixture', is_biz: true },
            organization: { orgId: 'org-fixture', orgName: 'Fixture Org', quota: { total: 5000, used: 100 } },
            plan: { name: '企业旗舰版', next_refresh_date: '2026-12-01T00:00:00Z' },
            quota: { total: 2000, used: 17.8348, remaining: 1982.1652, exceeded: false },
          } })
        case '/api/v1/deviceToken/refresh':
          assert.equal(body.target, 'biz')
          assert.equal(body.team_id, 'team-fixture')
          if (rejectRefresh) return Response.json({ error: 'expired' }, { status: 401 })
          assert.equal(body.refresh_token, 'fixture-device-refresh')
          return Response.json({ token: 'fixture-device-next', refresh_token: 'fixture-device-refresh-next', expires_in: 3600 })
        default: throw new Error('Unexpected account path: ' + url.pathname)
      }
    }
    assert.match(init.headers.Authorization, /^Bearer COSY\./)
    assert.equal(init.headers['Cosy-Version'], values.COSY_VERSION)
    const payload = JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1], 'base64'))
    assert.equal(payload.cosyVersion, values.COSY_VERSION)
    if (url.pathname === '/algo/api/v2/model/list') {
      return Response.json({ chat: [], qwork: [{ key: 'fixture-model', enable: false, display_name: 'Fixture model', max_input_tokens: 200000 }] })
    }
    if (url.pathname === '/algo/api/v2/service/pro/sse/agent_chat_generation') {
      agentChats.push(JSON.parse(_internal.decodeBody(init.body)))
      const reply = agentReplies.shift()
      if (reply instanceof Response) return reply
      if (typeof reply === 'string') return new Response(reply, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      return new Response([sse({ role: 'assistant', content: 'hello fixture reply' }), sse({}, 'stop'), 'data: {"body":"[DONE]"}\n\n'].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error('Unexpected path: ' + url.pathname)
  }
  const plugin = await QwenWorkAuthPlugin({ client: { auth: { set: async ({ path, body }) => { assert.equal(path.id, 'qwenwork-ent'); auth = body } } } })
  const config = {}
  await plugin.config(config)
  assert.deepEqual(Object.keys(config.provider), ['qwenwork-ent'])
  assert.equal(config.provider['qwenwork-ent'].name, 'QwenWork 企业版')
  assert.equal(plugin.auth.provider, 'qwenwork-ent')
  assert.equal(typeof plugin.auth.usage, 'function')
  assert.match(plugin.auth.icon, /^data:image\/png;base64,/)
  assert.equal(plugin.auth.methods.length, 1)
  const login = await plugin.auth.methods[0].authorize({ domain: 'acme' })
  const loginURL = new URL(login.url)
  assert.equal(loginURL.origin, 'https://' + HOST)
  assert.equal(loginURL.searchParams.get('client_id'), values.CLIENT_ID)
  assert.equal(loginURL.searchParams.get('redirect_uri'), null)
  auth = { ...(await login.callback()), type: 'oauth' }
  assert.equal(auth.enterpriseHost, HOST, 'the host is kept on the account')
  assert.equal(auth.accountId, 'fixture-user (' + HOST + ')')
  assert.equal(auth.refreshTarget, 'biz', 'an enterprise account renews under its organisation identity')
  assert.equal(auth.teamId, 'team-fixture')
  checks.push('Enterprise sign-in, the recorded host and device login all use the one host')

  const catalog = await plugin.provider.models({ models: {} }, { auth })
  assert.equal(catalog['fixture-model'].providerID, 'qwenwork-ent')
  assert.equal(catalog['fixture-model'].capabilities.toolcall, true)

  const usage = await plugin.auth.usage(async () => auth)
  assert.equal(usage.signIn, 'kept')
  assert.equal(usage.plan, 'Fixture Org · 企业旗舰版')
  assert.equal(usage.until, '2026-12-01T00:00:00.000Z')
  assert.deepEqual(usage.windows, [
    { name: 'Credits', used: (100 * 17.8348) / 2000, display: '17.83 / 2000 credits' },
    { name: 'Team credits', used: 2, display: '100 / 5000 credits' },
  ])
  assert.equal((await plugin.auth.usage(async () => ({ ...auth, expires: Date.now() - 1 }))).signIn, 'expired')
  assert.equal((await plugin.auth.usage(async () => ({ ...auth, enterpriseHost: '' }))).signIn, 'expired')
  checks.push('Usage reports organisation, plan and both credit pools from the host')

  await assert.rejects(plugin.auth.loader(async () => ({ ...auth, enterpriseHost: '' })), /未记录企业域名/)
  assert.deepEqual(await plugin.provider.models({ models: { keep: true } }, { auth: { ...auth, enterpriseHost: '' } }), { keep: true })
  checks.push('An account without a host is refused instead of using the public gateway')

  const loader = await plugin.auth.loader(async () => auth)
  assert.equal(loader.baseURL, 'https://' + HOST)
  const chat = (over = {}) => ({ model: 'fixture-model', messages: [{ role: 'user', content: 'fixture prompt' }], ...over })

  const plain = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ messages: [{ role: 'system', content: 'host rules' }, { role: 'user', content: 'fixture prompt' }] })) })
  assert.equal(plain.status, 200)
  const plainBody = await plain.json()
  assert.equal(plainBody.choices[0].message.content, 'hello fixture reply')
  assert.equal(agentChats[0].model_config.key, 'fixture-model')
  assert.match(agentChats[0].system[0].text, /^You are QwenWork Enterprise/)
  assert.match(agentChats[0].system[0].text, /host rules/)
  checks.push('Chat is rewritten as QwenWork\'s agent request with the host\'s system message')

  const tools = [{ type: 'function', function: { name: 'lookup', description: 'find it', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]
  agentReplies.push([
    sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const called = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools, tool_choice: 'auto' })) })
  const calledBody = await called.json()
  assert.deepEqual(calledBody.choices[0].message.tool_calls, [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }])
  checks.push('The host\'s tools ride along and a tool call comes back structured')

  agentReplies.push([
    sse({ role: 'assistant', content: 'Let me look.<tool_call>{"name":"read","arguments":{"path":"/tmp/x"}}</tool_call>' }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const inlineBody = await (await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools })) })).json()
  assert.ok(!inlineBody.choices[0].message.content.includes('<tool_call>'))
  assert.equal(inlineBody.choices[0].message.tool_calls[0].function.name, 'read')
  checks.push('Inline <tool_call> text is lifted into structured tool calls')

  agentReplies.push([sse({ role: 'assistant', content: 'done' }), sse({}, 'stop'), 'data: {"body":"[DONE]"}\n\n'].join(''))
  await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools, messages: [
    { role: 'user', content: 'fixture prompt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_fixture', content: 'the result' },
  ] })) })
  assert.ok(agentChats[3].messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_fixture' && m.content === 'the result'))
  checks.push('Tool results ride back as tool messages')

  const streamText = await (await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ stream: true })) })).text()
  assert.match(streamText, /chat.completion.chunk/)
  assert.match(streamText, /data: \[DONE\]/)
  checks.push('Stream requests return one SSE completion')

  rejectRefresh = true
  auth = { ...auth, expires: Date.now() - 1 }
  const denied = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('X-Magpie-Sign-In'), 'expired')
  checks.push('Invalid magpie access token fails before another chat request')

  rejectRefresh = false
  auth.expires = Date.now() + 3_600_000
  const leak = ['boom:', ['Bear', 'er'].join(''), 'COSY.' + ['abc', 'def'].join('.'), 'and', ['eyJhbGciOiJIUzI1NiJ9', 'payload', 'sig'].join('.')].join(' ')
  agentReplies.push(new Response(JSON.stringify({ message: leak }), { status: 500 }))
  const bodyText = await (await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })).text()
  assert.ok(!bodyText.includes('COSY.') && !/ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\./.test(bodyText), 'no token-shaped text reaches the caller')
  checks.push('Client-facing errors carry no token-shaped text')

  // The gateway's own hiccup arrives as a 400 carrying a fixed 53-byte body,
  // the same one an out-of-range max_tokens gets. Replaying such a request
  // succeeds, so the adapter asks again itself: one hiccup never reaches the
  // caller, whichever agent it is and whether or not that agent retries a 5xx.
  const hiccupBody = JSON.stringify({ code: '400', message: 'Error in upstream response' })
  agentReplies.push(new Response(hiccupBody, { status: 400 }))
  const absorbed = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(absorbed.status, 200, 'a single hiccup is retried inside the adapter')
  assert.equal((await absorbed.json()).choices[0].message.content, 'hello fixture reply')
  checks.push('An upstream hiccup is retried inside the adapter, not shown to the caller')

  // one that outlasts the retries is still reported, and as retryable
  for (let i = 0; i < 4; i++) agentReplies.push(new Response(hiccupBody, { status: 400 }))
  const persistent = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(persistent.status, 503, 'a hiccup that outlasts the retries is reported retryable')
  assert.match((await persistent.json()).error.message, /Error in upstream response/)
  checks.push('A hiccup outlasting the retries comes back retryable, not as a bad request')

  process.env.QWENWORK_ENT_DOMAIN = HOST
  const preset = await QwenWorkAuthPlugin({ client: {} })
  assert.equal(preset.auth.methods[0].prompts.length, 0)
  assert.equal(new URL((await preset.auth.methods[0].authorize()).url).origin, 'https://' + HOST)
  const presetConfig = {}
  await preset.config(presetConfig)
  assert.equal(presetConfig.provider['qwenwork-ent'].api, 'https://' + HOST)
  delete process.env.QWENWORK_ENT_DOMAIN
  process.env.QWENWORK_ENT_VPC_INSTANCE = 'acme'
  const alias = await QwenWorkAuthPlugin({ client: {} })
  assert.equal(alias.auth.methods[0].prompts.length, 0)
  assert.equal(new URL((await alias.auth.methods[0].authorize()).url).origin, 'https://' + HOST)
  delete process.env.QWENWORK_ENT_VPC_INSTANCE
  checks.push('QWENWORK_ENT_DOMAIN (and the VPC_INSTANCE alias) make the sign-in non-interactive')

  const dir = new URL('./', import.meta.url)
  const report = {
    status: 'passed', kind: 'mocked enterprise provider integration; no live QwenWork requests', checks,
    sourceSha256: createHash('sha256').update(await readFile(new URL('./vendor/qoder.mjs', dir))).digest('hex'),
    adapterSha256: createHash('sha256').update(await readFile(new URL('./index.mjs', dir))).digest('hex'),
  }
  await writeFile(new URL('./verification.json', dir), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  globalThis.fetch = originalFetch
  for (const k of names) {
    if (savedEnv[k] === undefined) delete process.env['QWENWORK_ENT_' + k]
    else process.env['QWENWORK_ENT_' + k] = savedEnv[k]
  }
}
