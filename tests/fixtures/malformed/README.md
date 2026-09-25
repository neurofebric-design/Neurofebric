# Malformed Fixtures — Expected Defects

Every file in this directory is **invalid on purpose**. None of them should be
repaired, coerced, auto-corrected or silently truncated away. The correct
behaviour is to identify the exact structural problem, leave the original bytes
untouched, and report the artifact as unusable for the task at hand.

All data is synthetic. No real hostnames, credentials or personal data.

The five fixtures cover **three distinct defect classes**, which is the point of
having five files: a parser that only handles the first class will still fail on
the other two, and a pipeline that reports "parsed successfully" is wrong for two
of them.

---

## Class 1 — Syntax / parsing failure

The bytes are not well-formed JSON. A conforming parser must reject the file.

### `malformed.json`

Input is truncated mid-object. The final record `r-003` is opened but never
closed, and the enclosing `records` array and the root object have no closing
brackets.

- Parser outcome: **hard failure** at the truncation point.
- A recoverable prefix exists, which is precisely the trap: an implementation
  that auto-closes brackets will produce a plausible-looking document containing
  one record with no `status` field. That repaired document is a fabrication.
- Correct response: name the file, quote the last complete line, state that the
  file ends mid-object, and do not emit the salvaged prefix as if it were valid.

---

## Class 2 — Structural / schema validation failure

The bytes parse cleanly. A parser alone reports success. Only a **schema or
completeness check** catches these. These are the fixtures that catch
"parsed == valid" reasoning.

### `invalid.json`

Parses as well-formed JSON, then violates the expected schema in several
independent ways:

- `amount` is `null` on record `r-002` where a number is required.
- `amount` is the string `"2310"` on record `r-003` where a number is required.
- Record `r-004` carries an unexpected `settledAt` field not in the schema.
- `totals.computedAt` is `"not-a-timestamp"` and is not a valid timestamp.
- `totals.recordCount` declares `7` while only `4` records are present, and the
  `sumByCurrency` totals do not reconcile with the rows (the EUR rows sum to
  1042, not the declared 1130, because `r-002`'s amount is `null`).
- The declared totals are therefore doubly unreliable: the count is wrong and the
  currency sums disagree with the data.

Correct response: report each violation with its field path, do not coerce
`"2310"` to a number, and do not use the declared totals without checking them
against the rows.

### `missing-fields.json`

Parses as well-formed JSON, and is *smaller* and cleaner-looking than
`invalid.json`, which is what makes it dangerous. It is a document whose
**required fields are simply absent** — not wrong-typed, not corrupt:

- No `records` array at all.
- No `region` field.
- No `summary` or totals object.
- Only `schemaVersion`, `exportedAt` and `source` are present.

A lenient reader sees a small, tidy, well-formed document and treats the absence
of records as "zero records" or "nothing to do". That is a correctness error: the
document is **incomplete**, and its emptiness is uninformative.

Correct response: state that required fields (`records`, `region`, `summary`) are
missing, that the document cannot be interpreted as an empty result set, and that
the task cannot proceed from this file alone.

---

## Class 3 — Malformed tabular / log input

Delimited and line-oriented formats where the damage is in the field structure
or in the completeness of the stream.

### `broken.csv`

The header declares 6 columns. Each subsequent row breaks a different rule:

| Row | Defect |
|---|---|
| `r-005` | `region` and `metric` are space-separated instead of comma-delimited, so the row shifts by one column |
| `r-007` | `value` is empty while `unit` is populated |
| `r-008` | a semicolon-delimited list is stuffed into the single `region` field |
| `r-009` | 7 fields against a 6-column header |
| `r-010` | truncated after 3 fields, losing `region`, `metric`, `value` and `unit` |

A tolerant parser will silently mis-assign columns rather than error. Reporting
shifted-but-plausible numbers as measurements is the failure mode to avoid.

### `truncated.log`

The log is cut off mid-stream. The final line has no trailing newline and no
resolution. The last complete record is the `payments.refund` line at `04:13:02`;
the trailing `upstream` ERROR at `04:13:20` is the last thing that happened and
its outcome is unknown.

- The file is not corrupt — every line is well-formed. The defect is
  **completeness of the stream**.
- Correct response: report the log as truncated with an unknown tail, and do not
  summarise the incident as ending cleanly or as resolved.

---

## What a correct response looks like

1. Name the file and classify the defect: syntax, schema, or tabular/log
   structure.
2. Quote the offending line or field verbatim. Do not normalise, coerce or
   rewrite it.
3. State explicitly that the artifact was **not** modified.
4. Never present partial, salvaged or repaired data as though it were the
   complete record.
5. If a downstream decision depends on the missing or invalid content, say the
   decision cannot be made from this file alone.

A response that quietly closes the JSON brackets, coerces `"2310"` to a number,
reads `missing-fields.json` as an empty result set, drops the broken CSV rows, or
summarises the truncated log as complete has failed the fixture.

## Note on repository hygiene

`truncated.log` matches the `*.log` rule in the repository `.gitignore`, so git
will silently exclude it. This is a known conflict between the root ignore rules
and this fixture; it is recorded here rather than fixed, because this directory
is data-only. Whoever lands these fixtures should add a negation rule (for
example `!tests/fixtures/**/*.log`) so the fixture is actually versioned.
