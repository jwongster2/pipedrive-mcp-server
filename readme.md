# Wiza MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the [Wiza](https://wiza.co/) contact and company enrichment API to LLM clients like Claude.

The focus is enrichment: turn a LinkedIn URL, an email, or a name + company into a verified work email, mobile phone number, current job title, location, and full firmographic context.

## Tools

| Tool | Description |
| --- | --- |
| `enrich-contact` | Start an individual reveal for one contact. Accepts a LinkedIn URL, an email, or `fullName` + `company`/`domain`. By default it polls until the reveal finishes and returns the resolved email/phone/title/location/company data. |
| `get-enrichment` | Fetch the latest status of a previously started reveal by id (use when `enrich-contact` was called with `waitForCompletion: false`, or timed out). |
| `enrich-company` | Synchronous company enrichment. Provide a name, domain, LinkedIn id, or LinkedIn slug. Returns industry, size, revenue range, funding, and location. |
| `get-credits` | Show remaining email, phone, export, and API credits on the Wiza account. |
| `create-enrichment-list` | Create a bulk list of up to 2,500 contacts. Each item can be a LinkedIn URL, email, or name + company/domain. |
| `get-list` | Get the status and metadata of a bulk list. |
| `get-list-contacts` | Once a list is `finished`, fetch the enriched contacts (filter by `people` / `valid` / `risky`). |
| `prospect-search` | Search Wiza's prospect database with structured filters (job title, role, location, company, industry, etc.) and get the total count + up to 30 sample profiles. |

## Prompts

- `enrich-by-linkedin` - Enrich a contact from a LinkedIn URL
- `enrich-by-name-and-company` - Enrich a contact from full name + company
- `company-research` - Look up firmographic data for a company
- `check-credit-balance` - Show remaining Wiza credits

## Setup

### 1. Get a Wiza API key

Generate an API key at <https://wiza.co/app/settings/api>.

### 2. Install and run locally

```bash
npm install
cp .env.example .env
# edit .env and set WIZA_API_KEY
npm run build
npm start
```

For development with hot-loading TypeScript:

```bash
npm run dev
```

### 3. Use with Claude for Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wiza": {
      "command": "node",
      "args": ["/absolute/path/to/wiza-mcp-server/build/index.js"],
      "env": {
        "WIZA_API_KEY": "your_wiza_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop and the Wiza tools will appear in the tool picker.

## Docker

### Docker Compose

```bash
cp .env.example .env
# set WIZA_API_KEY and (optionally) MCP_TRANSPORT=sse
docker compose up -d
```

The SSE endpoint will be available at:

- SSE: `http://localhost:3000/sse`
- Messages: `http://localhost:3000/message`
- Health check: `http://localhost:3000/health`

### Plain `docker run`

Stdio (for local CLI clients):

```bash
docker run -i \
  -e WIZA_API_KEY=your_wiza_api_key_here \
  wiza-mcp-server
```

SSE (for HTTP/remote clients):

```bash
docker run -d \
  -p 3000:3000 \
  -e WIZA_API_KEY=your_wiza_api_key_here \
  -e MCP_TRANSPORT=sse \
  -e MCP_PORT=3000 \
  wiza-mcp-server
```

## Environment variables

Required:

- `WIZA_API_KEY` – Your Wiza API key

Optional:

- `WIZA_BASE_URL` – Override the Wiza API base URL (default: `https://wiza.co`)
- `WIZA_RATE_LIMIT_MIN_TIME_MS` – Minimum ms between requests (default: `1000`)
- `WIZA_RATE_LIMIT_MAX_CONCURRENT` – Max concurrent requests (default: `2`)
- `MCP_TRANSPORT` – `stdio` (default) or `sse`
- `MCP_PORT` – Port for SSE transport (default: `3000`)
- `MCP_ENDPOINT` – Message endpoint path for SSE (default: `/message`)

JWT authentication for SSE (optional):

- `MCP_JWT_SECRET`
- `MCP_JWT_TOKEN`
- `MCP_JWT_ALGORITHM` (default: `HS256`)
- `MCP_JWT_AUDIENCE`
- `MCP_JWT_ISSUER`

When `MCP_JWT_SECRET` is set, all SSE requests (`/sse` and the message endpoint) must include an `Authorization: Bearer <token>` header signed with the configured secret.

## Example: enrich a contact

Once connected, asking Claude something like:

> Use Wiza to enrich Stephen Hakami at wiza.co. I want his work email and mobile.

…will trigger the `enrich-contact` tool with `fullName: "Stephen Hakami"`, `domain: "wiza.co"`, and `enrichmentLevel: "full"`, then return the resolved email, mobile phone, title, location, and company data once the reveal finishes (typically a few seconds).

## Notes

- `enrich-contact` defaults to `enrichmentLevel: "full"` (email + phone) and `waitForCompletion: true`. If a reveal does not finish within `timeoutSeconds` (default 120), the tool returns the latest state and the `revealId`; you can poll later with `get-enrichment`.
- `enrich-company` is synchronous and costs 2 API credits per successful lookup. Wiza limits this endpoint to 30 requests/minute.
- Bulk lists are async. After `create-enrichment-list`, poll `get-list` until `status: finished`, then call `get-list-contacts`.

## License

MIT
