# qwenwork-ent — 千问办公企业版（旗舰版 · 专属域名）接入 magpie / OpenCode

[English](README.md)

把**千问办公企业旗舰版**的专属域名（VPC）实例接成 magpie / OpenCode 的 provider：
用企业账号自己的设备登录流程登录，之后模型列表、对话、续期全部走该实例的域名，
宿主 agent 的工具随请求下发。

> 非官方插件。未经 magpie 与千问办公审阅，安装前请先看代码。
> 只做企业专属域名；个人版请用 `magpie-plugin-qwenwork`（provider `qwenwork`）。

| Provider id | 服务 | 域名规则 |
|---|---|---|
| `qwenwork-ent` | 千问办公企业版（旗舰版） | `<实例>.vpc.qwenwork.cn` 等 |

## 它和客户端做的事一致

千问办公桌面端在配置了“专属域名”后，会把三个服务整体搬到实例自己的域名上；
本插件按同一规则拼装，实例名在登录时问一次，之后记录在账号上：

| 用途 | 域名 |
|---|---|
| 登录页 | `https://<实例>.vpc.qwenwork.cn` |
| 账号 / token / 用量 | `https://<实例>-openapi.vpc.qwenwork.cn` |
| 模型目录 / 对话 | `https://<实例>-gateway.vpc.qwenwork.cn` |

企业旗舰版登录属于 `premiumIam` 身份域：**不带 `redirect_uri`**，
OAuth 客户端 ID 由企业部署配置下发（见下一节）。登录后插件会再读一次
`account-context`，把账号的组织身份（`team_id`）记在账号上，续期时按企业客户端的
`target: "biz"` 方式续期 —— 否则一小时后 token 到期就会续期失败。

## 安装

```sh
magpie plugin add github:<你的账号>/magpie-plugin-qwenwork-enterprise
magpie plugin login qwenwork-ent
magpie claude qwenwork-ent/<模型>
```

本地目录也可以直接装：

```sh
magpie plugin add /path/to/magpie-plugin-qwenwork-enterprise
```

## 先配客户端 ID（最重要）

企业旗舰版的 OAuth 客户端 ID 由企业的部署配置（profile）下发，**不是**个人版里写死的
`e883ade2-…`。插件默认用个人版 ID 兜底，多数企业网关会直接拒绝，表现为登录失败。

```sh
export QWENWORK_ENT_CLIENT_ID='<企业部署下发的 client id>'
```

## 登录：实例前缀

```sh
magpie plugin login qwenwork-ent
# 企业专属域名实例前缀（acme 对应 acme.vpc.qwenwork.cn），也可填完整域名：
# acme
```

想在脚本 / 无人值守环境里跳过提问：

```sh
export QWENWORK_ENT_VPC_INSTANCE=acme
```

以下写法都认，且都只指向同一实例（**只接受 https、不带路径/端口/查询**）：

```text
acme
acme.vpc.qwenwork.cn
https://acme.vpc.qwenwork.cn
acme-openapi.vpc.qwenwork.cn
https://acme-gateway.vpc.qwenwork.cn/
```

`http://`、IP、其他域名、带路径或端口的一律拒绝 —— 避免把企业 token 签给错误的机房。

## 企业自签 CA / 内网

Node 与 Bun 只在**进程启动时**读取 `NODE_EXTRA_CA_CERTS`，所以要在启动 magpie 之前设：

```sh
export NODE_EXTRA_CA_CERTS=/path/to/enterprise-root-ca.pem
magpie quota qwenwork-ent
```

走内网代理时按运行时使用 `HTTPS_PROXY` / `HTTP_PROXY`；插件本身不带代理逻辑。

## 用量

magpie 会在 provider 旁显示企业账号的组织、套餐与积分，数据取自实例自己的
`account-context`，不额外发请求：

| 显示项 | 来源 |
|---|---|
| 组织 · 套餐 | `organization.orgName` / `plan.name` |
| 重置时间 | `plan.next_refresh_date`，否则 `plan.next_due_date` |
| 积分 | `quota`（个人）与 `organization.quota`（团队共享），显示百分比与 `已用 / 总量 credits` |

若你的部署把账号接口放在别的路径：

```sh
export QWENWORK_ENT_ACCOUNT_CONTEXT_PATH='/api/v1/adapter/biz/...'
```

## 环境变量

前缀统一为 `QWENWORK_ENT_`，全部可选，均可写在 `defaults.json` 里。

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLIENT_ID` | 个人版 ID | **企业部署下发的 OAuth client id**，强烈建议显式设置 |
| `VPC_DOMAIN` | `vpc.qwenwork.cn` | 专属域名的后缀，一般不用改 |
| `VPC_INSTANCE` | 空 | 实例前缀；设置后登录不再提问 |
| `WEB` / `OPENAPI` / `API` | 公共网关 | 基础地址兜底；VPC 账号实际用自己的三个域名 |
| `REDIRECT` | 空 | 企业登录默认不发 `redirect_uri`，个别部署需要时再填 |
| `REFRESH_TARGET` | `c` | 设备 token 续期的兜底 target；登录识别到组织身份时按 `biz` 续期 |
| `TEAM_ID` | 空 | 组织 team id；`account-context` 没带 `team_id` 时手动补上，续期按 `biz` |
| `CLIENT_TYPE` | `6` | COSY 头 `Cosy-ClientType` |
| `BUSINESS_PRODUCT` | `qoder_work` | COSY 头 `Cosy-Business-Product` |
| `SESSION_TYPE` | `qoder_work` | 会话类型 |
| `USER_INFO_PATH` | `/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing` | 登录后取用户信息 |
| `ACCOUNT_CONTEXT_PATH` | `/api/v1/adapter/user/account-context?include=user,plan,quota` | 用量 |
| `COSY_VERSION` | `1.1.59` | COSY 版本头 |
| `RSA_PUBLIC_KEY` | 已内置 | COSY 头里包 AES 密钥用的 RSA 公钥（PEM） |

## 安全边界

- **只提供企业 VPC 登录**，不提供个人版登录方法；个人账号请用另一个插件。
- 账号上没有绑定实例时，请求在发出前就被拒绝，**不会**回落到公共网关。
- 上游错误在返回给调用方前会裁剪并脱敏 token（沿用适配层）。
- 插件只服务 chat completions 端点。

## 已知限制

- 登录依赖设备流：组织策略若强制浏览器 SSO 回调、或禁用设备授权，本插件无法登录。
- 个人 / 组织身份切换（`/api/v1/adapter/auth/switch`）未实现：插件依赖设备登录直接返回
  组织身份；若你的账号登录后没有组织权限，先在客户端切到组织身份再登录。
- 不支持 mTLS 客户端证书；企业网关若要求双向 TLS，需要在 magpie 外层做代理。
- 模型目录取实例的 `qwork` scene，按账号实际可见的模型展示。
- 企业标准版（仍走公共网关、按组织计费）请用 `qwenwork` 插件，或等标准版适配。

## 验证

```sh
node check.mjs   # 离线：假账号 + mock 上游，不发真实请求
```

覆盖 14 项：实例解析与拒绝、登录 URL、三域名路由、无实例拒绝、用量/组织展示、
工具调用（原生与内联 `<tool_call>`）、流式、续期失败、错误脱敏等。
结果写入 `verification.json`，其中记录 `vendor/qoder.mjs` 的 SHA-256。

## 来源与许可

- provider 骨架与协议编解码来自 [harwinvoid/magpie-plugin-qwenwork](https://github.com/harwinvoid/magpie-plugin-qwenwork)（MIT）。
- `vendor/qoder.mjs` 为 magpie-community 适配层副本（MIT），只打了 4 处小补丁（企业账号按组织身份续期），见 `vendor/README.md`；其余企业差异都在 `index.mjs`。
- 图标沿用千问办公应用图标，仅用于标识该产品。
- MIT。
