/**
 * The MCP surface: four tools over three endpoints.
 *
 * WHY buildServer IS EXPORTED SEPARATELY FROM THE ENTRY POINT. The self-test
 * connects this same server object to an in-memory transport and calls its
 * tools through a real MCP client, so what is tested is the server that ships
 * rather than a re-implementation of it. A server only reachable through a
 * subprocess can only be tested through a subprocess.
 *
 * WHY EVERY TOOL RETURNS TWO CONTENT BLOCKS. A prose headline and then the
 * JSON. Clients differ in what they show the model and what they show the
 * user, and an agent that gets only JSON tends to quote a number out of it
 * without the scope attached, which is the one failure this product exists to
 * prevent. The headline carries the caveat; the JSON carries the detail.
 *
 * WHY THE KEYED TOOLS ARE LISTED EVEN WITH NO KEY. Hiding them would make the
 * server look like it does less than it does, and the agent would never learn
 * that a key is what is missing. They are listed and answer with the
 * configuration failure, which names where to get one.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MCP_SERVER_NAME, MCP_TOOLS, mcpTool } from "./generated.js";
import { EvidenceApiClient, describeFailure, type Failure } from "./client.js";
import { compareModels, type ModelRuns, type RunLike } from "./compare.js";

export const SERVER_VERSION = "0.1.2";

interface CoveragePayload {
  modelsInCatalogue: number;
  modelsWithEvidence: number;
  models: string[];
}

interface EvidencePayload {
  model: { slug: string; name: string };
  evidence: {
    citationCount: number;
    governedRunCount: number;
    citations: unknown[];
    governedRuns?: RunLike[];
  };
  disclosure?: { scope?: string; coverage?: string };
  plan?: string;
}

interface LifecyclePayload {
  model: { slug: string; name: string; provider: string };
  lifecycle: {
    state: string;
    retiresOn: string | null;
    retiresInDays: number | null;
    replacement: string | null;
    viaSnapshot: string | null;
    retiresOnFamily: string | null;
    requestedSnapshot: string | null;
    requestedSnapshotKnown: boolean | null;
    appliesTo?: string | null;
  };
  provenance: { sourceUrl: string; checkedOn: string };
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (headline: string, data: unknown): ToolResult => ({
  content: [
    { type: "text", text: headline },
    { type: "text", text: JSON.stringify(data, null, 2) },
  ],
});

const bad = (failure: Failure): ToolResult => ({
  content: [{ type: "text", text: describeFailure(failure) }],
  isError: true,
});

export function buildServer(client: EvidenceApiClient = new EvidenceApiClient()): McpServer {
  /**
   * Every registration takes its title and description from the shared table
   * and records that it happened, so the two directions of drift both fail
   * here as well as in the gate: a tool with no entry in the table, and an
   * entry in the table with no tool. A server that silently offers three of
   * four tools is harder to notice than one that refuses to start.
   */
  const registered: string[] = [];
  const describe = (name: string): { title: string; description: string } => {
    const spec = mcpTool(name);
    if (!spec) {
      throw new Error(`server.ts registers "${name}", which MCP_TOOLS does not define`);
    }
    registered.push(name);
    return { title: spec.title, description: spec.description };
  };

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "ModelRefs holds governed benchmark evidence and provider-documented retirement dates " +
        "for a deliberate subset of AI models. Call list_covered_models before the others: a " +
        "model outside coverage answers 404 rather than returning an empty result, and that is " +
        "a statement about ModelRefs coverage, not about the model. Never quote a score from " +
        "these tools without the claim scope and methodology limitations returned beside it.",
    },
  );

  server.registerTool(
    "list_covered_models",
    { ...describe("list_covered_models"), inputSchema: {} },
    async (): Promise<ToolResult> => {
      const result = await client.get<CoveragePayload>("/v1/coverage", { auth: false });
      if (!result.ok) return bad(result.failure);
      const { modelsWithEvidence, modelsInCatalogue } = result.value;
      return ok(
        `ModelRefs holds governed evidence for ${modelsWithEvidence} of ${modelsInCatalogue} ` +
          `catalogued models. The ${modelsWithEvidence} slugs below are the ones the evidence ` +
          `and comparison tools can answer for; anything else answers 404, which describes ` +
          `ModelRefs coverage rather than the model.`,
        result.value,
      );
    },
  );

  server.registerTool(
    "get_model_evidence",
    {
      ...describe("get_model_evidence"),
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe("A model slug from list_covered_models, for example gpt-5 or claude-sonnet-4-5."),
      },
    },
    async ({ slug }): Promise<ToolResult> => {
      const result = await client.get<EvidencePayload>(
        `/v1/models/${encodeURIComponent(slug)}/evidence`,
      );
      if (!result.ok) return bad(result.failure);
      const payload = result.value;
      const runs = payload.evidence.governedRuns ?? [];
      return ok(
        `${payload.model.name}: ${payload.evidence.citationCount} citation(s) and ` +
          `${payload.evidence.governedRunCount} governed benchmark run(s). Each run carries ` +
          `claimScope and methodologyLimitations — what the publisher claimed and what they did ` +
          `not disclose. Quote a score only together with those two fields. ` +
          (runs.length
            ? `Benchmarks held: ${[...new Set(runs.map((r) => r.benchmarkName ?? r.benchmark))].join(", ")}.`
            : `No governed runs are held for this model; the citations are what there is.`),
        payload,
      );
    },
  );

  server.registerTool(
    "check_model_lifecycle",
    {
      ...describe("check_model_lifecycle"),
      inputSchema: {
        slug: z.string().min(1).describe("The model family slug, for example gpt-4o."),
        snapshot: z
          .string()
          .optional()
          .describe(
            "The dated snapshot id the calling code actually pins, for example " +
              "gpt-4o-2024-05-13. Send it whenever one is pinned: providers retire snapshots " +
              "before the family and name a different replacement for them.",
          ),
      },
    },
    async ({ slug, snapshot }): Promise<ToolResult> => {
      const query = snapshot ? `?snapshot=${encodeURIComponent(snapshot)}` : "";
      const result = await client.get<LifecyclePayload>(
        `/v1/models/${encodeURIComponent(slug)}/lifecycle${query}`,
      );
      if (!result.ok) return bad(result.failure);

      const { model, lifecycle, provenance } = result.value;
      const lines: string[] = [];
      lines.push(
        `${model.name} (${model.provider}) is ${lifecycle.state}` +
          (lifecycle.retiresOn
            ? `, retiring ${lifecycle.retiresOn}` +
              (typeof lifecycle.retiresInDays === "number"
                ? lifecycle.retiresInDays >= 0
                  ? ` — ${lifecycle.retiresInDays} day(s) from now`
                  : ` — ${Math.abs(lifecycle.retiresInDays)} day(s) ago`
                : "")
            : ", with no retirement date published") +
          ".",
      );
      if (lifecycle.replacement) lines.push(`Replacement: ${lifecycle.replacement}.`);
      if (lifecycle.viaSnapshot) {
        lines.push(`That date is the one for snapshot ${lifecycle.viaSnapshot}.`);
      }
      if (
        lifecycle.retiresOnFamily &&
        lifecycle.retiresOn &&
        lifecycle.retiresOnFamily !== lifecycle.retiresOn
      ) {
        lines.push(
          `The family-wide date is ${lifecycle.retiresOnFamily}, which is LATER than the one ` +
            `above. Use the snapshot date for pinned code.`,
        );
      }
      if (lifecycle.requestedSnapshot && lifecycle.requestedSnapshotKnown === false) {
        lines.push(
          `No record is held for snapshot ${lifecycle.requestedSnapshot}, so this answer fell ` +
            `back to the family. Treat it as less certain than a snapshot-level answer.`,
        );
      }
      lines.push(
        `Source: ${provenance.sourceUrl}, last checked by a reviewer on ${provenance.checkedOn}. ` +
          `ModelRefs does not infer retirement dates.`,
      );
      return ok(lines.join(" "), result.value);
    },
  );

  server.registerTool(
    "compare_models",
    {
      ...describe("compare_models"),
      inputSchema: {
        slugs: z
          .array(z.string().min(1))
          .min(2)
          .max(5)
          .describe("Two to five model slugs from list_covered_models."),
      },
    },
    async ({ slugs }): Promise<ToolResult> => {
      const unique = [...new Set(slugs.map((s) => s.trim().toLowerCase()))];
      if (unique.length < 2) {
        return bad({
          kind: "config",
          message: "A comparison needs at least two distinct models.",
          hint: "Pass two different slugs. The same slug twice is not a comparison.",
        });
      }

      const fetched: ModelRuns[] = [];
      for (const slug of unique) {
        const result = await client.get<EvidencePayload>(
          `/v1/models/${encodeURIComponent(slug)}/evidence`,
        );
        /* ONE MISSING MODEL FAILS THE WHOLE COMPARISON. Comparing the ones
           that answered and quietly omitting the rest would return a ranking
           that looks complete and is not, which is strictly worse than saying
           which model could not be read. */
        if (!result.ok) return bad(result.failure);
        fetched.push({
          slug: result.value.model.slug,
          name: result.value.model.name,
          runs: result.value.evidence.governedRuns ?? [],
        });
      }

      const comparison = compareModels(fetched);
      const headline = [
        comparison.summary,
        comparison.comparable.length
          ? "Leaders per benchmark: " +
            comparison.comparable
              .map((c) => `${c.benchmarkName} — ${c.leader} (by ${c.spread.toFixed(1)} ${c.metric ?? "points"})`)
              .join("; ") +
            "."
          : null,
        comparison.incomparable.length
          ? "NOT ranked, because the runs are different quantities: " +
            comparison.incomparable.map((i) => i.benchmarkName).join(", ") +
            ". Read the incomparable array before summarising this comparison."
          : null,
      ]
        .filter(Boolean)
        .join(" ");
      return ok(headline, comparison);
    },
  );

  const declared = MCP_TOOLS.map((t) => t.name).sort();
  const actual = [...registered].sort();
  if (declared.join(",") !== actual.join(",")) {
    throw new Error(
      `MCP_TOOLS declares [${declared.join(", ")}] but this server registers ` +
        `[${actual.join(", ")}]. The reference page renders the table, so the two must agree.`,
    );
  }

  return server;
}
