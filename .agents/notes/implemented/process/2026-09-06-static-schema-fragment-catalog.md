# Agent Note: Static shared fields in configuration catalogs

Status: implemented

English | [中文](2026-09-06-static-schema-fragment-catalog.zh.md)

## Problem

OceanBase and Nacos providers share connection fields through object spreads. A configuration catalog that rejects these declarations cannot be regenerated, while one that skips them cannot detect accepted fields missing from a plugin's declared config type.

## Decision

The [configuration catalog generator](../../../../scripts/gen-config-catalog.ts) expands constant object literals through named local or workspace imports and package-local re-exports. It reads source without executing plugin modules. Later properties replace earlier spread values before nested paths are checked against the config type.

Unresolved or dynamic spreads, cyclic references, and non-plain keys fail the check. The inspection enumerates field paths, not runtime default values. It does not replace Schemastery validation or the [tool catalog's runtime schema collection](2026-07-02-tool-schema-catalog.md).

## Alternatives considered

**Skip shared fields.** A provider could accept undocumented connection fields while the check reported success.

**Duplicate fields in every provider.** Repetition would let accepted fields, defaults, and secret annotations diverge between providers.

**Execute package initializers.** Documentation generation would inherit module side effects and dependency requirements even though these field names are statically available.

## Consequences

The generated catalog includes the deployed Nacos and OceanBase providers without changing their runtime configuration. Unsupported dynamic field construction remains an explicit error.

[Focused generator tests](../../../../packages/examples/agent-spine-demo/tests/gen-config-catalog.spec.ts) exercise shared imports, re-exports, nested arrays, property precedence, and rejection of hidden, dynamic, or cyclic fields. The existing tool-catalog decision remains active because it owns runtime-composed model schemas, not static configuration declarations.
