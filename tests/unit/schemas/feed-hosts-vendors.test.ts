import { isCitationUrl, isFeedUrl } from '@adminforge/schemas';

// The vendor feed hosts (ADR-013 addendum, security review 2026-10-23): GitHub is a host anyone publishes on, so only a
// vendor's own repository's releases feed may be read (the path is code, not content); vendor citation links are their
// exact feed hosts — never a community sub-domain or a gist.
describe('vendor feed hosts', () => {
  it('reads the listed vendor feeds', () => {
    for (const url of [
      'https://status.claude.com/history.rss',
      'https://status.digicert.com/history.rss',
      'https://blogs.vmware.com/cloud-foundation/feed/',
      'https://www.hpe.com/us/en/newsroom/rss.xml',
      'https://openrouter.ai/blog/feed.xml',
      'https://blog.n8n.io/rss/',
      'https://github.com/anthropics/claude-code/releases.atom',
      'https://github.com/n8n-io/n8n/releases.atom',
    ])
      expect(isFeedUrl(url), url).toBe(true);
  });

  it('refuses any other GitHub path: another owner, a look-alike, commits, a query, a gist', () => {
    for (const url of [
      'https://github.com/anthropic/claude-code/releases.atom',
      'https://github.com/someone/n8n/releases.atom',
      'https://github.com/anthropics/claude-code/commits.atom',
      'https://github.com/anthropics/claude-code/releases.atom?x=1',
      'https://github.com/anthropics.atom',
      'https://gist.github.com/anthropics/claude-code/releases.atom',
      'https://status.anthropic.com/history.rss',
    ])
      expect(isFeedUrl(url), url).toBe(false);
  });

  it('cites vendor feed hosts exactly, and Microsoft domains with their sub-domains', () => {
    for (const url of [
      'https://github.com/anthropics/claude-code/releases/tag/v2.1.309',
      'https://blogs.vmware.com/security/2026/10/20/example/',
      'https://www.hpe.com/us/en/newsroom/example.html',
      'https://learn.microsoft.com/en-us/azure/virtual-desktop/whats-new',
    ])
      expect(isCitationUrl(url), url).toBe(true);
    for (const url of [
      'https://gist.github.com/someone/abc',
      'https://community.hpe.com/t5/example',
      'https://community.broadcom.com/example',
      'https://community.n8n.io/t/example',
      'https://www.anthropic.com/news/example',
      'https://www.digicert.com/blog/example',
    ])
      expect(isCitationUrl(url), url).toBe(false);
  });
});
