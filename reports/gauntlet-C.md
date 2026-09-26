# Structured Data Audit Report: Scenario C

## Executive Summary

This report provides a data quality and schema audit of `verification/scenarios/C-structured-audit/records.json`. The dataset contains 3 records in JSON array format. Analysis reveals schema heterogeneity (schema drift), with optional fields (`email`, `extra`) omitted across records rather than populated with explicit `null` values.

---

## Dataset Profile

- **File Path:** `verification/scenarios/C-structured-audit/records.json`
- **File Format:** JSON Array (`application/json`)
- **Total Record Count:** 3 records
- **Total Unique Fields:** 5 fields (`id`, `name`, `email`, `active`, `extra`)

---

## Schema Analysis

The universal schema encompasses 5 unique keys across the dataset. The table below details each field, its inferred data type, and presence frequency:

| Field Name | Inferred Type | Present Count | Missing / Omitted Count | Nullability / Status |
| :--- | :--- | :---: | :---: | :--- |
| `id` | Integer (`int`) | 3 / 3 | 0 | Mandatory / Non-nullable |
| `name` | String (`str`) | 3 / 3 | 0 | Mandatory / Non-nullable |
| `active` | Boolean (`bool`) | 3 / 3 | 0 | Mandatory / Non-nullable |
| `email` | String (`str`) | 2 / 3 | 1 | Optional / Semi-structured |
| `extra` | String (`str`) | 1 / 3 | 2 | Optional / Semi-structured |

---

## Data Quality & Schema Anomalies

1. **Schema Drift / Inconsistent Keys:**
   - The records do not conform to a strict static schema. Keys are omitted entirely in certain records rather than stored as `null` or empty strings.
2. **Missing Fields Breakdown:**
   - **`extra` field:** Absent in 2 out of 3 records (Record 0 and Record 1). Present only in Record 2 (`"extra_field"`).
   - **`email` field:** Absent in 1 out of 3 records (Record 1). Present in Records 0 and 2.
3. **Core Fields Integrity:**
   - `id`, `name`, and `active` are 100% present across all records with valid, consistent data types (`int`, `str`, `bool` respectively). No duplicate IDs were found.

---

## Record-by-Record Audit Trace

| Record Index | ID | Name | Active | Email | Extra | Anomalies / Notes |
| :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **0** | 1 | Alpha | `true` | `alpha@example.com` | *Missing* | Missing optional field `extra`. |
| **1** | 2 | Beta | `false` | *Missing* | *Missing* | Missing optional fields `email` and `extra`. |
| **2** | 3 | Gamma | `true` | `gamma@example.com` | `extra_field` | Complete record (all 5 fields present). |

---

## Conclusion & Recommendations

- **Data Governance:** Downstream consumers and validation pipelines must handle optional/omitted keys gracefully (treating absent keys as `null` or default values).
- **Schema Enforcement:** If strict contracts are required, incoming records should be validated against a JSON Schema enforcing required properties (`id`, `name`, `active`) and explicitly typing optional properties (`email`, `extra`).
