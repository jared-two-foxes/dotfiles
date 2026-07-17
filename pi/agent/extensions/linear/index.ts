/**
 * Linear ticket tools for pi.
 *
 * Registers four tools against the Linear GraphQL API:
 *
 *   linear_get_ticket     -- fetch an issue by its human-readable identifier
 *                           (e.g. SA-42) and return it as formatted markdown.
 *                           Read-only. Mirrors ticket-pipeline's
 *                           fetch_ticket.py (same query and rendering).
 *
 *   linear_update_ticket  -- mutate the title and/or description of an existing
 *                           issue via the issueUpdate mutation. One write
 *                           path against Linear in this extension, mirroring
 *                           ticket-pipeline's update_ticket.py: it first
 *                           resolves the issue's internal UUID from the
 *                           identifier (issueUpdate takes the UUID, not the
 *                           human-readable id), then applies the mutation.
 *                           Only the title/description are editable here --
 *                           Linear-managed metadata (state, priority,
 *                           assignee, labels) is intentionally not exposed,
 *                           same convention as update-ticket.py.
 *
 *   linear_list_teams     -- list every team the authenticated user can see,
 *                           returning each team's UUID, display name and key.
 *                           Read-only. Used to resolve a team *name* the user
 *                           supplies (e.g. "Engineering") into the team's
 *                           internal UUID that issueCreate requires, without
 *                           the user needing to know the UUID.
 *
 *   linear_create_ticket  -- create a new Linear issue via the issueCreate
 *                           mutation, mirroring ticket-pipeline's
 *                           create_ticket(). The second write path. The
 *                           description must include a "## Acceptance
 *                           Criteria" section with "- [ ] ..." checkbox
 *                           bullets so the ticket is immediately consumable
 *                           by the scaffold TDD pipeline (push-ticket /
 *                           next-step) without further enrichment. To create
 *                           a parent + children, create the parent first
 *                           (omit parent_id), then each child with the
 *                           parent's human-readable identifier as parent_id;
 *                           the tool resolves that to the parent's internal
 *                           UUID via a fetch first (same pattern as
 *                           linear_update_ticket's pre-fetch).
 *
 * API key resolution (same order for all tools):
 *   1. LINEAR_API_KEY env var  ->  lets docker/compose inject the key via
 *      env_file without touching the image or auth store
 *   2. ~/.pi/agent/auth.json  ->  "linear" entry (pi's native auth store)
 *   3. ~/.secrets/linear-key  ->  plain-text file (ticket-pipeline's location)
 *
 * Note: pi's SYSTEM.md describes the companion agent as read-only by
 * default. linear_update_ticket and linear_create_ticket are opt-in write
 * paths the user must explicitly invoke; they do not change the read-only
 * posture of the get/list tools.
 */

import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";

// Type-only -- erased at runtime by jiti, no package resolution needed.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- API key ---

function getApiKey(): string | undefined {
  // 1. Env var -- primary source for the docker pi instance, where compose's
  //    env_file injects LINEAR_API_KEY without baking a secret into the
  //    image or needing an auth.json mount.
  const envKey = process.env.LINEAR_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  // 2. Try pi's auth.json (same mechanism as pi-ollama-cloud's AuthStorage,
  //    but read directly to avoid a runtime dependency on pi-coding-agent).
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      if (auth["linear"]?.key) return auth["linear"].key;
    } catch { /* malformed auth.json -- fall through */ }
  }

  // 3. Fall back to the ticket-pipeline's key location.
  const secretsPath = join(homedir(), ".secrets", "linear-key");
  if (existsSync(secretsPath)) {
    try {
      return readFileSync(secretsPath, "utf-8").trim();
    } catch { /* unreadable -- fall through */ }
  }

  return undefined;
}

// --- Linear GraphQL (mirrors fetch_ticket.py) ---

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const TICKET_QUERY = `
  query Issue($identifier: String!) {
    issue(id: $identifier) {
      id
      identifier
      title
      description
      priority
      state { name }
      assignee { name email }
      labels { nodes { name } }
      team { id }
      createdAt
      updatedAt
      url
    }
  }
`;

// issueUpdate takes the issue's internal UUID (the `id` field from
// TICKET_QUERY), not its human-readable identifier. Mirrors
// fetch_ticket.py's update_ticket() mutation exactly.
const UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id identifier title updatedAt }
    }
  }
`;

// Lists every team the authenticated user can access. Used to resolve a
// team name the user supplies into the team's internal UUID, which
// issueCreate's `teamId` field requires. Mirrors the `teams` query from
// Linear's API docs.
const TEAMS_QUERY = `
  query Teams {
    teams {
      nodes {
        id
        name
        key
      }
    }
  }
`;

// Creates a new issue. Mirrors fetch_ticket.py's create_ticket() mutation
// exactly: `teamId` is the team's internal UUID (from TEAMS_QUERY), and
// `parentId`, if given, is the parent issue's internal UUID (not its
// human-readable identifier) -- linear_create_ticket resolves that from the
// parent identifier via TICKET_QUERY before the mutation, same pre-fetch
// pattern as linear_update_ticket.
const CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title url }
    }
  }
`;

const PRIORITY_LABELS: Record<number, string> = {
  0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low",
};

/** Shared POST-and-parse for every Linear GraphQL call -- query and mutation
 *  alike, since both are just a query string + variables over the same
 *  endpoint with the same auth header. Linear uses the raw API key as the
 *  Authorization header value (not "Bearer <key>"). Same as fetch_ticket.py. */
async function linearGraphQL(
  query: string,
  variables: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<any> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Linear API error (status ${res.status}): ` +
      `${errorText || res.statusText}`);
  }

  const data: any = await res.json();
  if (data.errors) {
    const messages = data.errors.map((e: any) => e.message).join("; ");
    throw new Error(`Linear API errors: ${messages}`);
  }
  return data;
}

function renderTicket(issue: any): string {
  const labels = issue.labels?.nodes
    ?.map((n: any) => n.name).join(", ") || "—";
  const assignee = issue.assignee?.name || "Unassigned";
  const priority = PRIORITY_LABELS[issue.priority] ?? String(issue.priority);

  const lines = [
    `# ${issue.identifier} — ${issue.title}`,
    "",
    "| Field    | Value |",
    "|----------|-------|",
    `| State    | ${issue.state?.name ?? "—"} |`,
    `| Priority | ${priority} |`,
    `| Assignee | ${assignee} |`,
    `| Labels   | ${labels} |`,
    `| Created  | ${issue.createdAt?.slice(0, 10) ?? "—"} |`,
    `| Updated  | ${issue.updatedAt?.slice(0, 10) ?? "—"} |`,
    `| URL      | ${issue.url ?? "—"} |`,
  ];
  if (issue.description) {
    lines.push("", "## Description", "", issue.description);
  }
  return lines.join("\n");
}

function renderTeams(teams: any[]): string {
  if (!teams.length) return "No Linear teams accessible to this API key.";
  const rows = teams.map((t: any) =>
    `| ${t.key ?? "—"} | ${t.name} | ${t.id} |`);
  return [
    "| Key | Name | Team ID (UUID) |",
    "|-----|------|----------------|",
    ...rows,
  ].join("\n");
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "linear_get_ticket",
    label: "Linear Get Ticket",
    description:
      "Fetch a Linear ticket by its identifier (e.g. SA-42, NEB-101). " +
      "Returns the ticket's title, description, state, priority, assignee, " +
      "labels, and metadata as formatted markdown. " +
      "Use when a question references a specific Linear ticket ID or " +
      "when ticket content is needed to understand the context of " +
      "the ticket-pipeline TDD workflow.",
    parameters: Type.Object({
        identifier: Type.String({ description: "Linear ticket identifier, e.g. SA-42" }),
      }),
    async execute(_toolCallId, params, signal) {
      const apiKey = getApiKey();
      if (!apiKey) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Error: No Linear API key found. Set the LINEAR_API_KEY " +
              "env var, or add a \"linear\" entry to ~/.pi/agent/auth.json " +
              "(e.g. {\"linear\": {\"type\": \"api_key\", \"key\": " +
              "\"lin_api_...\"}}), or create ~/.secrets/linear-key with " +
              "the key as plain text.",
          }],
          isError: true,
        };
      }

      try {
        const data = await linearGraphQL(
          TICKET_QUERY, { identifier: params.identifier }, apiKey, signal);

        const issue = data.data?.issue;
        if (!issue) {
          return {
            content: [{
              type: "text" as const,
              text: `Ticket ${params.identifier} not found.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: renderTicket(issue),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Linear API request failed: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "linear_update_ticket",
    label: "Linear Update Ticket",
    description:
      "Update the title and/or description of an existing Linear ticket " +
      "by its identifier (e.g. SA-42). Uses Linear's issueUpdate " +
      "mutation. Only the title and description are editable here; " +
      "Linear-managed metadata (state, priority, assignee, labels) is " +
      "not modified. Provide at least one of title or description — " +
      "whichever is omitted is left unchanged on the live ticket. " +
      "Use when the user explicitly asks to push a revision to a " +
      "Linear ticket (mirrors the ticket-pipeline's update-ticket).",
    promptGuidelines: [
      "Use linear_update_ticket only when the user explicitly asks to " +
      "push a change to a Linear ticket; confirm the identifier and the " +
      "new title/description with the user before calling it, since the " +
      "mutation is visible to everyone on the ticket and not locally " +
      "reversible.",
    ],
    parameters: Type.Object({
      identifier: Type.String({
        description: "Linear ticket identifier to update, e.g. SA-42",
      }),
      title: Type.Optional(Type.String({
        description:
          "New title for the ticket. Omit to leave the title unchanged.",
      })),
      description: Type.Optional(Type.String({
        description:
          "New description (markdown) for the ticket. Omit to leave the " +
          "description unchanged.",
      })),
    }),
    async execute(_toolCallId, params, signal) {
      const apiKey = getApiKey();
      if (!apiKey) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Error: No Linear API key found. Set the LINEAR_API_KEY " +
              "env var, or add a \"linear\" entry to ~/.pi/agent/auth.json, " +
              "or create ~/.secrets/linear-key.",
          }],
          isError: true,
        };
      }

      if (params.title === undefined && params.description === undefined) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Error: Nothing to update — provide at least one of title " +
              "or description.",
          }],
          isError: true,
        };
      }

      try {
        // 1. Resolve the issue's internal UUID from the human-readable
        //    identifier (issueUpdate takes the UUID, not "SA-42").
        const fetch = await linearGraphQL(
          TICKET_QUERY, { identifier: params.identifier }, apiKey, signal);
        const issue = fetch.data?.issue;
        if (!issue) {
          return {
            content: [{
              type: "text" as const,
              text: `Ticket ${params.identifier} not found.`,
            }],
            isError: true,
          };
        }

        // 2. Build the IssueUpdateInput, only including fields the caller
        //    supplied so omitted fields are left untouched on the live
        //    ticket (same convention as fetch_ticket.py's update_ticket).
        const input: Record<string, string> = {};
        if (params.title !== undefined) input.title = params.title;
        if (params.description !== undefined) input.description = params.description;

        const result = await linearGraphQL(
          UPDATE_MUTATION, { id: issue.id, input }, apiKey, signal);

        if (!result.data?.issueUpdate?.success) {
          return {
            content: [{
              type: "text" as const,
              text: `Update did not report success: ${JSON.stringify(result)}`,
            }],
            isError: true,
          };
        }

        const updated = result.data.issueUpdate.issue;
        return {
          content: [{
            type: "text" as const,
            text:
              `Updated ${updated.identifier} (${updated.url ?? issue.url ?? "—"}).\n` +
              `   title: ${updated.title}\n` +
              `   updated: ${updated.updatedAt?.slice(0, 10) ?? "—"}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Linear API request failed: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "linear_list_teams",
    label: "Linear List Teams",
    description:
      "List all Linear teams accessible to the authenticated user, " +
      "returning each team's UUID, display name, and key (e.g. ENG, SA). " +
      "Read-only. Use to resolve a team name to its internal UUID before " +
      "creating tickets (linear_create_ticket's team_id requires the UUID, " +
      "not the name), or to help the user identify which team a new ticket " +
      "should belong to.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const apiKey = getApiKey();
      if (!apiKey) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Error: No Linear API key found. Set the LINEAR_API_KEY " +
              "env var, or add a \"linear\" entry to ~/.pi/agent/auth.json, " +
              "or create ~/.secrets/linear-key.",
          }],
          isError: true,
        };
      }

      try {
        const data = await linearGraphQL(TEAMS_QUERY, {}, apiKey, signal);
        const teams = data.data?.teams?.nodes ?? [];
        return {
          content: [{
            type: "text" as const,
            text: renderTeams(teams),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Linear API request failed: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "linear_create_ticket",
    label: "Linear Create Ticket",
    description:
      "Create a new Linear issue. The ticket's description must include " +
      "a '## Acceptance Criteria' section with '- [ ] ...' checkbox " +
      "bullets, so the ticket is immediately consumable by the scaffold " +
      "TDD pipeline (push-ticket / next-step) without further enrichment. " +
      "Use to push planned work to Linear when the user explicitly asks. " +
      "To create a parent ticket with children, first create the parent " +
      "(omit parent_id), then create each child with the parent's " +
      "identifier passed as parent_id.",
    promptGuidelines: [
      "Use linear_create_ticket only when the user explicitly asks to " +
      "create tickets in Linear. Always confirm the ticket title, " +
      "description, and acceptance criteria with the user before " +
      "creating, since the result is visible to everyone on the team " +
      "and not locally reversible.",
      "Every ticket description must include a '## Acceptance Criteria' " +
      "section with '- [ ] ...' checkbox bullets. Each criterion must be " +
      "independently testable — the same bar review-ticket checks against.",
      "If the work is too large for a single implementation pass (criteria " +
      "fan across unrelated modules, or have strict sequential " +
      "dependencies), create a parent ticket and child tickets. Create " +
      "the parent first, then each child with the parent's identifier as " +
      "parent_id.",
    ],
    parameters: Type.Object({
      team_id: Type.String({
        description:
          "The team's internal UUID. Resolve via linear_list_teams if the " +
          "user provides a team name instead.",
      }),
      title: Type.String({
        description:
          "Concise ticket title (verb + subject, <=10 words).",
      }),
      description: Type.String({
        description:
          "Markdown body. Must include a '## Acceptance Criteria' section " +
          "with '- [ ] ...' checkbox bullets for pipeline compatibility.",
      }),
      parent_id: Type.Optional(Type.String({
        description:
          "The parent ticket's human-readable identifier (e.g. SA-42). " +
          "If given, the new issue is created as a Linear sub-issue of " +
          "that parent. Omit to create a standalone ticket.",
      })),
    }),
    async execute(_toolCallId, params, signal) {
      const apiKey = getApiKey();
      if (!apiKey) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Error: No Linear API key found. Set the LINEAR_API_KEY " +
              "env var, or add a \"linear\" entry to ~/.pi/agent/auth.json, " +
              "or create ~/.secrets/linear-key.",
          }],
          isError: true,
        };
      }

      try {
        // Build the IssueCreateInput. teamId and title/description are
        // always present (required params); parentId is only added when
        // the caller supplied a parent identifier, mirroring
        // fetch_ticket.py's create_ticket().
        const input: Record<string, string> = {
          teamId: params.team_id,
          title: params.title,
          description: params.description,
        };

        // If a parent identifier was supplied, resolve it to the parent's
        // internal UUID first (issueCreate's parentId takes the UUID, not
        // "SA-42"). Same pre-fetch pattern as linear_update_ticket.
        if (params.parent_id !== undefined) {
          const parentFetch = await linearGraphQL(
            TICKET_QUERY, { identifier: params.parent_id }, apiKey, signal);
          const parent = parentFetch.data?.issue;
          if (!parent) {
            return {
              content: [{
                type: "text" as const,
                text: `Parent ticket ${params.parent_id} not found.`,
              }],
              isError: true,
            };
          }
          input.parentId = parent.id;
        }

        const result = await linearGraphQL(
          CREATE_MUTATION, { input }, apiKey, signal);

        if (!result.data?.issueCreate?.success) {
          return {
            content: [{
              type: "text" as const,
              text: `Create did not report success: ${JSON.stringify(result)}`,
            }],
            isError: true,
          };
        }

        const created = result.data.issueCreate.issue;
        return {
          content: [{
            type: "text" as const,
            text:
              `Created ${created.identifier}: ${created.url ?? "—"}\n` +
              `   title: ${created.title}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Linear API request failed: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  });
}