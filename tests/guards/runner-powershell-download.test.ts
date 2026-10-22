import { readText } from '../lib/repo';

// The runner's PowerShell is Microsoft's release archive, not a base image (MCR's PowerShell images are no longer
// rebuilt): the build downloads it and checks it against the SHA-256 the release publishes before unpacking it, so a
// replaced or damaged archive fails the build instead of reaching the container that holds engineers' forwarded
// Exchange and SharePoint tokens. Version and hash are ARGs of the stage that downloads — a reviewed bump: Dependabot
// doesn't read them (portal/apps/runner/README.md → Container image). The rules below also keep anything else from
// putting a pwsh in the image, and the supervisor from starting any pwsh but the checked one.
const FILE = 'portal/apps/runner/Dockerfile';
const RELEASE =
  'https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz';
const INSTALL = '/opt/microsoft/powershell/7';
// Checked before use: an override can name another release, not another repository or a check line of its own.
const VERSION_CHECK = `case "\${POWERSHELL_VERSION}" in ''|*[!0-9.]*)`;
const HASH_CHECK = `printf '%s' "\${POWERSHELL_SHA256}" | grep -Eqx '[0-9a-f]{64}'`;
// printf, not echo: dash's echo acts on a backslash escape (\c) inside the hash.
const CHECK = /^printf '%s {2}%s\\n' "\$\{POWERSHELL_SHA256\}" (\S+) \| sha256sum (?:--check|-c) --strict -$/;

interface Instruction {
  op: string;
  args: string;
  stage: string;
}

/** Instructions in order, comment lines dropped and continuations joined, each with the stage it belongs to. */
function instructions(text: string): Instruction[] {
  const joined = text
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\[ \t]*\r?\n/g, ' ');
  const out: Instruction[] = [];
  let stage = '';
  let n = 0;
  for (const line of joined.split('\n').map((l) => l.trim())) {
    const m = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const op = m[1]!.toUpperCase();
    if (op === 'FROM') stage = /\s+AS\s+(\S+)\s*$/i.exec(m[2]!)?.[1]?.toLowerCase() ?? String(n++);
    out.push({ op, args: m[2]!, stage });
  }
  return out;
}

/** What is wrong with how the Dockerfile gets PowerShell; empty when the download is pinned and checked. */
function problems(dockerfile: string): string[] {
  const list = instructions(dockerfile);
  const found: string[] = [];

  // Heredocs hide instructions from a line-by-line reading: none at all.
  if (list.some((i) => /<</.test(i.args)))
    found.push('a heredoc (<<): write each instruction on its own lines');

  // Anything fetched over the network outside apt and the PowerShell Gallery must be the checked archive.
  const fetches = list.filter(
    (i) =>
      (i.op === 'RUN' && /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/.test(i.args)) ||
      (i.op === 'ADD' && /\b(https?|git|ssh):\/\/|@[\w.-]+:/.test(i.args)),
  );
  if (fetches.length !== 1 || fetches[0]!.op !== 'RUN')
    return [
      ...found,
      `expected one RUN that downloads the PowerShell archive, found ${fetches.length} fetches`,
    ];
  const run = fetches[0]!;
  if (!run.args.includes(`"${RELEASE}"`)) found.push(`the download is not ${RELEASE} (quoted)`);

  // The stage declares a stable version and a full SHA-256, and nothing overrides them with ENV.
  const args = new Map(
    list
      .filter((i) => i.op === 'ARG' && i.stage === run.stage)
      .map((i) => i.args.split('=', 2) as [string, string | undefined]),
  );
  if (!/^\d+\.\d+\.\d+$/.test(args.get('POWERSHELL_VERSION') ?? ''))
    found.push('ARG POWERSHELL_VERSION=<major.minor.patch> (a stable release) is missing from the stage');
  if (!/^[0-9a-f]{64}$/.test(args.get('POWERSHELL_SHA256') ?? ''))
    found.push('ARG POWERSHELL_SHA256=<64 lower-case hex> is missing from the stage');
  if (list.some((i) => i.op === 'ENV' && /\bPOWERSHELL_(VERSION|SHA256)\b/.test(i.args)))
    found.push('ENV POWERSHELL_VERSION / POWERSHELL_SHA256 would override the reviewed ARGs');

  // check the ARGs && download && check the archive && unpack: a failed step stops the RUN before anything unpacks.
  const steps = run.args.split('&&').map((s) => s.trim());
  const download = steps.findIndex((s) => s.includes(RELEASE));
  const file = /(?:^|\s)(?:--output|-o)\s+(\S+)/.exec(steps[download] ?? '')?.[1];
  if (!file) return [...found, 'the download names no --output file'];
  const before = steps.slice(0, download);
  if (!before.some((s) => s.startsWith(VERSION_CHECK)))
    found.push(`POWERSHELL_VERSION is not checked before the download (${VERSION_CHECK} … exit 1 ;; esac)`);
  if (!before.includes(HASH_CHECK))
    found.push(`POWERSHELL_SHA256 is not checked before the download (${HASH_CHECK})`);
  const check = steps.findIndex((s) => /\bsha256sum\b/.test(s));
  if (check < 0) return [...found, 'no sha256sum check in the download RUN'];
  const checked = CHECK.exec(steps[check]!);
  if (!checked)
    found.push(
      `the check is exactly: printf '%s  %s\\n' "\${POWERSHELL_SHA256}" ${file} | sha256sum --check --strict -`,
    );
  else if (checked[1] !== file) found.push(`the check reads ${checked[1]}, not the downloaded ${file}`);
  const tars = steps.filter((s) => /^tar\b/.test(s));
  const unpack = steps.findIndex(
    (s) => /^tar\s+-?[a-z]*x/.test(s) && s.includes(` ${file} `) && s.includes(`-C ${INSTALL}`),
  );
  if (tars.length !== 1 || unpack < 0) found.push(`one tar -x of ${file} into ${INSTALL}, and no other`);
  else if (!(download < check && check < unpack)) found.push('the order must be download, check, unpack');
  for (const step of steps.slice(download, Math.max(unpack, check) + 1))
    if (/;|\||&|^!|\bset\s+\+e\b/.test(step.replace(CHECK, '')))
      found.push(`"${step}" can carry on past a failed step`);
  steps.forEach((step, i) => {
    if (/\/opt\/microsoft|\/pwsh\b/.test(step) && !(i > check && /^(mkdir -p|tar|chmod)\s/.test(step)))
      found.push(`"${step}" writes the PowerShell install outside the checked unpack`);
  });

  // The PowerShell that runs is the one checked: copied from that stage, nothing else writes it, and the supervisor
  // starts exactly that binary (PWSH_PATH) — not one found on PATH or in its writable HOME.
  const stages = new Set(list.filter((i) => i.op === 'FROM').map((i) => i.stage));
  const allowed = new Set([
    `COPY --from=${run.stage} ${INSTALL} ${INSTALL}`,
    `RUN ln -s ${INSTALL}/pwsh /usr/bin/pwsh`,
  ]);
  if (!list.some((i) => `${i.op} ${i.args}` === `COPY --from=${run.stage} ${INSTALL} ${INSTALL}`))
    found.push(`no COPY --from=${run.stage} ${INSTALL} ${INSTALL}`);
  for (const i of list) {
    const from = i.op === 'COPY' ? /--from=(\S+)/.exec(i.args)?.[1] : undefined;
    if (from && !stages.has(from.toLowerCase()))
      found.push(`COPY --from=${from}: only an earlier stage of this file`);
    if (i === run || !['RUN', 'COPY', 'ADD'].includes(i.op)) continue;
    if (/\/opt\/microsoft|\/pwsh\b/.test(i.args) && !allowed.has(`${i.op} ${i.args}`))
      found.push(`${i.op} ${i.args} — only the checked install may put PowerShell in the image`);
    if (
      /\b(apt|apt-get|aptitude)\s+install\b[^&;|]*\bpowershell|\bdpkg\s+(-i|--install)\b|\bsnap\s+install\b/.test(
        i.args,
      )
    )
      found.push(`${i.op} ${i.args} — PowerShell from a package as well`);
  }
  if (list.some((i) => i.op === 'FROM' && /\bmcr\.microsoft\.com\/powershell\b/i.test(i.args)))
    found.push('an MCR PowerShell image is a base again');
  const last = list.at(-1)?.stage;
  const env = list
    .filter((i) => i.op === 'ENV' && i.stage === last)
    .map((i) => i.args)
    .join(' ');
  if (!new RegExp(`(^|\\s)PWSH_PATH=${INSTALL}/pwsh(\\s|$)`).test(env))
    found.push(`the runtime stage sets ENV PWSH_PATH=${INSTALL}/pwsh`);
  return found;
}

describe("the runner's PowerShell download is checksum-verified", () => {
  it(`${FILE}: the pinned archive is checked against its SHA-256 before it is unpacked`, () => {
    const text = readText(FILE);
    expect(text, FILE).toBeDefined();
    expect(problems(text!)).toEqual([]);
  });

  // A minimal Dockerfile the rules accept, and the ways each rule catches a break (the guard checks itself).
  const good = [
    'FROM ubuntu:24.04@sha256:' + 'a'.repeat(64) + ' AS os',
    'FROM os AS powershell',
    'ARG POWERSHELL_VERSION=7.6.7',
    `ARG POWERSHELL_SHA256=${'b'.repeat(64)}`,
    `RUN ${VERSION_CHECK} exit 1 ;; esac \\`,
    ` && ${HASH_CHECK} \\`,
    ' && apt-get update && apt-get install -y curl \\',
    ` && curl -fsSL --output /tmp/p.tgz "${RELEASE}" \\`,
    ' && printf \'%s  %s\\n\' "${POWERSHELL_SHA256}" /tmp/p.tgz | sha256sum --check --strict - \\',
    ` && mkdir -p ${INSTALL} \\`,
    ` && tar -xzf /tmp/p.tgz -C ${INSTALL} --no-same-owner \\`,
    ' && chmod -R go-w,a-s /opt/microsoft/powershell',
    'FROM os AS runtime',
    `COPY --from=powershell ${INSTALL} ${INSTALL}`,
    `RUN ln -s ${INSTALL}/pwsh /usr/bin/pwsh`,
    `ENV LANG=en_US.UTF-8 PWSH_PATH=${INSTALL}/pwsh`,
  ].join('\n');
  const broken = (from: string | RegExp, to: string) => problems(good.replace(from, to));
  const check = 'printf \'%s  %s\\n\' "${POWERSHELL_SHA256}" /tmp/p.tgz | sha256sum --check --strict -';

  it('accepts the minimal pattern', () => {
    expect(problems(good)).toEqual([]);
  });

  it.each<[string, string | RegExp, string]>([
    ['no check at all', / && printf '%s {2}[^\n]*sha256sum[^\n]*\n/, ''],
    [
      'the check after the unpack',
      /( && printf '%s {2}[^\n]*)\\\n( && mkdir [^\n]*)\\\n( && tar [^\n]*)/,
      '$2\\\n$3\\\n$1',
    ],
    ['a failed check ignored', '--strict - \\', '--strict - || true \\'],
    ['a check sent to the background', '--strict - \\', '--strict - & true \\'],
    ['a check whose status is lost', '--strict - \\', '--strict - | cat \\'],
    ['a check inverted', check, `! ${check}`],
    ['a check of another list', check, 'printf x >/dev/null | sha256sum --check /tmp/self.sha'],
    [
      'echo, which acts on \\c in the hash',
      check,
      'echo "${POWERSHELL_SHA256}  /tmp/p.tgz" | sha256sum --check --strict -',
    ],
    ['steps joined with ;', " && printf '%s  %s", " ; printf '%s  %s"],
    ['a hash written in the RUN', '"${POWERSHELL_SHA256}" /tmp/p.tgz', `"${'c'.repeat(64)}" /tmp/p.tgz`],
    ['another file checked', '"${POWERSHELL_SHA256}" /tmp/p.tgz', '"${POWERSHELL_SHA256}" /tmp/other'],
    ['the version not checked', `RUN ${VERSION_CHECK} exit 1 ;; esac \\\n && `, 'RUN '],
    ['the hash not checked', `\n && ${HASH_CHECK} \\`, ''],
    ['a preview version', 'POWERSHELL_VERSION=7.6.7', 'POWERSHELL_VERSION=7.7.0-preview.5'],
    ['a short hash', `POWERSHELL_SHA256=${'b'.repeat(64)}`, 'POWERSHELL_SHA256=abc'],
    [
      'the hash overridden by ENV',
      'FROM os AS runtime',
      `FROM os AS runtime\nENV POWERSHELL_SHA256=${'d'.repeat(64)}`,
    ],
    ['a second download', 'FROM os AS runtime', 'FROM os AS runtime\nADD https://example.com/x /x'],
    [
      'a download in a heredoc',
      'FROM os AS runtime',
      'FROM os AS runtime\nRUN <<EOT\ncurl -o /usr/local/bin/pwsh https://example.com/x\nEOT',
    ],
    ['an http URL', 'https://github.com/PowerShell', 'http://github.com/PowerShell'],
    ['a second tar in the RUN', ' && chmod -R', ` && tar -xzf /tmp/q.tgz -C ${INSTALL} \\\n && chmod -R`],
    [
      'a copy over the checked install',
      `RUN ln -s`,
      `COPY pwsh.tgz /tmp/\nRUN tar -xzf /tmp/pwsh.tgz -C ${INSTALL}\nRUN ln -s`,
    ],
    [
      'PowerShell copied from an image',
      `RUN ln -s`,
      `COPY --from=mcr.microsoft.com/powershell:7.5-ubuntu-24.04 ${INSTALL} ${INSTALL}\nRUN ln -s`,
    ],
    [
      'PowerShell from MCR',
      'FROM os AS runtime',
      'FROM mcr.microsoft.com/powershell:7.5-ubuntu-24.04 AS runtime',
    ],
    ['PowerShell from apt', 'RUN ln -s', 'RUN apt install -y powershell\nRUN ln -s'],
    ['PowerShell from a .deb', 'RUN ln -s', 'RUN dpkg -i /tmp/powershell.deb\nRUN ln -s'],
    ['the runtime not copying the checked install', '--from=powershell', '--from=os'],
    ['the supervisor finding pwsh on PATH', ` PWSH_PATH=${INSTALL}/pwsh`, ''],
  ])('refuses %s', (_label, from, to) => {
    expect(good.replace(from, to), 'the sample changed').not.toBe(good);
    expect(broken(from, to)).not.toEqual([]);
  });
});
