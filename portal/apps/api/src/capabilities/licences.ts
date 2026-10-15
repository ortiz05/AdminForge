import type { ExecutionIdentity, OutboundExecutor } from '../execution/types';
import { FEATURES, type FeatureKey } from './features';

/** A tenant subscription (SKU) as AdminForge reads it from Graph `subscribedSkus`. */
export interface TenantSku {
  skuPartNumber: string;
  capabilityStatus: string;
  enabled: number;
  consumed: number;
  /** Service plans that are provisioned (Success / Pending*). */
  servicePlans: string[];
}

export interface TenantLicences {
  skus: TenantSku[];
  /** Upper-case SKU part numbers and service plan names of active subscriptions. */
  names: Set<string>;
  /** Service plan → SKU part number that provides it (first match). */
  providedBy: Map<string, string>;
}

interface GraphSku {
  skuPartNumber?: string;
  capabilityStatus?: string;
  consumedUnits?: number;
  prepaidUnits?: { enabled?: number; warning?: number };
  servicePlans?: Array<{ servicePlanName?: string; provisioningStatus?: string }>;
}

const ACTIVE_SKU = new Set(['enabled', 'warning']);
const ACTIVE_PLAN = new Set(['success', 'pendingactivation', 'pendingprovisioning', 'pendinginput']);

export function parseSubscribedSkus(body: unknown): TenantLicences {
  const list = ((body as { value?: GraphSku[] } | undefined)?.value ?? []).filter((s) => s && typeof s === 'object');
  const skus: TenantSku[] = list.map((s) => ({
    skuPartNumber: s.skuPartNumber ?? 'unknown',
    capabilityStatus: s.capabilityStatus ?? 'Unknown',
    enabled: (s.prepaidUnits?.enabled ?? 0) + (s.prepaidUnits?.warning ?? 0),
    consumed: s.consumedUnits ?? 0,
    servicePlans: (s.servicePlans ?? []).filter((p) => p.servicePlanName && ACTIVE_PLAN.has((p.provisioningStatus ?? '').toLowerCase())).map((p) => p.servicePlanName!),
  }));
  const names = new Set<string>();
  const providedBy = new Map<string, string>();
  for (const s of skus) {
    if (!ACTIVE_SKU.has(s.capabilityStatus.toLowerCase()) || s.enabled <= 0) continue;
    names.add(s.skuPartNumber.toUpperCase());
    for (const p of s.servicePlans) {
      names.add(p.toUpperCase());
      if (!providedBy.has(p.toUpperCase())) providedBy.set(p.toUpperCase(), s.skuPartNumber);
    }
  }
  return { skus, names, providedBy };
}

const isFeature = (name: string): name is FeatureKey => Object.hasOwn(FEATURES, name);

/**
 * Whether the tenant holds a licence named in content: a feature key from the capabilities map (`pim`, `exchange`,
 * `defender`, … — satisfied by any service plan that enables it) or a SKU part number / service plan name.
 */
export function hasLicence(lic: TenantLicences, name: string): boolean {
  if (isFeature(name)) return FEATURES[name].plans.some((p) => lic.names.has(p));
  return lic.names.has(name.toUpperCase());
}

/** Required licences (any of) the tenant lacks: [] = satisfied, null = unknown (licences could not be read). */
export function missingLicences(lic: TenantLicences | null, required: readonly string[] | undefined): string[] | null {
  if (!required?.length) return [];
  if (!lic) return null;
  return required.some((r) => hasLicence(lic, r)) ? [] : [...required];
}

/** "Requires Microsoft Entra ID P2 (AAD_PREMIUM_P2)" for feature keys; "Requires INTUNE_A or EMS" for SKU/plan names. */
export const requiresBadge = (missing: readonly string[]) => `Requires ${missing.map((m) => (isFeature(m) ? FEATURES[m].requires : m)).join(' or ')}`;

const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;

/**
 * Tenant licences from `subscribedSkus`, cached per tenant (10 min; 1 min when unreadable). Read with the caller's
 * identity so a user without directory read access simply gets "unknown" (nothing is badged) instead of an error.
 */
export class LicenceService {
  private readonly cache = new Map<string, { value: Promise<TenantLicences | null>; expires: number }>();

  constructor(
    private readonly outbound: OutboundExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(identity: ExecutionIdentity, opts: { correlationId?: string; signal?: AbortSignal } = {}): Promise<TenantLicences | null> {
    const key = identity.kind === 'automation' ? 'automation' : identity.session.tenantId;
    const hit = this.cache.get(key);
    const t = this.now().getTime();
    if (hit && hit.expires > t) return hit.value;
    const entry = { value: Promise.resolve<TenantLicences | null>(null), expires: t + OK_TTL_MS };
    entry.value = this.outbound
      .execute(identity.kind === 'automation' ? identity : { ...identity, mode: 'read' }, { service: 'graph', method: 'GET', path: '/subscribedSkus' }, opts)
      .then((r) => parseSubscribedSkus(r.data))
      .catch(() => {
        entry.expires = this.now().getTime() + FAIL_TTL_MS;
        return null;
      });
    this.cache.set(key, entry);
    return entry.value;
  }

  clear(): void {
    this.cache.clear();
  }
}
