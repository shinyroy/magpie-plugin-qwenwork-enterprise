// Offline integration check of the QwenWork 企业版 (VPC) provider, with a fake
// account and upstream. Covered:
// - The instance prefix is what builds the three hosts, and only https
//   <instance>.vpc.* addresses (or a bare prefix) name one.
// - Device login, model listing, chat and refresh target the instance's own
//   hosts; no request goes to the public gateway.
// - An account without an instance is refused before its token is used.
// - Chat is rewritten as QwenWork's agent_chat_generation request: the host's
//   tools ride along, and tool calls come back structured.
// - Usage reports the organisation, plan and credits from the instance.
// - A lapsed sign-in fails before another chat request, and client-facing
//   errors carry no token-shaped text.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { QwenWorkAuthPlugin } from './index.mjs'
import { _internal } from './vendor/qoder.mjs'

const names = ['CLIENT_ID', 'VPC_DOMAIN', 'WEB', 'OPENAPI', 'API', 'RSA_PUBLIC_KEY', 'COSY_VERSION', 'VPC_INSTANCE', 'REDIRECT', 'ACCOUNT_CONTEXT_PATH', 'USER_INFO_PATH', 'REFRESH_TARGET']
const savedEnv = Object.fromEntries(names.map(k => [k, process.env['QWENWORK_ENT_' + k]]))
const originalFetch = globalThis.fetch
const checks = []
let requests = 0
// the agent_chat requests the mock saw, decoded
let agentChats = []
try {
  for (const k of names) delete process.env['QWENWORK_ENT_' + k]
  globalThis.fetch = () => { requests++; throw new Error('Unexpected network request') }
  const defaults = await QwenWorkAuthPlugin({ client: {} })
  assert.equal(defaults.auth.provider, 'qwenwork-ent')
  assert.equal(defaults.auth.methods.length, 1, 'the public sign-in is not offered')
  const method = defaults.auth.methods[0]
  assert.ok(method.prompts?.some(p => p.key === 'vpc'), 'the enterprise sign-in asks for the instance')
  const prompt = method.prompts.find(p => p.key === 'vpc')
  assert.equal(prompt.validate('acme'), undefined)
  assert.equal(typeof prompt.validate('bad/name'), 'string')
  const defaultLogin = new URL((await method.authorize({ vpc: 'acme' })).url)
  assert.equal(defaultLogin.origin, 'https://acme.vpc.qwenwork.cn')
  assert.equal(defaultLogin.searchParams.get('client_id'), 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
  assert.equal(defaultLogin.searchParams.get('redirect_uri'), null, 'an enterprise sign-in sends no redirect_uri')
  assert.equal(requests, 0)
  checks.push('Verified enterprise defaults produce a VPC login URL without network access')

  // Every accepted spelling of the instance names the same hosts; everything
  // else is refused before a request.
  for (const ok of ['acme', 'ACME', 'acme.vpc.qwenwork.cn', 'https://acme.vpc.qwenwork.cn', 'acme-gateway.vpc.qwenwork.cn', 'https://acme-openapi.vpc.qwenwork.cn/']) {
    assert.equal(new URL((await method.authorize({ vpc: ok })).url).origin, 'https://acme.vpc.qwenwork.cn', ok)
  }
  for (const bad of ['http://acme.vpc.qwenwork.cn', 'acme.vpc.qwenwork.cn.evil.example', 'acme/../x', '10.0.0.1', 'https://acme.vpc.qwenwork.cn/path', 'https://acme.vpc.qwenwork.cn:8443', '']) {
    await assert.rejects(method.authorize({ vpc: bad }), /not a VPC instance/i, bad)
  }
  checks.push('Only <instance>.vpc hosts are accepted, with no path, port or foreign domain')

  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const values = {
    CLIENT_ID: 'integration-fixture-client', VPC_DOMAIN: 'vpc.example.invalid',
    WEB: 'https://web.example.invalid', OPENAPI: 'https://account.example.invalid', API: 'https://model.example.invalid',
    RSA_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }), COSY_VERSION: 'fixture-version',
  }
  for (const [k, v] of Object.entries(values)) process.env['QWENWORK_ENT_' + k] = v
  for (const bad of ['http://web.example.invalid', 'https://user:pass@web.example.invalid', 'https://web.example.invalid/path', 'https://web.example.invalid?x=1']) {
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
  process.env.QWENWORK_ENT_VPC_INSTANCE = 'bad host!'
  await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /not a VPC instance/i)
  delete process.env.QWENWORK_ENT_VPC_INSTANCE
  checks.push('Endpoint, RSA key, domain and instance validation reject invalid inputs')

  let auth
  let rejectRefresh = false
  // how the mock's agent_chat answers: a list of SSE bodies, one per call
  const agentReplies = []
  const sse = (delta, finish = null) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) })}\n\n`
  globalThis.fetch = async (input, init = {}) => {
    requests++
    const url = new URL(input)
    if (url.hostname === 'acme-openapi.vpc.example.invalid') {
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
    assert.equal(url.hostname, 'acme-gateway.vpc.example.invalid', 'model traffic stays on the instance gateway')
    assert.match(init.headers.Authorization, /^Bearer COSY\./)
    assert.equal(init.headers['Cosy-Version'], values.COSY_VERSION)
    assert.equal(init.headers['Cosy-ClientType'], '6')
    assert.equal(init.headers['Cosy-Business-Product'], 'qoder_work')
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
    throw new Error('Unexpected model path: ' + url.pathname)
  }
  const plugin = await QwenWorkAuthPlugin({ client: { auth: { set: async ({ path, body }) => { assert.equal(path.id, 'qwenwork-ent'); auth = body } } } })
  const config = {}
  await plugin.config(config)
  assert.deepEqual(Object.keys(config.provider), ['qwenwork-ent'])
  assert.deepEqual(config.provider['qwenwork-ent'].models, {})
  assert.equal(config.provider['qwenwork-ent'].name, 'QwenWork 企业版')
  assert.equal(plugin.auth.provider, 'qwenwork-ent')
  assert.equal(typeof plugin.auth.usage, 'function', 'the provider reports usage')
  assert.match(plugin.auth.icon, /^data:image\/png;base64,/, 'the provider carries its own icon')
  assert.equal(plugin.auth.methods.length, 1)
  const login = await plugin.auth.methods[0].authorize({ vpc: 'acme' })
  const loginURL = new URL(login.url)
  assert.equal(loginURL.origin, 'https://acme.vpc.example.invalid')
  assert.equal(loginURL.searchParams.get('client_id'), values.CLIENT_ID)
  assert.equal(loginURL.searchParams.get('redirect_uri'), null)
  assert.match(login.instructions, /企业账号/)
  auth = { ...(await login.callback()), type: 'oauth' }
  assert.equal(auth.vpc, 'acme', 'the instance is kept on the account')
  assert.equal(auth.accountId, 'fixture-user (acme)')
  assert.equal(auth.refreshTarget, 'biz', 'an enterprise account renews under its organisation identity')
  assert.equal(auth.teamId, 'team-fixture')
  checks.push('Enterprise registration, device login and the instance on the account use the instance hosts')

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
  const usageGone = await plugin.auth.usage(async () => ({ ...auth, expires: Date.now() - 1 }))
  assert.equal(usageGone.signIn, 'expired')
  const noInstance = await plugin.auth.usage(async () => ({ ...auth, vpc: '' }))
  assert.equal(noInstance.signIn, 'expired')
  checks.push('Usage reports the organisation, plan and both credit pools from the instance')

  // An account with no instance never reaches the loader's requests.
  await assert.rejects(plugin.auth.loader(async () => ({ ...auth, vpc: '' })), /未绑定专属域名实例/)
  assert.deepEqual(await plugin.provider.models({ models: { keep: true } }, { auth: { ...auth, vpc: '' } }), { keep: true })
  checks.push('An account without an instance is refused instead of using the public hosts')

  const loader = await plugin.auth.loader(async () => auth)
  assert.equal(loader.baseURL, 'https://acme-gateway.vpc.example.invalid')
  const chat = (over = {}) => ({ model: 'fixture-model', messages: [{ role: 'user', content: 'fixture prompt' }], ...over })

  // A plain prompt: the host's system message rides along, the provider's own
  // words sit above it, and the answer comes back as one completion.
  const plain = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ messages: [{ role: 'system', content: 'host rules' }, { role: 'user', content: 'fixture prompt' }] })) })
  assert.equal(plain.status, 200)
  const plainBody = await plain.json()
  assert.equal(plainBody.choices[0].message.content, 'hello fixture reply')
  assert.equal(plainBody.choices[0].finish_reason, 'stop')
  assert.equal(agentChats[0].model_config.key, 'fixture-model')
  assert.match(agentChats[0].system[0].text, /^You are QwenWork Enterprise/)
  assert.match(agentChats[0].system[0].text, /host rules/)
  checks.push('Chat is rewritten as QwenWork\'s agent request with the host\'s system message')

  // The host's tools ride along; a native tool_calls answer comes back structured.
  const tools = [{ type: 'function', function: { name: 'lookup', description: 'find it', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]
  agentReplies.push([
    sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const called = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools, tool_choice: 'auto' })) })
  assert.equal(called.status, 200)
  const calledBody = await called.json()
  assert.deepEqual(calledBody.choices[0].message.tool_calls, [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }])
  assert.equal(calledBody.choices[0].finish_reason, 'tool_calls')
  checks.push('The host\'s tools ride along and a tool call comes back structured')

  // A model that emits its call as inline <tool_call> text has it lifted out,
  // and no markup reaches the caller.
  agentReplies.push([
    sse({ role: 'assistant', content: 'Let me look.<tool_call>{"name":"read","arguments":{"path":"/tmp/x"}}</tool_call>' }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const inline = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools })) })
  assert.equal(inline.status, 200)
  const inlineBody = await inline.json()
  assert.ok(!inlineBody.choices[0].message.content.includes('<tool_call>'), 'no markup in the text')
  assert.deepEqual(inlineBody.choices[0].message.tool_calls, [{ id: inlineBody.choices[0].message.tool_calls[0].id, type: 'function', function: { name: 'read', arguments: '{"path":"/tmp/x"}' } }])
  assert.equal(inlineBody.choices[0].finish_reason, 'tool_calls')
  checks.push('Inline <tool_call> text is lifted into structured tool calls')

  // A tool result turn maps back as QwenWork's tool message.
  agentReplies.push([sse({ role: 'assistant', content: 'done' }), sse({}, 'stop'), 'data: {"body":"[DONE]"}\n\n'].join(''))
  const withResult = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools, messages: [
    { role: 'user', content: 'fixture prompt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_fixture', content: 'the result' },
  ] })) })
  assert.equal(withResult.status, 200)
  assert.ok(agentChats[3].messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_fixture' && m.content === 'the result'))
  checks.push('Tool results ride back as tool messages')

  // Streaming keeps the SSE shape magpie's client expects.
  const streamed = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ stream: true })) })
  assert.equal(streamed.status, 200)
  const streamText = await streamed.text()
  assert.match(streamText, /chat.completion.chunk/)
  assert.match(streamText, /data: \[DONE\]/)
  checks.push('Stream requests return one SSE completion')

  // A lapsed sign-in fails before another chat request.
  rejectRefresh = true
  auth = { ...auth, expires: Date.now() - 1 }
  const denied = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('X-Magpie-Sign-In'), 'expired')
  checks.push('Invalid magpie access token fails before another chat request')

  // An upstream failure carries no token-shaped text. The fixture is built in
  // pieces so that no credential-shaped literal lives in this file.
  rejectRefresh = false
  auth.expires = Date.now() + 3_600_000
  const leak = ['boom:', ['Bear', 'er'].join(''), 'COSY.' + ['abc', 'def'].join('.'), 'and', ['eyJhbGciOiJIUzI1NiJ9', 'payload', 'sig'].join('.')].join(' ')
  agentReplies.push(new Response(JSON.stringify({ message: leak }), { status: 500 }))
  const leaked = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  const bodyText = await leaked.text()
  assert.equal(leaked.status, 500)
  assert.ok(!bodyText.includes('COSY.') && !/ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\./.test(bodyText), 'no COSY or jwt leaks in the client-facing error')
  checks.push('Client-facing errors carry no token-shaped text')

  // A non-interactive install: the instance comes from the environment, so
  // the sign-in asks nothing and the provider's api is the instance gateway.
  process.env.QWENWORK_ENT_VPC_INSTANCE = 'acme'
  const fixed = await QwenWorkAuthPlugin({ client: {} })
  assert.equal(fixed.auth.methods[0].prompts.length, 0)
  assert.equal(new URL((await fixed.auth.methods[0].authorize()).url).origin, 'https://acme.vpc.example.invalid')
  const fixedConfig = {}
  await fixed.config(fixedConfig)
  assert.equal(fixedConfig.provider['qwenwork-ent'].api, 'https://acme-gateway.vpc.example.invalid')
  delete process.env.QWENWORK_ENT_VPC_INSTANCE
  checks.push('QWENWORK_ENT_VPC_INSTANCE makes the sign-in non-interactive')

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
