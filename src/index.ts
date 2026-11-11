#!/usr/bin/env node
/**
 * The stdio entry point.
 *
 * NOTHING MAY BE WRITTEN TO STDOUT HERE. The stdio transport owns stdout as a
 * JSON-RPC channel, so a stray console.log is not a log line, it is a
 * malformed frame that disconnects the client. Every diagnostic goes to
 * stderr, which the host shows in its MCP log panel.
 *
 * THE KEY IS NOT CHECKED AT STARTUP. A server that exits because no key is
 * configured looks broken in the client, and the one tool that needs no key is
 * the one a new user should reach first. So it starts, lists everything, and
 * the keyed tools answer with a failure that names where to get a key.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer, SERVER_VERSION } from "./server.js";
import { EvidenceApiClient } from "./client.js";
import { MCP_KEY_ENV, MCP_PACKAGE_NAME } from "./generated.js";

async function main(): Promise<void> {
  const client = new EvidenceApiClient();
  const server = buildServer(client);

  process.stderr.write(
    `${MCP_PACKAGE_NAME} ${SERVER_VERSION} starting on stdio; API key ` +
      `${client.hasKey ? "configured" : `NOT configured (set ${MCP_KEY_ENV})`}\n`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((thrown: unknown) => {
  process.stderr.write(
    `${MCP_PACKAGE_NAME} failed to start: ${
      thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)
    }\n`,
  );
  process.exit(1);
});
