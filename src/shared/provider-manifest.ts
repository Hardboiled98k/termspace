/**
 * 随应用发布的版本化 provider 清单。
 *
 * commands 仅用于展示/预设，不允许从网络覆盖，也绝不由探测器执行。
 */
export type ProviderAuthMode = 'system' | 'isolated-subscription' | 'api-key'

export interface ProviderManifestEntry {
  id: string
  displayName: string
  commands: string[]
  authModes: ProviderAuthMode[]
  fields: { id: string; label: string; envKey: string; secret: boolean; optional?: boolean; default?: string }[]
  conflictVariables: string[]
  /** 隔离登录空间靠哪个变量。`isolationCapability === 'directory'` 时必须有 */
  homeEnvKey?: string
  isolationCapability: 'directory' | 'system-shared' | 'token-only'
  quotaCapability: 'supported' | 'officially_unavailable' | 'web_only'
  /**
   * 用户在新开的终端里到底该敲什么才能登上。
   *
   * **不是可有可无的文案**：把用户扔进一个空终端只说"运行该 CLI 的 login"，
   * 认知成本全留给了他 —— 而各家的形状根本不一样，光靠猜是猜不到的：
   * claude 的登录是**进 TUI 之后的斜杠命令**，不是 shell 命令；
   * gemini / antigravity 压根没有 login 子命令，首次运行自己弹 OAuth。
   *
   * 本机逐个 `--help` 核对过（2026-07-29）。**只展示，绝不由程序执行。**
   */,
  loginHint: string
}

export const PROVIDER_MANIFEST_VERSION = 1

export const PROVIDERS: ProviderManifestEntry[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    commands: ['codex'],
    authModes: ['system', 'isolated-subscription', 'api-key'],
    fields: [{ id: 'apiKey', label: 'OpenAI API key', envKey: 'OPENAI_API_KEY', secret: true }],
    /* **建隔离账号时这些会被全部 unset**。少删一个的后果是：
       新登录空间表面建成功了，CLI 却继续走继承来的 key —— 不报错，只是账单不吭声。
       宁可多列（`env -u` 删一个本来就不存在的变量是 no-op），也不能少列。 */
    conflictVariables: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
    homeEnvKey: 'CODEX_HOME',
    isolationCapability: 'directory',
    quotaCapability: 'supported',
    loginHint: 'codex login'
  },
  {
    id: 'claude',
    displayName: 'Claude',
    commands: ['claude'],
    authModes: ['system', 'isolated-subscription', 'api-key'],
    fields: [{ id: 'apiKey', label: 'Anthropic API key', envKey: 'ANTHROPIC_API_KEY', secret: true }],
    conflictVariables: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL'
    ],
    homeEnvKey: 'CLAUDE_CONFIG_DIR',
    isolationCapability: 'directory',
    quotaCapability: 'supported',
    loginHint: 'claude auth login（老版本没有这个子命令，就先运行 claude 再输 /login）'
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    commands: ['gemini'],
    authModes: ['system', 'isolated-subscription', 'api-key'],
    fields: [{ id: 'apiKey', label: 'Gemini API key', envKey: 'GEMINI_API_KEY', secret: true }],
    conflictVariables: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    homeEnvKey: 'GEMINI_CLI_HOME',
    isolationCapability: 'directory',
    quotaCapability: 'officially_unavailable',
    loginHint: '直接运行 gemini —— 没有 login 子命令，首次启动会自己走 OAuth'
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    commands: ['copilot'],
    authModes: ['system', 'api-key'],
    fields: [{ id: 'token', label: 'GitHub token', envKey: 'COPILOT_GITHUB_TOKEN', secret: true }],
    conflictVariables: ['GH_TOKEN', 'GITHUB_TOKEN'],
    isolationCapability: 'token-only',
    quotaCapability: 'officially_unavailable',
    loginHint: 'copilot login'
  },
  {
    id: 'cursor',
    displayName: 'Cursor Agent',
    commands: ['cursor-agent'],
    authModes: ['system', 'api-key'],
    fields: [{ id: 'apiKey', label: 'Cursor API key', envKey: 'CURSOR_API_KEY', secret: true }],
    conflictVariables: [],
    isolationCapability: 'token-only',
    quotaCapability: 'officially_unavailable',
    loginHint: 'cursor-agent login'
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    commands: ['agy'],
    authModes: ['system'],
    fields: [],
    conflictVariables: [],
    isolationCapability: 'system-shared',
    quotaCapability: 'officially_unavailable',
    loginHint: '直接运行 agy —— 首次启动会自己走 OAuth'
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    commands: [],
    authModes: ['api-key'],
    fields: [
      { id: 'apiKey', label: 'OpenRouter API key', envKey: 'OPENROUTER_API_KEY', secret: true },
      {
        id: 'baseUrl',
        label: 'Base URL（可选）',
        envKey: 'OPENAI_BASE_URL',
        secret: false,
        optional: true,
        default: 'https://openrouter.ai/api/v1'
      }
    ],
    conflictVariables: [],
    isolationCapability: 'token-only',
    quotaCapability: 'officially_unavailable',
    loginHint: '不用登录：在上一步填 API key 即可'
  }
]
