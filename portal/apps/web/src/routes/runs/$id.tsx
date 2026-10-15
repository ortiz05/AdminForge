import { createFileRoute } from '@tanstack/react-router';
import { RunPage } from '../../runs/RunPage';

export const Route = createFileRoute('/runs/$id')({
  component: function RunRoute() {
    const { id } = Route.useParams();
    return <RunPage key={id} id={id} />;
  },
});
