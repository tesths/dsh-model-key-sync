# dsh-model-key-sync

在多台电脑上同步 **DeepSeek Harness 的模型配置与第三方 API 密钥**，走 S3 兼容存储或 WebDAV。

新电脑登录 Harness 后拉取一次，自定义模型和它们的 key 就都在了——不用再一个个重填。

<p>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-111827">
  <img alt="dsh plugin" src="https://img.shields.io/badge/topic-dsh--plugin-4D6BFE">
</p>

> ### 密钥以明文存放在云端
>
> 这是有意的取舍——与 CC Switch 一致，换来的是新机器不需要输入口令。代价很直接：
> **任何能读取那个桶或集合的人，都能读走里面全部 API key。**
> 请使用专属的应用密码，保管好云账号本身；如果只想同步模型声明，把密钥开关关掉。
> 详见[安全](#安全)一节。

## 为什么做这个

Harness 的 profile、凭据和模型声明都保存在本机。换到第二台机器时，通常要重新录入每个
provider：显示名称、端点、协议、模型清单，以及 key。

生态里已有插件同步 profile 目录和本地插件源码——例如
[`dsh-cloud-sync`](https://github.com/dickpy/dsh-cloud-sync) 明确说明它**不复制明文凭据**。
空出来的正是这一块：key。本插件补上它，并带上引用这些 key 的模型声明。

## 安装

在 Harness 里对助手说：

> 从 github:你的名字/dsh-model-key-sync 安装这个插件

它会调用 bundle 安装器完成安装。也可以指向本地目录：

> 安装 /path/to/dsh-model-key-sync 这个插件

然后刷新页面。设置里会出现 **模型密钥同步**。

需要 Harness 提供 `settings`、`credentials`、`tools` 三个服务，以及一个 `llm-pi-ai`
（或兼容）的模型适配器行。

## 配置

**设置 → 模型密钥同步 → 云同步**。

### WebDAV

| 字段 | 填什么 |
| --- | --- |
| 存储类型 | WebDAV |
| 集合地址 | `https://dav.jianguoyun.com/dav/`（坚果云），或你的 Nextcloud 路径 |
| 用户名 | 账号登录名（坚果云填邮箱） |
| 密码 | **应用密码**，不是登录密码 |
| 远端目录 | `dsh-model-key-sync` |
| 同步分组 | 任意名字，**每台机器必须一致** |

### S3 兼容

R2、OSS、B2、MinIO、AWS 都可。填桶名、区域（R2 用 `auto`）、Endpoint（AWS 留空）、
Access Key ID 与 Secret。

然后依次：**保存配置** → **保存密钥** → **测试连接** → **上传到云端**。

### 第二台机器

装好插件，打开同一个页签，填**完全相同**的值（含同步分组），点 **从云端拉取**。
状态卡片会列出写入的密钥，例如：

```
pulled · 本次涉及的密钥：ACME_API_KEY、OTHER_API_KEY
```

## 日常使用

- **手动**：改完模型后上传；到另一台机器前先拉取。
- **自动**：勾选「模型改动后自动上传」。拉取不会触发上传。
- **冲突**：不做静默覆盖。两边都改过时，拉取会被拒绝，报错会指明是 `model routes`、
  `API keys` 还是两者。勾选「强制覆盖」取云端，或上传保留本机。

## 同步范围

| 会同步 | 不会同步 |
| --- | --- |
| provider 路由：显示名称、协议、端点、模型清单、密钥引用名 | 会话、附件、插件源码 |
| 每个路由 `apiKeyEnv` 指向的 key 值 | 额度/用量历史 |
| 云端后端与同步分组的配置 | 其他设置（主题、快捷键…） |

拉取按路由名合并，并**保留没有导出的字段**——重试策略、超时、传输或兼容开关都保持本机原样。

## 云端结构

```
<remoteRoot>/v1/<syncGroup>/
├── manifest.json        格式、版本、设备、每个对象的 sha256 与大小、snapshotId
├── <provider>.json      每个路由一个文件
└── keys.json            { "ENV_NAME": "value" }
```

先写数据对象、最后写清单，因此读者不会看到指向未完成对象清单。下载时按大小和 SHA-256
校验。传输串行执行，并有总超时、空闲超时和响应体上限。

## 安全

- key 只通过 `ctx.credentials.resolve` 读出、通过 `ctx.credentials.set` 写入——与模型适配器
  读的是同一个接口。
- 上传时**不加密**。请把云端当作密钥库对待：私有桶、可吊销的应用密码、不要放在共享目录。
- 关掉「同时同步 API 密钥」就只同步模型声明。
- 谁拿到云端谁就能用你的 key；一旦怀疑泄漏，到服务商后台重置。
- 本地同步状态（`~/.dsh/model-key-sync/cloud-state.json`）只存哈希，不存 key。

## 开发

```bash
npm install
npm test                 # node test/host.mjs && node test/client.mjs
node test/host.mjs       # 106 项：设置、文件、命令通道、密钥、S3 + WebDAV
node test/client.mjs     # 63 项：两个页签在 jsdom 中的渲染与交互
```

`test/host.mjs` 会在回环地址起真实的 S3 兼容服务器和 WebDAV 服务器，驱动两个模拟设备走完
上传、拉取、幂等、冲突拒绝与强制覆盖。`test/client.mjs` 把真实客户端 bundle 加载进 jsdom，
配上一份忠实的 `configForms`/`locale`/`slots` 契约。

页面为什么要用现在这种方式和 Host 通信，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；
改动那条通道前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT
