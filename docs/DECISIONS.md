# Decision Records

Format: context → decision → rationale → alternatives → consequences →
migration → verification. Newest first.

---

## D-001: OmniRoute is the one canonical provider path

- **Date:** 2025-09-26
- **Status:** accepted
- **Affects:** model calls for every Pi session in this repository

### Context

An audit of the provider configuration found two provider paths installed
side by side, and evidence that they are not equivalent.

**What is configured**

| Source | Finding |
| --- | --- |
| `.pi/settings.json` (project) | `{"skills": ["../skills"]}` only. **No provider configuration at all.** |
| `~/.pi/agent/models.json` | Exactly **one** provider: `omni`, `baseUrl: http://localhost:20128`, `api: omni-prompt-tools`, **363 models**. It also carries a **plaintext `apiKey`** for the local gateway. |
| `~/.pi/agent/settings.json` → `packages` | **Four** packages installed: `npm:omniroute-pi-ext-integration` (2.0.1), `npm:pi-free` (2.8.2), `git:github.com/apmantza/pi-free` (2.8.2), `npm:@billjr99/pi-openai-compat` (1.1.34). |
| `~/.pi/agent/auth.json` | Credentials present for four providers: `kilo`, `groq`, `cline`, `llm7`. No credential for `omni` beyond the models.json value. |
| `~/.pi/agent/models-store.json` | Pi's runtime model store contains **`google`, `llm7`, `cline`, `fastrouter`, `kilo`, `groq`** — and **no `omni` entry**. |

**Which path model calls actually take**

The most recent session in this project
(`~/.pi/agent/sessions/--D--Agent-Harness-.../2026-09-26T05-18-57-695Z_*.jsonl`)
records 94 assistant messages with `"provider":"cline"` and 92 with
`"model":"stealth/space-bunny-alpha"`, plus one `provider=groq`. **Zero** calls
to `omni` / `localhost:20128`.

So the path documented as the default in `README.md` is not the path in use.
Calls are going direct to a third-party endpoint via **pi-free**, bypassing the
local OmniRoute gateway entirely.

**Conflicts between OmniRoute and pi-free**

1. **Provider surface.** pi-free registers ~25 additional providers (ollama,
   cline, llm7, zenmux, deepinfra, sambanova, novita, fastrouter, tokenrouter,
   requesty, and more) at their own remote `baseUrl`s. The model picker lists
   them alongside `omni`, so switching model is enough to change where data goes
   — with no code change and no project-level record of it.
2. **pi-free is installed twice.** `npm:pi-free` and `git:github.com/apmantza/pi-free`
   are the same package at the same version (2.8.2), from two sources. Both load
   as extensions, so provider registration, commands, and telemetry are
   duplicated.
3. **Credentials for the non-canonical path are live.** `auth.json` holds keys
   for `cline`, `groq`, `kilo`, and `llm7`, which is what makes the switch to a
   third party frictionless.
4. **`@billjr99/pi-openai-compat`** is a fourth route to any OpenAI-compatible
   endpoint, configured ad hoc.
5. **A credential is in a plain config file.** `models.json` stores the `omni`
   key in the clear rather than in Pi's credential store.

### Decision

**OmniRoute, reached through the `omni` provider declared in
`~/.pi/agent/models.json` and served by the `omniroute-pi-ext-integration`
extension, is the one canonical provider path for this project.**

`pi-free`, its git duplicate, and `pi-openai-compat` are **not** removed by this
decision. They are demoted to a **clearly-marked, non-default fallback** that
is off unless explicitly re-enabled, and documented as such in `README.md` and
`docs/ARCHITECTURE.md`.

The platform orchestrator is unaffected either way: it never calls a provider.
It only records trace events, and Pi owns the model call (see
`docs/PI_INTEGRATION.md`).

### Rationale

- It is what the project's own documentation already promises. The README, the
  architecture diagram, and `PI_INTEGRATION.md` all name OmniRoute.
- **One egress point is auditable.** All traffic to a model goes through
  `localhost:20128`, which is a boundary that can be observed. Four
  simultaneously-configured third-party providers are not.
- **Provider metadata is better.** The `omni` provider carries 363 models with
  enriched metadata (context window, max tokens, reasoning, vision, and
  per-model `tool_calling` flags that Pi strips from its own model type). pi-free
  does not write this metadata into `models.json` at all, which is why `omni` is
  absent from `models-store.json`.
- **Cost and entitlement stay in one place.** Free-tier and trial accounting is
  a single gateway's concern, not five providers'.
- It keeps the "never call OmniRoute directly" rule intact: the platform still
  never makes a model call; it only inherits whichever provider Pi is
  configured with.

### Alternatives considered

| Alternative | Why not |
| --- | --- |
| **Keep pi-free as the default** (make `cline`/`llm7` canonical) | Rejected. It contradicts the documented architecture, it sends data to third parties by default, and it is installed twice. If this becomes the desired direction, it should be a new decision record that updates the architecture docs, not a silent drift. |
| **Keep both, document neither** | Rejected. That is the status quo that produced this record. Ambiguity about where model data goes is the problem, not the solution. |
| **Have the orchestrator force a provider** | Rejected, and it is already forbidden: Pi owns the agent loop and the model call. The orchestrator must not depend on a model ID, and it must not call a provider directly. A project-level *default* in Pi's settings is the correct lever if one is ever needed. |
| **Delete the fallbacks outright** | Rejected for now, because an air-gapped or gateway-down run needs an escape hatch. They are demoted and off, not removed. |

### Consequences

**Good**

- One documented path, one place to change the model, one place to audit egress.
- `models-store.json` regains the `omni` metadata, improving the picker.
- The duplicate `pi-free` install can go, removing double registration.

**Bad / accepted costs**

- OmniRoute must be running on `localhost:20128` for the project to work. If it
  is down, the canonical path fails. That is a deliberate single point of
  failure, chosen over an ambiguous multi-provider default.
- The fallbacks stay installed, so a future model switch can still leave the
  gateway. The verification step below is what detects that.

**Follow-ups this creates**

- The plaintext `apiKey` in `models.json` should move to Pi's credential store.
  The value is deliberately not reproduced in this document, in source, or in
  any trace.

### Migration steps for the non-canonical path

**These commands are for the operator to run. Nothing below was executed by the
agent, and nothing was uninstalled or disabled automatically.** The
`settings.json` edit is a prerequisite for the other two, so do it first.

**1. Demote the fallbacks (reversible, no uninstall).** Edit
`~/.pi/agent/settings.json` and reduce `packages` to just the OmniRoute
extension. Back the file up first:

```bash
cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak
```

Target content for `packages`:

```json
"packages": [
  "npm:omniroute-pi-ext-integration"
]
```

**2. Remove the duplicate `pi-free` installs** (optional; the demotion in step 1
already stops them loading, this just cleans up):

```bash
pi packages remove pi-free
pi packages remove github.com/apmantza/pi-free
```

**3. Remove the unused third-party credentials** once the fallbacks are off and
you have confirmed nothing needs them. Inspect first, edit second — do not
blind-delete:

```bash
cat ~/.pi/agent/auth.json          # review what is stored
```

**4. Move the `omni` credential out of `models.json`.** Delete the `apiKey`
field from the `providers.omni` object in `~/.pi/agent/models.json` and store
the value through Pi's credential store instead, then restart Pi and confirm
model calls still succeed.

**5. Remove the openai-compat package** if you are not using it:

```bash
pi packages remove @billjr99/pi-openai-compat
```

**6. Restart Pi** (`/reload` may suffice) and confirm the model picker shows
`omni` models.

**To go the other way (revert to the fallback),** restore the backup and
restart:

```bash
cp ~/.pi/agent/settings.json.bak ~/.pi/agent/settings.json
```

### How to verify a model call went through the canonical provider

**1. A new session records the provider.** The most recent session file must
name `omni`, not a third party. Replace `<session>` with the newest file:

```bash
ls -t ~/.pi/agent/sessions/--D--Agent-Harness-*
grep -oE '"(provider|model)":"?[^",}]{0,40}' <session> | sort | uniq -c | sort -rn | head
```

The healthy result is `provider=omni` and no `cline` / `groq` / `llm7` entries.
Compare against the pre-migration evidence in the Context table above.

**2. The OmniRoute gateway sees the traffic.** While a Pi turn is running, the
gateway must show a request from `localhost`. Check the OmniRoute dashboard
started by `omniroute`. No request in the dashboard means the call did not go
through the gateway, whatever the config claims.

**3. The model store contains `omni`.** After a restart and one model call:

```bash
node -e "const j=require('fs').readFileSync(process.env.USERPROFILE+'/.pi/agent/models-store.json','utf8');console.log(JSON.parse(j)['omni']?'omni present':'omni MISSING')"
```

**4. The project trace shows the run.** The orchestrator records
`session_start` with `policyMode`, `allowedRoots`, and `policyConfig`, and a
`policy_decision` per tool call. The trace proves the *kernel* path. It does
not record the model provider — by design, since the orchestrator must not
depend on one. Provider verification is steps 1-3.

**5. No credentials anywhere.** No model call, trace, skill, or source file in
this repository contains an API key, token, or secret value. The session files
under `~/.pi/agent/sessions` are outside the repository.
