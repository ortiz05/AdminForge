import { PageHeader, tv } from '@adminforge/ui';
import {
  ButtonsSection,
  ChartsSection,
  ColourSection,
  DataDisplaySection,
  FeedbackSection,
  FormsSection,
  IdentitySection,
  NavigationSection,
  OverlaysSection,
  StatusSection,
  TablesSection,
} from './sections';

const SECTIONS = [
  { id: 'identity', label: 'Identity & type', render: IdentitySection },
  { id: 'colour', label: 'Colour', render: ColourSection },
  { id: 'buttons', label: 'Buttons', render: ButtonsSection },
  { id: 'status', label: 'Status & identifiers', render: StatusSection },
  { id: 'data-display', label: 'Data display', render: DataDisplaySection },
  { id: 'forms', label: 'Forms', render: FormsSection },
  { id: 'overlays', label: 'Overlays', render: OverlaysSection },
  { id: 'navigation', label: 'Navigation', render: NavigationSection },
  { id: 'feedback', label: 'Feedback', render: FeedbackSection },
  { id: 'tables', label: 'Data table', render: TablesSection },
  { id: 'charts', label: 'Charts', render: ChartsSection },
] as const;

const toc = tv({
  slots: {
    nav: 'sticky top-(--af-layout-rail-h) z-(--af-z-sticky) -mx-8 mb-6 border-b border-line bg-canvas/90 px-8 py-2.5 backdrop-blur-xs',
    list: 'flex flex-wrap gap-1',
    link: 'inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-fg-3 hover:bg-hover hover:text-fg',
  },
});

/** Every primitive in every state, in the current theme and density — the page reviewed at each gate. */
export function DesignPage() {
  const s = toc();
  return (
    <>
      <PageHeader
        eyebrow="AdminForge"
        title="Design system"
        description="Every primitive in every state, drawn from the design tokens. Switch theme and density from your account menu to review them all."
      />
      <nav aria-label="Design system sections" className={s.nav()}>
        <ul className={s.list()}>
          {SECTIONS.map((sec) => (
            <li key={sec.id}>
              <a href={`#${sec.id}`} className={s.link()}>
                {sec.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-col gap-10">
        {SECTIONS.map(({ id, label, render: Section }) => (
          <section key={id} id={id} aria-labelledby={`${id}-title`} className="scroll-mt-28">
            <h2 id={`${id}-title`} className="af-display mb-4 text-xl font-semibold text-fg">
              {label}
            </h2>
            <Section />
          </section>
        ))}
      </div>
    </>
  );
}
