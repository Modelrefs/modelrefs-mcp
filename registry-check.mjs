/**
 * Proves the PUBLISHED package works, fetched from the registry, the way a
 * user will actually run it.
 *
 * WHY THIS IS A THIRD CHECK AND NOT A DUPLICATE. The self-test connects to the
 * server in-process. stdio-check.mjs installs a locally packed tarball.
 * Neither proves that what npm SERVES resolves, downloads and runs: the
 * published `files` list, the `bin` entry, the shebang and the dependency tree
 * npm installs on someone else's machine are only exercised by fetching it.
 *
 * IT IS IN TWO PARTS:
 *
 *   PART 1 launches `npx -y modelrefs-mcp` and speaks one raw JSON-RPC frame
 *   to it, which proves npm resolution, the download, the bin entry and the
 *   shebang — the published INSTRUCTION.
 *
 *   PART 2 installs the registry copy into a throwaway directory and holds a
 *   full MCP conversation with it, which proves the tools, the live call and
 *   the refusals — the published BEHAVIOUR.
 *
 * PART 1 USES cross-spawn, NOT node's spawn, and that is load-bearing. Node 20+
 * refuses to spawn a `.cmd` without a shell (EINVAL), and `shell: true`
 * mangles the arguments so npx cannot find the bin. cross-spawn is what the
 * MCP SDK itself uses to launch a server, so it is also what a real client
 * uses: testing through anything else tests a path no user takes. Getting this
 * wrong produced "MCP error -32000: Connection closed", which reads exactly
 * like a broken package and was a broken harness.
 *
 * ONE REAL FINDING CAME OUT OF THAT. Under cross-spawn on Windows,
 * `npx -y modelrefs-mcp` works and `npx -y modelrefs-mcp@0.1.0` answers
 * "'modelrefs-mcp' is not recognized as an internal or external command". The
 * package bytes are identical in both cases, and the same package works
 * through its own `.bin` shim and through `npx --no-install`, so the
 * difference is in how npx resolves a bin from its cache when given a VERSION
 * SPEC. Anyone pinning a version in an mcpServers config on Windows hits it,
 * which is why the README now says not to. A third-party control run was
 * blocked by this environment, so it is not established that every package
 * behaves this way — only that nothing in ours causes it.
 *
 * Run: npm run verify:registry
 */
import { spawnSync } from "node:child_process";
import spawn from "cross-spawn";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SPEC = process.argv[2] ?? "modelrefs-mcp";
const PUBLISHED_VERSION = "0.1.0";
const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/* NO MODELREFS_API_KEY: this is the state a new user is in on their first run,
   and the server must still start and still list every tool rather than
   exiting and looking broken. Removed by name from an inherited environment,
   because npx needs SystemRoot, ComSpec and the rest to run at all. */
const childEnv = { ...process.env };
delete childEnv.MODELREFS_API_KEY;

/* ---------------------------------------------------- part 1: npx resolution */

console.log(`part 1 — npx -y ${SPEC}\n`);

const initFrame =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "registry-check", version: "0.0.0" },
    },
  }) + "\n";

const { npxOut, npxErr } = await new Promise((done) => {
  const child = spawn("npx", ["-y", SPEC], { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += String(c)));
  child.stderr.on("data", (c) => (err += String(c)));
  child.on("error", (e) => (err += `spawn error: ${e.message}`));
  child.stdin.write(initFrame);
  /* Long enough for a cold npx cache to download the package on a slow link. */
  setTimeout(() => {
    child.kill();
    done({ npxOut: out, npxErr: err });
  }, 60_000);
});

check(
  "npx resolves the package from the registry and finds its bin",
  !/is not recognized as an internal or external command/.test(npxErr),
  npxErr.trim().split("\n")[0],
);
check(
  "the published bin starts and logs to stderr, not stdout",
  /starting on stdio/.test(npxErr),
  npxErr.trim().split("\n").slice(-1)[0],
);
check(
  "it reports that no API key is configured rather than exiting",
  /API key NOT configured/.test(npxErr),
);
let handshake = null;
for (const line of npxOut.split("\n")) {
  if (!line.trim()) continue;
  try {
    const parsed = JSON.parse(line);
    if (parsed.id === 1) handshake = parsed;
  } catch {
    /* not a frame */
  }
}
check("it answers initialize over stdio", Boolean(handshake?.result), npxOut.slice(0, 160));
check("it identifies itself as modelrefs", handshake?.result?.serverInfo?.name === "modelrefs");
check(
  "the version it reports is the published one",
  handshake?.result?.serverInfo?.version === PUBLISHED_VERSION,
  handshake?.result?.serverInfo?.version,
);
check(
  "the handshake carries the instruction to call coverage first",
  (handshake?.result?.instructions ?? "").includes("list_covered_models"),
);

/* ------------------------------- part 2: the registry copy, driven over MCP */

console.log(`\npart 2 — a full MCP conversation with the installed registry copy\n`);

const dir = resolve(here, ".registry-check");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "registry-check", private: true }, null, 2));

const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", SPEC], {
  cwd: dir,
  encoding: "utf-8",
  env: childEnv,
  shell: process.platform === "win32",
});
if (install.status !== 0) {
  console.error(install.stdout, install.stderr);
  process.exit(1);
}

const binary = join(dir, "node_modules", "modelrefs-mcp", "dist", "index.js");
const client = new Client({ name: "registry-check", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [binary],
  env: childEnv,
  stderr: "pipe",
});

await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  "all four tools are listed with no key configured",
  names.join(",") === "check_model_lifecycle,compare_models,get_model_evidence,list_covered_models",
  names.join(","),
);
check(
  "every tool carries a description an agent can act on",
  tools.every((t) => (t.description ?? "").length > 80),
);
check(
  "check_model_lifecycle exposes the snapshot parameter",
  Boolean(tools.find((t) => t.name === "check_model_lifecycle")?.inputSchema?.properties?.snapshot),
);

const live = await client.callTool({ name: "list_covered_models" });
const text = (live.content ?? []).map((c) => c.text ?? "").join("\n");
check("list_covered_models answers against the LIVE API", live.isError !== true, text.slice(0, 200));
check(
  "the live answer carries real model slugs",
  /"gpt-5"/.test(text) && /"claude-sonnet-4-5"/.test(text),
);
check(
  "it states coverage is a subset of the catalogue",
  /of \d+ catalogued models/.test(text),
  text.split("\n")[0],
);

const keyless = await client.callTool({ name: "get_model_evidence", arguments: { slug: "gpt-5" } });
check("a keyed tool refuses rather than sending an unauthenticated request", keyless.isError === true);
check(
  "the refusal names the env var and where to get a key",
  (keyless.content ?? []).some(
    (c) => (c.text ?? "").includes("MODELREFS_API_KEY") && (c.text ?? "").includes("api-keys"),
  ),
  JSON.stringify(keyless.content).slice(0, 200),
);

await client.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\nregistry check: ${failures} failure(s).`);
process.exitCode = failures ? 1 : 0;
