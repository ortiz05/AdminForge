import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useCopy } from '../lib/hooks';

import { IconButton } from './IconButton';
import { codeBlock } from '../recipes/code-block';

export interface CodeBlockProps {
  code: string;
  /** Shown in the header bar, e.g. "KQL", "request.json". */
  title?: string;
  /** Language hint for assistive tech and future highlighting. */
  language?: string;
  wrap?: boolean;
  maxHeight?: number;
  className?: string;
}

/** Monospace block for KQL, JSON, PowerShell and logs, with a copy button. */
export function CodeBlock({ code: text, title, language, wrap, maxHeight, className }: CodeBlockProps) {
  const [copied, copy] = useCopy();
  const s = codeBlock({ wrap });
  const name = title ?? language ?? 'code';
  return (
    <div className={s.root({ className })}>
      <div className={s.bar()}>
        <span className={s.title()}>{name}</span>
        <IconButton
          size="sm"
          label={copied ? 'Copied' : `Copy ${name}`}
          icon={copied ? <CheckIcon size={14} weight="bold" className="text-ok" /> : <CopyIcon size={14} />}
          onClick={() => void copy(text)}
        />
      </div>
      <pre
        role="region"
        className={s.pre()}
        style={maxHeight ? { maxHeight } : undefined}
        tabIndex={0}
        aria-label={name}
      >
        <code data-language={language}>{text}</code>
      </pre>
    </div>
  );
}
