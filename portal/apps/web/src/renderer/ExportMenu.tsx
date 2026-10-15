import { useState } from 'react';
import type { ExportSpec } from '@adminforge/schemas';
import {
  Button,
  CaretDownIcon,
  DownloadSimpleIcon,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  useToast,
} from '@adminforge/ui';
import { ApiErrorBody } from '@adminforge/schemas';
import { CSRF_HEADER } from '../lib/api';
import { useMe } from '../lib/session';

const FORMAT_LABEL = { csv: 'CSV', xlsx: 'Excel workbook' } as const;
const EXT = { csv: 'csv', xlsx: 'xlsx' } as const;

export interface ExportRequestBody {
  params: Record<string, unknown>;
  format: 'csv' | 'xlsx';
  version?: string;
  columns?: string[];
}

/** "attachment; filename="users.csv"; filename*=UTF-8''users.csv" → users.csv */
export function fileNameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      /* fall through */
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1]?.trim();
}

/**
 * POST /api/reports/:key/export streams every row (all pages, server-side) as a file; the browser saves it.
 * Exports are audited by the BFF.
 */
export async function downloadExport(
  key: string,
  body: ExportRequestBody,
  csrf: string,
  fallbackName: string,
): Promise<string> {
  const res = await fetch(`/api/reports/${encodeURIComponent(key)}/export`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: '*/*', [CSRF_HEADER]: csrf },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `The server answered ${res.status}.`;
    let hint: string | undefined;
    try {
      const parsed = ApiErrorBody.safeParse(await res.json());
      if (parsed.success) {
        message = parsed.data.error.message;
        hint = parsed.data.error.hint;
      }
    } catch {
      /* not JSON */
    }
    throw new Error(hint ? `${message} ${hint}` : message);
  }
  const blob = await res.blob();
  const name = fileNameFrom(res.headers.get('content-disposition')) ?? `${fallbackName}.${EXT[body.format]}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export interface ExportMenuProps {
  pageKey: string;
  version: string;
  spec: ExportSpec;
  params: Record<string, unknown>;
  /** Visible columns of the exported table, when the spec says `columns: visible`. */
  columns?: string[];
  fallbackName: string;
  intent?: 'secondary' | 'primary';
  label?: string;
}

/** Export ▾ → CSV / Excel. Streams all rows server-side, not just the loaded ones. */
export function ExportMenu({
  pageKey,
  version,
  spec,
  params,
  columns,
  fallbackName,
  intent = 'secondary',
  label = 'Export',
}: ExportMenuProps) {
  const me = useMe();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (format: 'csv' | 'xlsx') => {
    setBusy(true);
    try {
      const name = await downloadExport(
        pageKey,
        { params, format, version, ...(spec.columns !== 'all' && columns?.length ? { columns } : {}) },
        me.csrf,
        fallbackName,
      );
      toast({
        tone: 'ok',
        title: `Exported ${name}`,
        description: 'All rows matching these filters. The export is recorded in the audit log.',
      });
    } catch (e) {
      toast({ tone: 'crit', title: 'The export didn’t complete', description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  if (spec.formats.length === 1)
    return (
      <Button intent={intent} pending={busy} onClick={() => void run(spec.formats[0]!)}>
        <DownloadSimpleIcon size={16} aria-hidden />
        {label} {FORMAT_LABEL[spec.formats[0]!]}
      </Button>
    );
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button intent={intent} pending={busy}>
          <DownloadSimpleIcon size={16} aria-hidden />
          {label}
          <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
        </Button>
      </MenuTrigger>
      <MenuContent className="w-60">
        <MenuLabel>All rows, as</MenuLabel>
        {spec.formats.map((f) => (
          <MenuItem
            key={f}
            icon={<DownloadSimpleIcon size={15} />}
            shortcut={`.${EXT[f]}`}
            onSelect={() => void run(f)}
          >
            {FORMAT_LABEL[f]}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
