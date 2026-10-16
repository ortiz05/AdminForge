/**
 * GET /api/overview payloads (Example Org, synthetic; times relative to FIXED_NOW): `overview()` with every panel,
 * `overviewWithoutHealth()` for a partial page (service health refused). Used by mock-api.ts defaults, the shell/news
 * component tests and unit/web/overview.
 */
import { FIXED_NOW, TENANT_ID } from './session';

const ago = (ms: number) => new Date(FIXED_NOW - ms).toISOString();

/** GET /api/overview for Example Org (synthetic). */
export function overview() {
  return {
    org: {
      id: TENANT_ID,
      name: 'Example Org',
      domains: [
        { name: 'example.com', isDefault: true, isInitial: false },
        { name: 'exampleorg.onmicrosoft.com', isDefault: false, isInitial: true },
        { name: 'mail.example.com', isDefault: false, isInitial: false },
        { name: 'example.net', isDefault: false, isInitial: false },
      ],
    },
    counts: { users: 12408, groups: 1876, apps: 342, devices: 4972 },
    skus: [
      { sku: 'SPE_E5', used: 2412, total: 2500 },
      { sku: 'SPE_E3', used: 8120, total: 9000 },
      { sku: 'AAD_PREMIUM_P2', used: 640, total: 1000 },
      { sku: 'POWER_BI_PRO', used: 500, total: 500 },
      { sku: 'EMS', used: 610, total: 1200 },
      { sku: 'VISIOCLIENT', used: 42, total: 100 },
      { sku: 'PROJECTPREMIUM', used: 18, total: 50 },
    ],
    health: {
      items: [
        { service: 'Exchange Online', status: 'serviceDegradation' },
        { service: 'Microsoft Intune', status: 'investigating' },
        { service: 'Microsoft Teams', status: 'serviceOperational' },
        { service: 'SharePoint Online', status: 'serviceOperational' },
        { service: 'OneDrive for Business', status: 'serviceOperational' },
        { service: 'Microsoft Entra', status: 'serviceOperational' },
        { service: 'Microsoft Defender XDR', status: 'serviceRestored' },
      ],
    },
    provenance: {
      org: { service: 'graph', path: '/organization', ms: 214, cachedAt: ago(30_000) },
      counts: { service: 'graph', path: '/users/$count', ms: 95, cachedAt: ago(30_000) },
      skus: {
        service: 'graph',
        path: '/subscribedSkus',
        ms: 182,
        cachedAt: ago(30_000),
        requestId: '7b1e0f42-93ad-4c58-b2e6-5a0d81c4f3e9',
      },
      health: {
        service: 'graph',
        path: '/admin/serviceAnnouncement/healthOverviews',
        ms: 640,
        cachedAt: ago(90_000),
      },
    },
  };
}

/** Partial result: service health refused (403) but the rest of the page renders. */
export function overviewWithoutHealth() {
  return {
    ...overview(),
    health: {
      error: {
        code: 'forbidden',
        message: 'Microsoft Graph refused the service health request (403).',
        hint: 'Needs ServiceHealth.Read.All',
      },
    },
  };
}
