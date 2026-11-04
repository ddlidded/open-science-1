import type { ConnectorTemplateDefinition } from './settings'

// Built-in MCP server presets surfaced in Settings → Connectors → Add connector. A preset
// pre-fills the trusted add form; credential values are always supplied locally through the
// form — the template carries required secret names only, never values.
export const DEVIN_MCP_CONNECTOR_TEMPLATE: ConnectorTemplateDefinition = {
  schemaVersion: 1,
  kind: 'open-science.connector',
  name: 'devin',
  displayName: 'Devin MCP',
  description:
    "Cognition's hosted Devin MCP server — create and steer Devin sessions, manage playbooks, knowledge and schedules, and query repository wiki docs. Requires a Devin API key sent as 'Authorization: Bearer <key>'.",
  transport: 'streamable_http',
  url: 'https://mcp.devin.ai/mcp',
  requiredSecrets: { headers: ['Authorization'] }
}
