import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Retired definitions stay published for run and audit history but are never the latest version, so nothing active
// may point at them: a link would open "not found", a playbook step or schedule would fail at run time.
// The Microsoft Defender portal (incidents, alerts, advanced hunting, Secure Score, device vulnerabilities) is out of
// AdminForge's scope since 2026-10-17 (docs/licensing-review.md); its content is retired. To bring it back, set those
// definitions to `status: active` with a version bump and change the second test here.

const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
const active = definitions.filter((d) => d.def.status !== 'retired');
const retired = new Set(definitions.filter((d) => d.def.status === 'retired').map((d) => d.def.id));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('retired content', () => {
  it('nothing active links to, embeds, runs or schedules a retired definition', () => {
    const found: string[] = [];
    for (const d of active) {
      const text = JSON.stringify(d.def);
      for (const id of retired) {
        const key = escape(id);
        // A link (/p/<id>, /playbooks/<id>) or any whole string value naming it: page, playbook, ref, a schedule's
        // `refs`, a probeStatus `probes` list, …
        const uses = new RegExp(`/(?:p|playbooks)/${key}(?![\\w.-])|[[,:]"${key}"`);
        if (uses.test(text)) found.push(`${d.file} → ${id}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('no active definition reads the Microsoft Defender portal', () => {
    const defender =
      /\/security\/(incidents|alerts_v2|alerts|runHuntingQuery|secureScores|secureScoreControlProfiles)\b|\b(SecurityIncident|SecurityAlert|SecurityEvents|ThreatHunting)\.(Read|ReadWrite)\.All\b|"source":"advancedHunting"|"licences":\[[^\]]*"(defender|defenderEndpoint)"/;
    expect(active.filter((d) => defender.test(JSON.stringify(d.def))).map((d) => d.file)).toEqual([]);
  });
});
