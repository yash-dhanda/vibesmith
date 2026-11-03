import type { AgentName } from './events'

// How an agent CLI is told to start the team MCP server. The server is this same Electron binary run as plain node
// (ELECTRON_RUN_AS_NODE) on the bundled team-mcp.js, so nothing extra has to be installed on the user's computer.
export type TeamLink = { sock: string; token: string; runId: string; taskId: string; agent: AgentName; script: string; node: string }
export const SERVER = 'forge_team'
export const PERMISSION_TOOL = `mcp__${SERVER}__team_permission`

export const linkEnv = (l: TeamLink): Record<string, string> => ({ ELECTRON_RUN_AS_NODE: '1', FORGE_TEAM_SOCK: l.sock, FORGE_TEAM_TOKEN: l.token, FORGE_RUN: l.runId, FORGE_TASK: l.taskId, FORGE_AGENT: l.agent })

// An approval can wait for a person for a long time: the CLIs' default tool timeouts would cut it short.
export const TOOL_TIMEOUT_SEC = 6 * 3600

export const claudeMcpConfig = (l: TeamLink): string => JSON.stringify({ mcpServers: { [SERVER]: { command: l.node, args: [l.script], env: linkEnv(l) } } })

export const codexMcpArgs = (l: TeamLink): string[] => {
  const t = (v: unknown) => JSON.stringify(v) // JSON strings, arrays and numbers are valid TOML values
  const env = '{' + Object.entries(linkEnv(l)).map(([k, v]) => `${k}=${t(v)}`).join(',') + '}'
  return ['-c', `mcp_servers.${SERVER}.command=${t(l.node)}`, '-c', `mcp_servers.${SERVER}.args=${t([l.script])}`, '-c', `mcp_servers.${SERVER}.env=${env}`, '-c', `mcp_servers.${SERVER}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`, '-c', `mcp_servers.${SERVER}.startup_timeout_sec=30`, '-c', `mcp_servers.${SERVER}.default_tools_approval_mode="approve"`] // approve: the team tools are Forge's own, and exec cannot ask
}
