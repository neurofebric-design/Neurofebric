# Dependency Fixtures — Directed Graphs

Three graphs sharing one schema, so graph reasoning can be compared directly
across them. All graphs are directed. All ids are synthetic.

## Shared schema

```json
{
  "name": "string",
  "description": "string",
  "directed": true,
  "acyclic": true | false,
  "nodes": [ { "id": "string", "label": "string" } ],
  "edges": [ { "from": "node id", "to": "node id" } ]
}
```

## Files

| File | Shape | Acyclic? | Purpose |
|---|---|---|---|
| `valid-graph.json` | 5 nodes, single chain `a→b→c→d→e` | yes | Baseline. Correct answers: acyclic, one source, all nodes reachable from `a`. |
| `complex-graph.json` | 9 nodes, diamond joins, **two weakly-connected components** | yes | The real test. Every node is reachable *within its own component*, and no edge crosses between them. |
| `cyclic-graph.json` | 7 nodes, one 3-node cycle `x→y→z→x`, plus a chain and an isolated node | **no** | The real cycle must be named, not just detected. |

## What each one is actually testing

### `complex-graph.json` — independent components are not dependencies

`audit → rotate` is a separate component. There is no path between it and the
`root` component, and no path back. `audit` is **not** downstream of `root`, and
a failure in the `root` component does not imply a failure in `audit`.

The trap is reporting a single unified dependency ordering that implies
`audit` depends on `emit`, or conversely treating the two components as
"the same pipeline". Weak connectivity must not be mistaken for dependency.

Note also the diamonds: `decode` and `checksum` both feed `index`, and `index`
and `decode` both feed `join`. A correct topological order is not unique, and
producing one is not the same as producing a correct one.

### `cyclic-graph.json` — name the cycle

The cycle is exactly `x → y → z → x`. The chain `start → p → q` enters the cycle
but is **not** part of it, and `orphan` is not part of it either (it has an
inbound edge from `p` but no outbound edge).

A response that says "this graph has a cycle" is incomplete. The required
behaviour is to identify which nodes form the cycle and which do not, so the
cyclical sub-component can be identified on its own.

## Expected behaviour

1. Detect acyclicity correctly: `false` only for `cyclic-graph.json`.
2. When a cycle exists, report the specific nodes on it.
3. Distinguish weak components from dependencies — no path means no dependency.
4. Produce a valid topological order where the graph is acyclic, and say
   explicitly that none exists where it is not.
5. Not invent edges. The `label` fields are descriptions, not edges.

## Failing behaviours

- Reporting a cycle for `complex-graph.json` because it has branches.
- Merging the two components of `complex-graph.json` into one ordering.
- Including `p` or `orphan` in the cycle of `cyclic-graph.json`.
- Claiming a topological order exists for `cyclic-graph.json`.
