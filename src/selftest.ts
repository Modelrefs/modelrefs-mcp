/**
 * The self-test: a real MCP client, over a real transport, against the server
 * that ships, talking to a stub of the Evidence API.
 *
 * WHY A STUB AND NOT THE LIVE API. Three of the four tools need a key, and a
 * test that needs a production credential is a test that does not run. The
 * stub serves the SHAPES the live endpoints serve, including the awkward ones:
 * a snapshot whose retirement date differs from its family, and two models
 * whose runs share a benchmark slug but not a task subset. The live API is
 * verified separately, by calling it; this checks the behaviour that no
 * amount of calling the live API would reveal, because the live data does not
 * currently contain every case.
 *
 * WHY IT ASSERTS THE REFUSALS, NOT JUST THE ANSWERS. The value of this package
 * is what it declines to compare. A test that only checks the happy path would
 * pass against a version that ranked tau-bench Retail against tau2-bench
 * telecom, which is the single defect this code exists to prevent.
 *
 * Run it with `npm run selftest` after `npm run build`.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "./server.js";
import { EvidenceApiClient } from "./client.js";
import { MCP_KEY_ENV, MCP_TOOLS } from "./generated.js";
import { compareModels } from "./compare.js";

/* ------------------------------------------------------------------ fixtures */

const COVERAGE = {
  modelsInCatalogue: 477,
  modelsWithEvidence: 3,
  models: ["model-a", "model-b", "model-c"],
};

/** A run on a benchmark both models share, same metric, same (absent) subset. */
const sharedRun = (score: number) => ({
  benchmark: "gpqa",
  benchmarkName: "GPQA Diamond",
  score,
  scoreUnit: "% accuracy",
  higherIsBetter: true,
  modelVersion: "snapshot-1",
  publicationDate: "2025-08-07",
  publisher: "Example",
  sourceUrl: "https://example.invalid/a",
  sourceClass: "official-provider",
  claimScope: "Vendor-reported.",
  methodologyLimitations: "Prompt not disclosed.",
});

/** THE CASE THE RULE EXISTS FOR: one benchmark slug, two different subsets. */
const retailRun = {
  benchmark: "tau-bench",
  benchmarkName: "tau-bench",
  score: 81.4,
  scoreUnit: "% success",
  benchmarkSubset: "Retail",
  higherIsBetter: true,
  publicationDate: "2025-05-22",
  publisher: "Example",
};
const telecomRun = {
  benchmark: "tau-bench",
  benchmarkName: "tau-bench",
  score: 96.7,
  scoreUnit: "% success",
  benchmarkSubset: "tau2-telecom",
  higherIsBetter: true,
  publicationDate: "2025-08-07",
  publisher: "Example",
};

/** A benchmark only one of the two models has any run on. */
const soloRun = {
  benchmark: "aider-polyglot",
  benchmarkName: "Aider Polyglot",
  score: 88,
  scoreUnit: "% pass",
  higherIsBetter: true,
  publicationDate: "2025-08-07",
};

const EVIDENCE: Record<string, unknown> = {
  "model-a": {
    model: { slug: "model-a", name: "Model A" },
    evidence: {
      citationCount: 2,
      governedRunCount: 2,
      citations: [],
      governedRuns: [sharedRun(79.6), retailRun],
    },
    disclosure: { scope: "Source-scoped.", coverage: "A subset." },
  },
  "model-b": {
    model: { slug: "model-b", name: "Model B" },
    evidence: {
      citationCount: 3,
      governedRunCount: 3,
      citations: [],
      governedRuns: [sharedRun(85.7), telecomRun, soloRun],
    },
    disclosure: { scope: "Source-scoped.", coverage: "A subset." },
  },
};

const LIFECYCLE: Record<string, unknown> = {
  "model-a": {
    model: { slug: "model-a", name: "Model A", provider: "Example" },
    lifecycle: {
      state: "deprecated",
      deprecatedOn: "2025-08-07",
      retiresOn: "2026-10-23",
      retiresInDays: -19,
      replacement: "model-c",
      viaSnapshot: "model-a-2024-05-13",
      retiresOnFamily: "2027-01-14",
      appliesTo: null,
      snapshots: [{ id: "model-a-2024-05-13", retiresOn: "2026-10-23", replacement: "model-c" }],
      requestedSnapshot: null,
      requestedSnapshotKnown: null,
    },
    provenance: { sourceUrl: "https://example.invalid/deprecations", checkedOn: "2026-10-16" },
  },
};

const NO_LIFECYCLE_BODY = {
  error: "no_lifecycle_for_model",
  message: "ModelRefs holds no reviewed lifecycle record for that model.",
  hint: "Read this as unknown, not as active. We publish a retirement date only where the provider documents one and a reviewer has checked it.",
  docs: "https://modelrefs.com/documentation/#lifecycle",
  model: "model-z",
};

/* --------------------------------------------------------------- the stub API */

function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const http: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    const parts = url.pathname.split("/").filter(Boolean);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (parts[0] === "v1" && parts[1] === "coverage") return send(200, COVERAGE);

    /* Everything else is keyed, exactly as the live function is, so the
       missing-key path is exercised against a server that really refuses. */
    const auth = req.headers.authorization ?? "";
    if (!auth.toLowerCase().startsWith("bearer ")) {
      return send(401, {
        error: "missing_api_key",
        message: "No Authorization header was sent.",
        hint: "Send the header Authorization: Bearer <key>, using a key from /api-keys.",
        docs: "https://modelrefs.com/documentation/#authentication",
      });
    }

    if (parts[0] === "v1" && parts[1] === "models" && parts[3] === "evidence") {
      const payload = EVIDENCE[parts[2] ?? ""];
      if (!payload) {
        return send(404, {
          error: "no_evidence_for_model",
          message: "ModelRefs holds no governed evidence for that model.",
          hint: "This describes our coverage, not the model. Call GET /v1/coverage for the models that do have evidence.",
          docs: "https://modelrefs.com/documentation/#coverage",
          model: parts[2],
        });
      }
      return send(200, payload);
    }

    if (parts[0] === "v1" && parts[1] === "models" && parts[3] === "lifecycle") {
      const base = LIFECYCLE[parts[2] ?? ""] as
        | { lifecycle: Record<string, unknown> }
        | undefined;
      if (!base) return send(404, NO_LIFECYCLE_BODY);
      const asked = url.searchParams.get("snapshot");
      const known = (
        (base.lifecycle.snapshots as Array<{ id: string }> | undefined) ?? []
      ).some((s) => s.id === asked);
      return send(200, {
        ...base,
        lifecycle: {
          ...base.lifecycle,
          requestedSnapshot: asked,
          requestedSnapshotKnown: asked ? known : null,
        },
      });
    }

    return send(404, {
      error: "not_found",
      message: "That path is not an endpoint of this API.",
      hint: "The API has three routes.",
      docs: "https://modelrefs.com/documentation/#endpoints",
    });
  });

  return new Promise((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => http.close(() => done())),
      });
    });
  });
}

/* ------------------------------------------------- the registry manifest */

/**
 * server.json against the official registry schema, with a real draft 2020-12
 * validator.
 *
 * THIS LIVES HERE AND NOT IN THE REPOSITORY GATE because ajv 8 and ajv-formats
 * are already dependencies of the MCP SDK, so the validation costs nothing
 * here, while the repository root has only ajv 6 (a transitive eslint
 * dependency that predates 2020-12). The gate checks the schema limits it can
 * read; this checks the document.
 *
 * It caught the first draft: the description was 250 characters against a cap
 * of 100, which nothing except the schema would have said.
 */
async function validateRegistryManifest(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, "..", "server.json");
  const schemaPath = join(here, "..", "registry.schema.json");

  if (!existsSync(manifestPath) || !existsSync(schemaPath)) {
    check("server.json and the pinned registry schema are both present", false,
      `${manifestPath} / ${schemaPath}`);
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version: string;
    packages: Array<{ identifier: string; version: string }>;
  };

  const { default: AjvImport } = await import("ajv");
  const { default: addFormatsImport } = await import("ajv-formats");
  const AjvCtor = (AjvImport as unknown as { default?: unknown }).default ?? AjvImport;
  const addFormats =
    (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;
  const ajv = new (AjvCtor as new (o: unknown) => {
    compile(s: unknown): ((d: unknown) => boolean) & { errors?: unknown };
  })({ strict: false, allErrors: true });
  (addFormats as (a: unknown) => void)(ajv);

  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  const valid = validate(manifest);
  check(
    "server.json validates against the official MCP registry schema",
    valid,
    JSON.stringify(validate.errors),
  );

  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
    version: string;
  };
  check(
    "the registry manifest pins the version npm will actually have",
    manifest.version === pkg.version &&
      manifest.packages.every((p) => p.version === pkg.version),
    `manifest ${manifest.version} vs package ${pkg.version}`,
  );
}

/* ------------------------------------------------------------------- harness */

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface CallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function textOf(result: CallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function connect(apiUrl: string, apiKey: string | undefined): Promise<Client> {
  const server = buildServer(new EvidenceApiClient({ baseUrl: apiUrl, apiKey }));
  const client = new Client({ name: "selftest", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function main(): Promise<void> {
  const stub = await startStub();
  console.log(`modelrefs-mcp selftest — stub API at ${stub.url}\n`);

  try {
    /* ---------------------------------------------- the pure comparison rule */
    console.log("comparison rule");
    const rule = compareModels([
      { slug: "model-a", name: "Model A", runs: [sharedRun(79.6), retailRun] },
      { slug: "model-b", name: "Model B", runs: [sharedRun(85.7), telecomRun, soloRun] },
    ]);
    check(
      "a shared benchmark, metric and subset is compared",
      rule.comparable.length === 1 && rule.comparable[0]!.benchmark === "gpqa",
      JSON.stringify(rule.comparable.map((c) => c.benchmark)),
    );
    check(
      "the higher score leads where higherIsBetter",
      rule.comparable[0]?.leader === "model-b",
      String(rule.comparable[0]?.leader),
    );
    check(
      "the spread is in the published unit, not normalised",
      Math.abs((rule.comparable[0]?.spread ?? 0) - 6.1) < 0.001,
      String(rule.comparable[0]?.spread),
    );
    check(
      "the same benchmark with DIFFERENT subsets is refused, not ranked",
      rule.incomparable.length === 1 && rule.incomparable[0]!.benchmark === "tau-bench",
      JSON.stringify(rule.incomparable.map((i) => i.benchmark)),
    );
    check(
      "the refusal names the task subset as what differs",
      (rule.incomparable[0]?.reason ?? "").includes("task subset"),
      rule.incomparable[0]?.reason,
    );
    check(
      "tau-bench never appears as comparable",
      !rule.comparable.some((c) => c.benchmark === "tau-bench"),
    );
    check(
      "a benchmark only one model has is reported, not dropped",
      rule.oneSided.length === 1 && rule.oneSided[0]!.benchmark === "aider-polyglot",
      JSON.stringify(rule.oneSided.map((o) => o.benchmark)),
    );
    check(
      "a lower-is-better benchmark ranks the LOWER score first",
      (() => {
        const lower = (score: number) => ({
          benchmark: "hallucination",
          benchmarkName: "LongFact",
          score,
          scoreUnit: "% rate",
          higherIsBetter: false,
          publicationDate: "2025-08-07",
        });
        const r = compareModels([
          { slug: "a", name: "A", runs: [lower(9)] },
          { slug: "b", name: "B", runs: [lower(1)] },
        ]);
        return r.comparable[0]?.leader === "b";
      })(),
    );

    /* ------------------------------------------------- the server, keyed */
    console.log("\nserver with a key");
    const keyed = await connect(stub.url, "mr_test_selftest");
    const tools = await keyed.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    check(
      `all ${MCP_TOOLS.length} declared tools are listed`,
      names.join(",") === MCP_TOOLS.map((t) => t.name).sort().join(","),
      names.join(","),
    );
    check(
      "every listed tool carries a description an agent can act on",
      tools.tools.every((t) => (t.description ?? "").length > 80),
    );

    const coverage = (await keyed.callTool({ name: "list_covered_models" })) as CallResult;
    check("list_covered_models answers", coverage.isError !== true, textOf(coverage).slice(0, 120));
    check(
      "the coverage headline says coverage is a subset",
      textOf(coverage).includes("of 477"),
    );

    const evidence = (await keyed.callTool({
      name: "get_model_evidence",
      arguments: { slug: "model-a" },
    })) as CallResult;
    check("get_model_evidence answers", evidence.isError !== true);
    check(
      "the evidence headline demands the scope travel with the score",
      textOf(evidence).includes("methodologyLimitations"),
    );
    check(
      "governedRuns reach the caller",
      textOf(evidence).includes("\"governedRuns\""),
    );

    const missing = (await keyed.callTool({
      name: "get_model_evidence",
      arguments: { slug: "model-z" },
    })) as CallResult;
    check("an uncovered model is an error, not an empty result", missing.isError === true);
    check(
      "the API hint is passed through rather than flattened",
      textOf(missing).includes("Call GET /v1/coverage"),
      textOf(missing),
    );

    const family = (await keyed.callTool({
      name: "check_model_lifecycle",
      arguments: { slug: "model-a" },
    })) as CallResult;
    check("check_model_lifecycle answers", family.isError !== true);
    check(
      "the headline warns that the family date is later than the one returned",
      textOf(family).includes("LATER"),
      textOf(family).split("\n")[0],
    );
    check(
      "the provenance date is in the headline, not only the JSON",
      textOf(family).includes("2026-10-16"),
    );
    check(
      "a past date is described as past, not as a countdown",
      textOf(family).includes("day(s) ago"),
      textOf(family).split("\n")[0],
    );

    const unknownSnapshot = (await keyed.callTool({
      name: "check_model_lifecycle",
      arguments: { slug: "model-a", snapshot: "model-a-1999-01-01" },
    })) as CallResult;
    check(
      "an unrecognised snapshot is flagged as a fallback to the family",
      textOf(unknownSnapshot).includes("fell back to the family"),
      textOf(unknownSnapshot).split("\n")[0],
    );

    const noRecord = (await keyed.callTool({
      name: "check_model_lifecycle",
      arguments: { slug: "model-z" },
    })) as CallResult;
    check("a model with no lifecycle record is an error", noRecord.isError === true);
    check(
      "and the error says unknown rather than active",
      textOf(noRecord).includes("unknown, not as active"),
      textOf(noRecord),
    );

    const compared = (await keyed.callTool({
      name: "compare_models",
      arguments: { slugs: ["model-a", "model-b"] },
    })) as CallResult;
    check("compare_models answers", compared.isError !== true, textOf(compared).slice(0, 200));
    check(
      "the comparison headline names what it refused to rank",
      textOf(compared).includes("NOT ranked"),
      textOf(compared).split("\n")[0],
    );
    check(
      "the comparison fails as a whole when one model cannot be read",
      ((await keyed.callTool({
        name: "compare_models",
        arguments: { slugs: ["model-a", "model-z"] },
      })) as CallResult).isError === true,
    );
    check(
      "the same slug twice is refused as not a comparison",
      ((await keyed.callTool({
        name: "compare_models",
        arguments: { slugs: ["model-a", "MODEL-A"] },
      })) as CallResult).isError === true,
    );

    /* ----------------------------------------------- the server, with no key */
    console.log("\nserver with no key");
    const keyless = await connect(stub.url, undefined);
    const listedWithoutKey = await keyless.listTools();
    check(
      "the keyed tools are still LISTED without a key",
      listedWithoutKey.tools.length === MCP_TOOLS.length,
      String(listedWithoutKey.tools.length),
    );
    const freeTool = (await keyless.callTool({ name: "list_covered_models" })) as CallResult;
    check("the unkeyed tool works with no key", freeTool.isError !== true);
    const refused = (await keyless.callTool({
      name: "get_model_evidence",
      arguments: { slug: "model-a" },
    })) as CallResult;
    check("a keyed tool refuses with no key", refused.isError === true);
    check(
      `the refusal names ${MCP_KEY_ENV} and where to get a key`,
      textOf(refused).includes(MCP_KEY_ENV) && textOf(refused).includes("modelrefs.com/api-keys"),
      textOf(refused),
    );

    /* ------------------------------------- the registry submission manifest */
    console.log("\nregistry manifest");
    await validateRegistryManifest();

    /* ----------------------------------------- the server, API unreachable */
    console.log("\nserver with the API unreachable");
    const unreachable = await connect("http://127.0.0.1:1", "mr_test_selftest");
    const down = (await unreachable.callTool({ name: "list_covered_models" })) as CallResult;
    check("an unreachable API is an error", down.isError === true);
    check(
      "and it says retry rather than change the request",
      textOf(down).includes("Retry once with backoff"),
      textOf(down),
    );
  } finally {
    await stub.close();
  }

  console.log(
    `\nmodelrefs-mcp selftest: ${failures} failure(s).` +
      (failures ? "" : " Every refusal fired on the case it was written for."),
  );
  if (failures) process.exit(1);
}

main().catch((thrown: unknown) => {
  console.error(thrown);
  process.exit(1);
});
