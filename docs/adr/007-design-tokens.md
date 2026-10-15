# ADR-007: Design tokens in TypeScript compiled to CSS variables

Status: accepted (2026-10-15)

## Context

The look must be centrally controlled.

## Decision

tokens.ts → --af-* variables, Tailwind with defaults removed, recipes, runtime overrides.

## Consequences

Contrast is unit-tested; pages cannot style themselves.
