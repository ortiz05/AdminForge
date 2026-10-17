/**
 * How the synthetic tenant holds its objects: a `Collection` is a size and an `at(i)` — either a materialised array or
 * a virtual one that builds item i on demand (sign-ins, audit events, registration details, usage report rows). The
 * fake Graph (tests/perf/graph/fake-graph.ts) filters, sorts and pages any collection the same way; `range` lets a
 * time-ordered virtual collection narrow a `ge`/`le` filter on its time field to an index window instead of a scan.
 */

export type GraphObject = Record<string, unknown>;

export interface Collection {
  readonly size: number;
  at(i: number): GraphObject;
  /**
   * A time-ordered collection (newest first): the index window [lo, hi) where `field` lies within [from, to].
   * Undefined when the field isn't the collection's time field.
   */
  range?(field: string, from: number | undefined, to: number | undefined): [number, number] | undefined;
  /**
   * Virtual logs (sign-ins, audits): Graph scans them server-side and answers a filtered page after a bounded amount of
   * work, possibly with fewer items than asked plus a nextLink. The fake mirrors that with a scan budget.
   */
  scanBudget?: number;
}

export const materialised = (items: GraphObject[]): Collection => ({
  size: items.length,
  at: (i) => items[i]!,
});

export const virtual = (size: number, at: (i: number) => GraphObject): Collection => ({ size, at });

/** A collection with one more lookup: id → object (directory objects, devices, policies). */
export class IdIndex {
  private readonly map = new Map<string, { kind: string; at: () => GraphObject }>();
  add(id: string, kind: string, at: () => GraphObject): void {
    this.map.set(id.toLowerCase(), { kind, at });
  }
  get(id: string): { kind: string; object: GraphObject } | undefined {
    const hit = this.map.get(id.toLowerCase());
    return hit ? { kind: hit.kind, object: hit.at() } : undefined;
  }
  get size(): number {
    return this.map.size;
  }
}
