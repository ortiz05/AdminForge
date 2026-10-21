import { createGraphNotifier, type ServiceCall } from '@adminforge/engine';
import { APPROVER, FakeOutbound } from './helpers';

// S-31: a notify step's Teams chat target (a user id or UPN) is bound into `users('…')` of the new chat's members. The
// target went through encodeURIComponent alone, which leaves `'` as it is, so a target with an apostrophe closed the
// OData string literal early and could append to the reference. It is percent-encoded and then an OData string literal
// (`'` doubled) now. The chat call says it binds chat members (S-15 lets those be UPNs; nothing else may).

const identity = { actor: APPROVER, mode: 'write' as const, handle: null };
const opts = { correlationId: 'c', signal: new AbortController().signal };

async function bindings(target: string): Promise<string[]> {
  const out = new FakeOutbound((c: ServiceCall) =>
    c.path === '/chats' ? { id: '19:new@unq.gbl.spaces' } : null,
  );
  await createGraphNotifier(out).send(identity, { channel: 'teamsChat', to: [target], message: 'hi' }, opts);
  const chat = out.calls.find((c) => c.call.path === '/chats')!;
  return (chat.call.body as { members: Array<Record<string, string>> }).members.map(
    (m) => m['user@odata.bind']!,
  );
}

describe('Teams chat member binding', () => {
  it("doubles an apostrophe in a UPN, so the literal can't be closed early", async () => {
    expect(await bindings("o'brien@example.com")).toEqual([
      `https://graph.microsoft.com/v1.0/users('${APPROVER.oid}')`,
      "https://graph.microsoft.com/v1.0/users('o''brien%40example.com')",
    ]);
  });

  it('an attempt to append to the reference stays inside the literal', async () => {
    const [, bound] = await bindings("x')/manager/$ref?('");
    expect(bound).toBe("https://graph.microsoft.com/v1.0/users('x'')%2Fmanager%2F%24ref%3F(''')");
  });

  it("keeps a guest's #EXT# inside the reference", async () => {
    const [, bound] = await bindings('guest_example.org#EXT#@example.onmicrosoft.com');
    expect(bound).toBe(
      "https://graph.microsoft.com/v1.0/users('guest_example.org%23EXT%23%40example.onmicrosoft.com')",
    );
  });

  it('marks the chat it opens as binding chat members, and nothing else', async () => {
    const out = new FakeOutbound((c: ServiceCall) =>
      c.path === '/chats' ? { id: '19:new@unq.gbl.spaces' } : null,
    );
    await createGraphNotifier(out).send(
      identity,
      { channel: 'teamsChat', to: ['b@example.com'], message: 'hi' },
      opts,
    );
    expect(out.calls.map((c) => [c.call.path, c.call.chatMembers])).toEqual([
      ['/chats', true],
      ['/chats/19%3Anew%40unq.gbl.spaces/messages', undefined],
    ]);
  });

  it('binds a user id unchanged', async () => {
    const id = '00000000-0000-4000-8000-000000000123';
    expect((await bindings(id))[1]).toBe(`https://graph.microsoft.com/v1.0/users('${id}')`);
  });
});
