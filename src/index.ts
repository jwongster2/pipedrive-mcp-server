import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as dotenv from "dotenv";
import Bottleneck from "bottleneck";
import jwt from "jsonwebtoken";
import http from "http";

interface ErrorWithMessage {
  message: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

dotenv.config();

if (!process.env.WIZA_API_KEY) {
  console.error("ERROR: WIZA_API_KEY environment variable is required");
  process.exit(1);
}

const WIZA_API_KEY = process.env.WIZA_API_KEY;
const WIZA_BASE_URL = process.env.WIZA_BASE_URL || "https://wiza.co";

const jwtSecret = process.env.MCP_JWT_SECRET;
const jwtAlgorithm = (process.env.MCP_JWT_ALGORITHM || "HS256") as jwt.Algorithm;
const jwtVerifyOptions = {
  algorithms: [jwtAlgorithm],
  audience: process.env.MCP_JWT_AUDIENCE,
  issuer: process.env.MCP_JWT_ISSUER,
};

if (jwtSecret) {
  const bootToken = process.env.MCP_JWT_TOKEN;
  if (!bootToken) {
    console.error("ERROR: MCP_JWT_TOKEN environment variable is required when MCP_JWT_SECRET is set");
    process.exit(1);
  }

  try {
    jwt.verify(bootToken, jwtSecret, jwtVerifyOptions);
  } catch (error) {
    console.error("ERROR: Failed to verify MCP_JWT_TOKEN", error);
    process.exit(1);
  }
}

const verifyRequestAuthentication = (req: http.IncomingMessage) => {
  if (!jwtSecret) {
    return { ok: true } as const;
  }

  const header = req.headers["authorization"];
  if (!header) {
    return { ok: false, status: 401, message: "Missing Authorization header" } as const;
  }

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return { ok: false, status: 401, message: "Invalid Authorization header format" } as const;
  }

  try {
    jwt.verify(token, jwtSecret, jwtVerifyOptions);
    return { ok: true } as const;
  } catch (error) {
    return { ok: false, status: 401, message: "Invalid or expired token" } as const;
  }
};

// Wiza's documented limit on company_enrichments is 30 req/min. Stay conservative across endpoints.
const limiter = new Bottleneck({
  minTime: Number(process.env.WIZA_RATE_LIMIT_MIN_TIME_MS || 1000),
  maxConcurrent: Number(process.env.WIZA_RATE_LIMIT_MAX_CONCURRENT || 2),
});

type WizaMethod = "GET" | "POST";

interface WizaRequestOptions {
  method: WizaMethod;
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
}

const callWizaApi = async <T = any>({
  method,
  path,
  body,
  query,
}: WizaRequestOptions): Promise<T> => {
  const url = new URL(`${WIZA_BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${WIZA_API_KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };

  const response = await limiter.schedule(() => fetch(url, init));
  const rawBody = await response.text();
  const parsedBody = rawBody ? (() => {
    try {
      return JSON.parse(rawBody);
    } catch {
      return rawBody;
    }
  })() : null;

  if (!response.ok) {
    const apiMessage =
      typeof parsedBody === "object" && parsedBody !== null
        ? (parsedBody as any).status?.message ||
          (parsedBody as any).message ||
          (parsedBody as any).error ||
          response.statusText
        : typeof parsedBody === "string" && parsedBody
          ? parsedBody
          : response.statusText;

    throw new Error(`Wiza API request failed (${response.status}): ${apiMessage}`);
  }

  return parsedBody as T;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface IndividualRevealData {
  id: number;
  status: "queued" | "resolving" | "finished" | "failed";
  is_complete: boolean;
  [key: string]: unknown;
}

interface IndividualRevealResponse {
  status?: { code?: number; message?: string };
  type?: string;
  data: IndividualRevealData;
}

const TERMINAL_STATUSES = new Set(["finished", "failed"]);

const pollIndividualReveal = async (
  id: number,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<IndividualRevealResponse> => {
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    const response = await callWizaApi<IndividualRevealResponse>({
      method: "GET",
      path: `/api/individual_reveals/${id}`,
    });

    const status = response.data?.status;
    if (status && TERMINAL_STATUSES.has(status)) {
      return response;
    }

    if (Date.now() - startedAt + pollIntervalMs > timeoutMs) {
      // Return the latest snapshot if we've exhausted the budget.
      return response;
    }

    // Light backoff: start at pollIntervalMs and grow up to ~5s.
    const wait = Math.min(pollIntervalMs * Math.min(attempt, 5), 5000);
    await sleep(wait);
  }
};

const createTextToolResult = (payload: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    },
  ],
});

const createTextToolErrorResult = (text: string) => ({
  content: [
    {
      type: "text" as const,
      text,
    },
  ],
  isError: true,
});

const server = new McpServer({
  name: "wiza-mcp-server",
  version: "1.0.0",
});

// === TOOLS ===

server.tool(
  "get-credits",
  "Check the remaining email, phone, export, and API credits on the Wiza account.",
  {},
  async () => {
    try {
      const response = await callWizaApi<{ credits: Record<string, unknown> }>({
        method: "GET",
        path: "/api/meta/credits",
      });
      return createTextToolResult({
        summary: "Wiza credit balance retrieved",
        credits: response.credits,
      });
    } catch (error) {
      console.error("Error fetching Wiza credits:", error);
      return createTextToolErrorResult(`Error fetching Wiza credits: ${getErrorMessage(error)}`);
    }
  }
);

const enrichmentLevelSchema = z
  .enum(["none", "partial", "phone", "full"])
  .describe(
    "Enrichment depth: 'none' (only profile data, no email/phone lookup), 'partial' (find email), 'phone' (find phone numbers), 'full' (email + phone)."
  );

server.tool(
  "enrich-contact",
  "Enrich a single contact via Wiza. Provide ONE of: a LinkedIn profile URL, an email address, OR a full name plus company name or company domain. Defaults to waiting for the enrichment to complete and returning the resolved contact data including email, phone, title, location, and company details.",
  {
    profileUrl: z
      .string()
      .url()
      .optional()
      .describe("LinkedIn profile URL, e.g. https://www.linkedin.com/in/stephen-hakami-5babb21b0/"),
    email: z.string().email().optional().describe("Email address of the contact"),
    fullName: z.string().optional().describe("Full name of the contact, e.g. 'Stephen Hakami'"),
    company: z.string().optional().describe("Company name (required with fullName if domain is not provided)"),
    domain: z.string().optional().describe("Company domain, e.g. 'wiza.co' (required with fullName if company is not provided)"),
    enrichmentLevel: enrichmentLevelSchema.default("full"),
    acceptWork: z.boolean().optional().describe("Accept professional emails (e.g. tim@apple.com). Defaults to true."),
    acceptPersonal: z.boolean().optional().describe("Accept personal emails (e.g. tim@gmail.com). Defaults to false."),
    waitForCompletion: z
      .boolean()
      .optional()
      .describe("If true (default), poll until the reveal finishes or times out and return the final data. If false, return immediately with the queued reveal id."),
    timeoutSeconds: z.number().int().positive().max(600).optional().describe("Maximum seconds to wait when waitForCompletion is true. Default 120."),
    pollIntervalSeconds: z.number().min(1).max(30).optional().describe("Polling interval seconds while waiting. Default 3."),
    callbackUrl: z.string().url().optional().describe("Optional webhook URL for async completion notification"),
  },
  async ({
    profileUrl,
    email,
    fullName,
    company,
    domain,
    enrichmentLevel = "full",
    acceptWork,
    acceptPersonal,
    waitForCompletion = true,
    timeoutSeconds = 120,
    pollIntervalSeconds = 3,
    callbackUrl,
  }) => {
    try {
      let individualReveal: Record<string, unknown>;

      if (profileUrl) {
        individualReveal = { profile_url: profileUrl };
      } else if (fullName) {
        if (!company && !domain) {
          return createTextToolErrorResult(
            "When using fullName, you must also provide either 'company' or 'domain'."
          );
        }
        individualReveal = { full_name: fullName };
        if (company) individualReveal.company = company;
        if (domain) individualReveal.domain = domain;
      } else if (email) {
        individualReveal = { email };
      } else {
        return createTextToolErrorResult(
          "Provide one of: profileUrl, email, or fullName (with company or domain)."
        );
      }

      const body: Record<string, unknown> = {
        individual_reveal: individualReveal,
        enrichment_level: enrichmentLevel,
      };

      if (acceptWork !== undefined || acceptPersonal !== undefined) {
        body.email_options = {
          ...(acceptWork !== undefined ? { accept_work: acceptWork } : {}),
          ...(acceptPersonal !== undefined ? { accept_personal: acceptPersonal } : {}),
        };
      }

      if (callbackUrl) {
        body.callback_url = callbackUrl;
      }

      const startResponse = await callWizaApi<IndividualRevealResponse>({
        method: "POST",
        path: "/api/individual_reveals",
        body,
      });

      const revealId = startResponse.data?.id;

      if (!waitForCompletion || !revealId) {
        return createTextToolResult({
          summary: revealId
            ? `Started Wiza individual reveal ${revealId} (status: ${startResponse.data?.status})`
            : "Wiza individual reveal request submitted",
          reveal: startResponse,
        });
      }

      const finalResponse = await pollIndividualReveal(
        revealId,
        timeoutSeconds * 1000,
        pollIntervalSeconds * 1000
      );

      const finalStatus = finalResponse.data?.status;
      const summary =
        finalStatus === "finished"
          ? `Wiza enrichment finished for reveal ${revealId}`
          : finalStatus === "failed"
            ? `Wiza enrichment failed for reveal ${revealId}`
            : `Wiza enrichment for reveal ${revealId} did not finish within ${timeoutSeconds}s (status: ${finalStatus}). You can poll with get-enrichment.`;

      return createTextToolResult({
        summary,
        reveal_id: revealId,
        status: finalStatus,
        contact: finalResponse.data,
      });
    } catch (error) {
      console.error("Error enriching contact:", error);
      return createTextToolErrorResult(`Error enriching contact: ${getErrorMessage(error)}`);
    }
  }
);

server.tool(
  "get-enrichment",
  "Fetch the latest status and data of a Wiza individual reveal by id. Use after enrich-contact when waitForCompletion was false or timed out.",
  {
    revealId: z.coerce.number().int().positive().describe("The individual reveal id returned by enrich-contact"),
  },
  async ({ revealId }) => {
    try {
      const response = await callWizaApi<IndividualRevealResponse>({
        method: "GET",
        path: `/api/individual_reveals/${revealId}`,
      });
      return createTextToolResult({
        summary: `Reveal ${revealId} status: ${response.data?.status}`,
        contact: response.data,
      });
    } catch (error) {
      console.error(`Error fetching individual reveal ${revealId}:`, error);
      return createTextToolErrorResult(
        `Error fetching individual reveal ${revealId}: ${getErrorMessage(error)}`
      );
    }
  }
);

server.tool(
  "enrich-company",
  "Enrich a single company via Wiza. Provide at least one of: companyName, companyDomain, companyLinkedinId, or companyLinkedinSlug. Returns immediately with industry, size, revenue, funding, and location data. Costs 2 API credits per successful lookup.",
  {
    companyName: z.string().optional().describe("Company name, e.g. 'Wiza'"),
    companyDomain: z.string().optional().describe("Company domain, e.g. 'wiza.co'"),
    companyLinkedinId: z.string().optional().describe("LinkedIn company id, e.g. '18663757'"),
    companyLinkedinSlug: z.string().optional().describe("LinkedIn company slug from the LinkedIn URL, e.g. 'wiza'"),
  },
  async ({ companyName, companyDomain, companyLinkedinId, companyLinkedinSlug }) => {
    if (!companyName && !companyDomain && !companyLinkedinId && !companyLinkedinSlug) {
      return createTextToolErrorResult(
        "Provide at least one of: companyName, companyDomain, companyLinkedinId, or companyLinkedinSlug."
      );
    }

    try {
      const body: Record<string, unknown> = {};
      if (companyName) body.company_name = companyName;
      if (companyDomain) body.company_domain = companyDomain;
      if (companyLinkedinId) body.company_linkedin_id = companyLinkedinId;
      if (companyLinkedinSlug) body.company_linkedin_slug = companyLinkedinSlug;

      const response = await callWizaApi<{
        status?: { code?: number; message?: string };
        type?: string;
        data?: Record<string, unknown>;
      }>({
        method: "POST",
        path: "/api/company_enrichments",
        body,
      });

      return createTextToolResult({
        summary: response.status?.message || "Company enrichment retrieved",
        company: response.data,
      });
    } catch (error) {
      console.error("Error enriching company:", error);
      return createTextToolErrorResult(`Error enriching company: ${getErrorMessage(error)}`);
    }
  }
);

const wizaListItemSchema = z
  .object({
    profile_url: z.string().optional().describe("LinkedIn profile URL"),
    email: z.string().optional().describe("Email address"),
    full_name: z.string().optional().describe("Full name"),
    company: z.string().optional().describe("Company name (used with full_name)"),
    domain: z.string().optional().describe("Company domain (used with full_name)"),
  })
  .refine(
    (item) =>
      Boolean(item.profile_url) ||
      Boolean(item.email) ||
      (Boolean(item.full_name) && (Boolean(item.company) || Boolean(item.domain))),
    {
      message:
        "Each item needs profile_url, email, or full_name with company/domain.",
    }
  );

server.tool(
  "create-enrichment-list",
  "Create a Wiza bulk enrichment list. Each item can be a LinkedIn URL, an email, or full_name + company/domain. Returns a list id. Use get-list to check status and get-list-contacts to retrieve enriched results.",
  {
    name: z.string().describe("Name of the list, e.g. 'VP of Sales follow-up'"),
    enrichmentLevel: z
      .enum(["none", "partial", "full"])
      .default("full")
      .describe("Enrichment depth: 'none' (no email/phone lookup), 'partial' (find email), 'full' (find email + phone)"),
    items: z.array(wizaListItemSchema).min(1).max(2500).describe("Up to 2500 items to enrich"),
    acceptWork: z.boolean().optional().describe("Accept professional emails. Defaults to true."),
    acceptPersonal: z.boolean().optional().describe("Accept personal emails. Defaults to true."),
    acceptGeneric: z.boolean().optional().describe("Accept generic emails like hello@company.com. Defaults to true."),
    callbackUrl: z.string().url().optional().describe("Optional webhook URL for async completion notification"),
  },
  async ({
    name,
    enrichmentLevel = "full",
    items,
    acceptWork = true,
    acceptPersonal = true,
    acceptGeneric = true,
    callbackUrl,
  }) => {
    try {
      const body: Record<string, unknown> = {
        list: {
          name,
          enrichment_level: enrichmentLevel,
          email_options: {
            accept_work: acceptWork,
            accept_personal: acceptPersonal,
            accept_generic: acceptGeneric,
          },
          items,
          ...(callbackUrl ? { callback_url: callbackUrl } : {}),
        },
      };

      const response = await callWizaApi<{ data?: { id?: number; status?: string } }>({
        method: "POST",
        path: "/api/lists",
        body,
      });

      return createTextToolResult({
        summary: response.data?.id
          ? `Created Wiza list ${response.data.id} (status: ${response.data.status}) with ${items.length} item(s)`
          : "Wiza list created",
        list: response.data,
      });
    } catch (error) {
      console.error("Error creating Wiza list:", error);
      return createTextToolErrorResult(`Error creating Wiza list: ${getErrorMessage(error)}`);
    }
  }
);

server.tool(
  "get-list",
  "Get the status and metadata of a Wiza enrichment list.",
  {
    listId: z.coerce.number().int().positive().describe("The list id returned by create-enrichment-list"),
  },
  async ({ listId }) => {
    try {
      const response = await callWizaApi<{ data?: Record<string, unknown> }>({
        method: "GET",
        path: `/api/lists/${listId}`,
      });
      return createTextToolResult({
        summary: `Wiza list ${listId} status: ${(response.data as any)?.status}`,
        list: response.data,
      });
    } catch (error) {
      console.error(`Error fetching Wiza list ${listId}:`, error);
      return createTextToolErrorResult(
        `Error fetching Wiza list ${listId}: ${getErrorMessage(error)}`
      );
    }
  }
);

server.tool(
  "get-list-contacts",
  "Fetch the enriched contacts for a completed Wiza list. The list must be in 'finished' state. Segment filters which contacts to return.",
  {
    listId: z.coerce.number().int().positive().describe("The list id"),
    segment: z
      .enum(["people", "valid", "risky"])
      .default("people")
      .describe("'people' = all, 'valid' = only valid emails, 'risky' = only risky emails"),
  },
  async ({ listId, segment = "people" }) => {
    try {
      const response = await callWizaApi<{ data?: unknown[] }>({
        method: "GET",
        path: `/api/lists/${listId}/contacts`,
        query: { segment },
      });

      const contacts = response.data ?? [];
      return createTextToolResult({
        summary: `Retrieved ${Array.isArray(contacts) ? contacts.length : 0} contact(s) for list ${listId} (segment: ${segment})`,
        contacts,
      });
    } catch (error) {
      console.error(`Error fetching contacts for list ${listId}:`, error);
      return createTextToolErrorResult(
        `Error fetching contacts for list ${listId}: ${getErrorMessage(error)}`
      );
    }
  }
);

const includeExcludeSchema = z
  .object({
    v: z.string().describe("Value"),
    s: z.enum(["i", "e"]).default("i").describe("'i' to include, 'e' to exclude"),
  });

const locationFilterSchema = z.object({
  v: z.string().describe("Location value, e.g. 'Toronto, Ontario, Canada'"),
  b: z.enum(["city", "state", "country"]).describe("Location granularity"),
  s: z.enum(["i", "e"]).default("i").describe("'i' to include, 'e' to exclude"),
});

server.tool(
  "prospect-search",
  "Search the Wiza prospect database with structured filters. Returns a count of matching prospects and (optionally) up to 30 sample profiles. Useful for sizing audiences before creating an enrichment list.",
  {
    size: z.number().int().min(0).max(30).optional().describe("Number of sample prospects to return (0-30, default 0)"),
    firstName: z.array(z.string()).optional().describe("Exact first names to match"),
    lastName: z.array(z.string()).optional().describe("Exact last names to match"),
    jobTitle: z.array(includeExcludeSchema).optional().describe("Job titles to include or exclude"),
    jobTitleLevel: z
      .array(
        z.enum([
          "CXO",
          "Director",
          "Entry",
          "Manager",
          "Owner",
          "Partner",
          "Senior",
          "Training",
          "Unpaid",
          "VP",
        ])
      )
      .optional()
      .describe("Seniority levels"),
    jobRole: z.array(z.string()).optional().describe("Job roles like 'engineering', 'sales', 'marketing'"),
    location: z.array(locationFilterSchema).optional().describe("Person locations"),
    skill: z.array(z.string()).optional().describe("Skills"),
    school: z.array(z.string()).optional().describe("School names"),
    major: z.array(z.string()).optional().describe("Majors"),
    linkedinSlug: z.array(z.string()).optional().describe("LinkedIn slugs (e.g. 'stephen-hakami-5babb21b0')"),
    jobCompany: z.array(includeExcludeSchema).optional().describe("Current companies to include or exclude"),
    pastCompany: z.array(includeExcludeSchema).optional().describe("Past companies to include or exclude"),
    companyLocation: z.array(locationFilterSchema).optional().describe("Company locations"),
    companyIndustry: z.array(includeExcludeSchema).optional().describe("Company industries"),
    companySize: z
      .array(z.enum(["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"]))
      .optional()
      .describe("Company size buckets"),
  },
  async (input) => {
    try {
      const filters: Record<string, unknown> = {};
      if (input.firstName) filters.first_name = input.firstName;
      if (input.lastName) filters.last_name = input.lastName;
      if (input.jobTitle) filters.job_title = input.jobTitle;
      if (input.jobTitleLevel) filters.job_title_level = input.jobTitleLevel;
      if (input.jobRole) filters.job_role = input.jobRole;
      if (input.location) filters.location = input.location;
      if (input.skill) filters.skill = input.skill;
      if (input.school) filters.school = input.school;
      if (input.major) filters.major = input.major;
      if (input.linkedinSlug) filters.linkedin_slug = input.linkedinSlug;
      if (input.jobCompany) filters.job_company = input.jobCompany;
      if (input.pastCompany) filters.past_company = input.pastCompany;
      if (input.companyLocation) filters.company_location = input.companyLocation;
      if (input.companyIndustry) filters.company_industry = input.companyIndustry;
      if (input.companySize) filters.company_size = input.companySize;

      if (Object.keys(filters).length === 0) {
        return createTextToolErrorResult(
          "Provide at least one filter (e.g. jobTitle, location, jobCompany, etc.) to run a prospect search."
        );
      }

      const body: Record<string, unknown> = {
        size: input.size ?? 0,
        filters,
      };

      const response = await callWizaApi<{
        status?: { code?: number; message?: string };
        data?: { total?: number; profiles?: unknown[] };
      }>({
        method: "POST",
        path: "/api/prospects/search",
        body,
      });

      return createTextToolResult({
        summary: `Found ${response.data?.total ?? "unknown"} matching prospect(s); returned ${
          response.data?.profiles?.length ?? 0
        } sample(s).`,
        total: response.data?.total,
        profiles: response.data?.profiles ?? [],
      });
    } catch (error) {
      console.error("Error running prospect search:", error);
      return createTextToolErrorResult(`Error running prospect search: ${getErrorMessage(error)}`);
    }
  }
);

// === PROMPTS ===

server.prompt(
  "enrich-by-linkedin",
  "Enrich a contact from a LinkedIn URL",
  {
    profileUrl: z.string().describe("LinkedIn profile URL"),
  },
  ({ profileUrl }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Use Wiza to fully enrich the contact at ${profileUrl}. Return their work email, mobile phone, current title, location, and company details.`,
        },
      },
    ],
  })
);

server.prompt(
  "enrich-by-name-and-company",
  "Enrich a contact by name and company",
  {
    fullName: z.string().describe("Full name"),
    company: z.string().describe("Company name or domain"),
  },
  ({ fullName, company }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Use Wiza to enrich ${fullName} who works at ${company}. Return their work email, mobile phone, current title, location, and company information.`,
        },
      },
    ],
  })
);

server.prompt(
  "company-research",
  "Look up firmographic data for a company",
  {
    companyDomainOrName: z.string().describe("Company domain or name"),
  },
  ({ companyDomainOrName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Use the Wiza company enrichment to look up "${companyDomainOrName}" and summarize: industry, employee size range, revenue range, funding, location, and a short company description.`,
        },
      },
    ],
  })
);

server.prompt(
  "check-credit-balance",
  "Show remaining Wiza credits",
  {},
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Use the get-credits tool and tell me how many email, phone, export, and API credits I have remaining on Wiza.",
        },
      },
    ],
  })
);

// === TRANSPORT ===

const transportType = process.env.MCP_TRANSPORT || (process.env.PORT ? "sse" : "stdio");

if (transportType === "sse") {
  const port = parseInt(process.env.MCP_PORT || process.env.PORT || "3000", 10);
  const endpoint = process.env.MCP_ENDPOINT || "/message";

  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      const authResult = verifyRequestAuthentication(req);
      if (!authResult.ok) {
        res.writeHead(authResult.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: authResult.message }));
        return;
      }

      console.error("New SSE connection request");
      const transport = new SSEServerTransport(endpoint, res);

      transports.set(transport.sessionId, transport);

      transport.onclose = () => {
        console.error(`SSE connection closed: ${transport.sessionId}`);
        transports.delete(transport.sessionId);
      };

      try {
        await server.connect(transport);
        console.error(`SSE connection established: ${transport.sessionId}`);
      } catch (err) {
        console.error("Failed to establish SSE connection:", err);
        transports.delete(transport.sessionId);
      }
    } else if (req.method === "POST" && url.pathname === endpoint) {
      const authResult = verifyRequestAuthentication(req);
      if (!authResult.ok) {
        res.writeHead(authResult.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: authResult.message }));
        return;
      }

      const sessionId = url.searchParams.get("sessionId") || (req.headers["x-session-id"] as string);

      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing sessionId" }));
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      req.on("error", (err) => {
        console.error("Error receiving POST message body:", err);
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request body" }));
        }
      });

      try {
        await transport.handlePostMessage(req, res);
      } catch (err) {
        console.error("Error handling POST message:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    } else {
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", transport: "sse" }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    }
  });

  httpServer.listen(port, () => {
    console.error(`Wiza MCP Server (SSE) listening on port ${port}`);
    console.error(`SSE endpoint: http://localhost:${port}/sse`);
    console.error(`Message endpoint: http://localhost:${port}${endpoint}`);
  });
} else {
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });

  console.error("Wiza MCP Server started (stdio transport)");
}
