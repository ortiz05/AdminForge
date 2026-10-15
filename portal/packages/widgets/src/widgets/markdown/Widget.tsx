import { Panel, SkeletonText } from '@adminforge/ui';
import { useInterpolatedText } from '../../lib/text';
import type { WidgetProps } from '../../types';
import { Markdown } from './markdown';
import type { MarkdownConfig } from './schema';

/**
 * Guidance for the page: what it shows, what to do, links to runbooks. `text` may contain `${ … }` (page scope);
 * values from data are inserted as plain text (HTML bodies from Microsoft APIs are stripped, never rendered).
 */
export function MarkdownWidget({ config, runtime }: WidgetProps<MarkdownConfig>) {
  const { text, error } = useInterpolatedText(config.text, runtime.scope);
  return (
    <Panel title={config.title} description={config.description} aria-label={config.title ? undefined : 'About this page'}>
      {error ? (
        <p className="text-sm text-fg-3">This text couldn’t be filled in: {error.message}</p>
      ) : text === undefined ? (
        <SkeletonText lines={3} />
      ) : (
        <Markdown source={text} Link={runtime.Link} />
      )}
    </Panel>
  );
}
