import { useId, type ComponentProps, type ReactNode } from 'react';
import { panel } from '../recipes/panel';

export type PanelProps = Omit<ComponentProps<'section'>, 'title'> & {
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  bodyClassName?: string;
};

/** The widget container: eyebrow + title + actions, body, footer (usually a ProvenanceFooter). */
export function Panel({
  eyebrow,
  title,
  description,
  actions,
  footer,
  flush,
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  const titleId = useId();
  const headless = !eyebrow && !title && !actions;
  const s = panel({ flush, headless });
  return (
    <section aria-labelledby={title ? titleId : undefined} {...rest} className={s.root({ className })}>
      {!headless && (
        <header className={s.header()}>
          <div className={s.heading()}>
            {eyebrow && <p className={s.eyebrow()}>{eyebrow}</p>}
            {title && (
              <h2 id={titleId} className={s.title()}>
                {title}
              </h2>
            )}
            {description && <p className={s.description()}>{description}</p>}
          </div>
          {actions && <div className={s.actions()}>{actions}</div>}
        </header>
      )}
      <div className={s.body({ className: bodyClassName })}>{children}</div>
      {footer && <footer className={s.footer()}>{footer}</footer>}
    </section>
  );
}
