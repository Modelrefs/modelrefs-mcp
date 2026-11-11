# modelrefs-mcp

An MCP server for the [ModelRefs Evidence API](https://modelrefs.com/documentation#mcp). It gives
an agent governed benchmark evidence, provider-documented retirement dates, and comparisons that
refuse to rank scores that are not comparable — inside the editor, where the model choice is
actually being made.

It holds no data of its own. It wraps three HTTP endpoints and is published separately so that
installing it does not mean trusting a bundled copy of anything.

## Install

Claude Desktop, Claude Code, Cursor, Windsurf and anything else that reads an `mcpServers` block:

```json
{
  "mcpServers": {
    "modelrefs": {
      "command": "npx",
      "args": ["-y", "modelrefs-mcp"],
      "env": { "MODELREFS_API_KEY": "mr_live_…" }
    }
  }
}
```

Claude Code, in one line:

```bash
claude mcp add modelrefs --env MODELREFS_API_KEY=mr_live_… -- npx -y modelrefs-mcp
```

The key is optional. Without it the server still starts and `list_covered_models` still answers,
which is the tool worth trying first. Keys are created at
[modelrefs.com/api-keys](https://modelrefs.com/api-keys); the free tier includes 1,000 calls a
month. The key is read from the environment and never from a command-line argument, because argv
is visible to every process on the machine.

## Tools

| Tool | Needs a key | What it answers |
| --- | --- | --- |
| `list_covered_models` | No | Which model slugs ModelRefs holds governed evidence for. |
| `get_model_evidence` | Yes | A model's citations and governed benchmark runs, each with its source, claim scope and the methodology its publisher did **not** disclose. |
| `check_model_lifecycle` | Yes | Whether a model is deprecated, when it retires and what replaces it — resolved for the snapshot your code actually pins. |
| `compare_models` | Yes | Two to five models on the benchmarks where their runs are genuinely comparable, plus everything that could not be compared and why. |

### Why `compare_models` refuses things

Two runs are put side by side only when the **benchmark**, the **metric** and the **task subset**
all match. A shared benchmark name is not comparability.

The case that forced the rule: Anthropic reports tau-bench Retail and Airline separately, and the
same model differs by roughly twenty points between them, while OpenAI reports tau2-bench telecom.
Printing 96.7 on telecom beside 81.4 on Retail reads as a capability gap and is mostly a domain
difference. So those land in an `incomparable` list with the reason, rather than being ranked.

Benchmarks only one model has evidence for land in `oneSided`, because "A beats B" and "we only
measured A" are different claims.

### Why `check_model_lifecycle` wants a snapshot id

Providers retire individual snapshots months before the family, with a different replacement.
`gpt-4o` retires 2027-01-14; `gpt-4o-2024-05-13` retired 2026-10-23 and pointed somewhere else. A
family-level answer is wrong by months for whoever pinned early, so pass the dated id your code
actually uses:

```
check_model_lifecycle(slug: "gpt-4o", snapshot: "gpt-4o-2024-05-13")
```

With no snapshot, the earliest date across the family and all its snapshots is returned — never
the family date alone. If you pass a snapshot there is no record for, the answer says so rather
than quietly giving you the family date.

## What it will not do

- **It does not run inference.** No completion, embedding or image tools. This is a reference
  layer, not a model gateway.
- **It does not return a score without its scope.** Every run carries `claimScope` and
  `methodologyLimitations`; the tool descriptions tell the agent not to quote one without them.
- **It does not pretend to cover the catalogue.** ModelRefs holds governed evidence for a subset.
  A model outside it answers 404 rather than an empty payload, because an empty payload invites a
  reader to treat absence as a finding. Call `list_covered_models` first.
- **It does not infer a retirement date.** A model with no reviewed lifecycle record answers 404,
  and that means *unknown*, not *active*.
- **It does not cache.** A stale retirement date is the one answer this product must never give,
  and a cache in a long-lived editor session is exactly how you give one.

## Development

```bash
npm install
npm run build
npm run selftest
```

The self-test connects a real MCP client to the server over an in-memory transport and points it
at a local stub of the Evidence API, so what it exercises is the server that ships. It asserts the
refusals, not only the answers: a suite that only checked the happy path would pass against a
version that ranked tau-bench Retail against tau2-bench telecom, which is the one defect this code
exists to prevent.

The tool table is generated from `src/lib/api-docs/mcp.ts` in the main repository, which the
reference page also renders, and `npm run governance:mcp-parity` there fails if the copy drifts or
a tool names an endpoint that does not exist.

## Licence

MIT.
