// Live scripts print statuses and codes; any message text they show passes through `mask` first, so object ids and
// addresses (UPNs, mailboxes) from the tenant never reach the terminal or a log.

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ADDRESS = /[^\s@<>"',;]+@[^\s@<>"',;]+\.[A-Za-z]{2,}/g;

/** `text` with GUIDs as `<id>` and e-mail addresses / UPNs as `<address>`. */
export const mask = (text: string): string => text.replace(GUID, '<id>').replace(ADDRESS, '<address>');
