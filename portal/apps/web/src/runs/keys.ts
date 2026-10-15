/** My active runs; the dock and the runs page share this query (and every "run started" invalidates it). */
export const activeRunsQueryKey = ['runs', 'active'] as const;
