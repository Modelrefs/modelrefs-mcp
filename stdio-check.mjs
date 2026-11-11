/**
 * Proves the PUBLISHED ARTIFACT works: installs the tarball npm pack produces
 * into a directory of its own, then speaks MCP to it over a real stdio
 * subprocess, the way Claude Desktop and Cursor will.
 *
 * This is a different test from the package self-test. The self-test connects
 * to the server in-process, so it would pass even if `files`, `bin`, the
 * shebang or the module resolution of the shipped tarball were wrong — which
 * is exactly the class of thing that makes an npm package fail only after
 * someone installs it.
 *
 * Run: npm run verify:tarball  (packs, installs, drives, cleans up)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

/* Packed here rather than taken as an argument: a check that accepts a path
   can be pointed at a stale tarball, which is the one way this test can pass
   while the thing about to be published is broken. */
const packed = spawnSync("npm", ["pack", "--json"], {
  cwd: here,
  encoding: "utf-8",
  shell: process.platform === "win32",
});
if (packed.status !== 0) {
  console.error(packed.stdout, packed.stderr);
  process.exit(1);
}
const tarball = resolve(here, JSON.parse(packed.stdout)[0].filename);
const dir = resolve(here, ".stdio-check");
rmSync(dir, { recursive: true, force: true });

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stdio-check", private: true }, null, 2));

console.log(`installing ${tarball} into ${dir}`);
const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
  cwd: dir,
  encoding: "utf-8",
  shell: process.platform === "win32",
});
if (install.status !== 0) {
  console.error(install.stdout, install.stderr);
  process.exit(1);
}

const binary = join(dir, "node_modules", "modelrefs-mcp", "dist", "index.js");
console.log(`starting ${binary} over stdio\n`);

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const client = new Client({ name: "stdio-check", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [binary],
  /* NO MODELREFS_API_KEY ON PURPOSE: the installed server must still start and
     still list every tool, because that is what a user sees before they have a
     key, and a server that exits there looks broken rather than unconfigured.
     The environment is built explicitly rather than inherited so that an API
     key sitting in the shell cannot quietly make the keyless assertions pass.

     MODELREFS_API_URL IS PASSED THROUGH, and it has to be: the child is a
     separate process, so an override set here but not forwarded would be read
     by this script and ignored by the server under test. That is exactly how
     the first attempt to exercise the unreachable-API path produced three
     green live assertions against the real API. */
  env: {
    PATH: process.env.PATH ?? "",
    ...(process.env.MODELREFS_API_URL
      ? { MODELREFS_API_URL: process.env.MODELREFS_API_URL }
      : {}),
  },
  stderr: "pipe",
});

await client.connect(transport);

const info = client.getServerVersion();
check("the installed package starts and completes the MCP handshake", Boolean(info), JSON.stringify(info));
check("it introduces itself as modelrefs", info?.name === "modelrefs", info?.name);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check("it lists four tools with no key configured", names.length === 4, names.join(","));
check(
  "the tool names are the documented ones",
  names.join(",") === "check_model_lifecycle,compare_models,get_model_evidence,list_covered_models",
  names.join(","),
);

const instructions = client.getInstructions();
check(
  "the server instructions tell an agent to call coverage first",
  (instructions ?? "").includes("list_covered_models"),
  (instructions ?? "").slice(0, 80),
);

/* THE LIVE API, through the installed package, on the one tool that needs no
   key. These three assertions DEGRADE rather than fail when the API cannot be
   reached at all, because this check runs on every merge and a Supabase blip
   must not block one: a transport failure is a statement about the network and
   not about the package. An API that is reachable and answers WRONGLY still
   fails, which is the case worth gating on. */
const live = await client.callTool({ name: "list_covered_models" });
const text = (live.content ?? []).map((c) => c.text ?? "").join("\n");
const unreachable = live.isError === true && /Could not reach the ModelRefs API/.test(text);
if (unreachable) {
  console.log("  NOTE the live API could not be reached, so the three live assertions were");
  console.log("       skipped. Everything above is hermetic and did run. Re-run this check");
  console.log("       before publishing, and do not read a skip as a pass.");
} else {
  check("list_covered_models answers against the LIVE API", live.isError !== true, text.slice(0, 200));
  check("the live answer names a real model slug", /"gpt-5"/.test(text), text.slice(0, 120));
  check(
    "the live answer states coverage is a subset of the catalogue",
    /of \d+ catalogued models/.test(text),
    text.split("\n")[0],
  );
}

const keyless = await client.callTool({
  name: "get_model_evidence",
  arguments: { slug: "gpt-5" },
});
check("a keyed tool refuses, rather than sending an unauthenticated request", keyless.isError === true);
check(
  "and the refusal names the environment variable and the keys page",
  (keyless.content ?? []).some(
    (c) => (c.text ?? "").includes("MODELREFS_API_KEY") && (c.text ?? "").includes("api-keys"),
  ),
  JSON.stringify(keyless.content),
);

await client.close();

/* The tarball and the throwaway install are both removed: a stale tarball in
   the package directory is the thing a releaser publishes by accident. */
rmSync(dir, { recursive: true, force: true });
rmSync(tarball, { force: true });
console.log(
  `\nstdio check: ${failures} failure(s)` +
    (unreachable ? ", 3 live assertion(s) SKIPPED because the API was unreachable." : "."),
);
process.exitCode = failures ? 1 : 0;
