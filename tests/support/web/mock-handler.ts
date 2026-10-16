/**
 * The contract of the mock portal API: a `MockHandler` looks at one request (`MockRequest`) and either answers it
 * (`MockReply`) or returns undefined to let the next handler try. Handlers are transport-free, so the same feature
 * mocks (mock-automation.ts, mock-reports.ts) serve both the Playwright specs — wired into `page.route` by
 * tests/e2e/support/mock-api.ts — and the component tests, whose fake `fetch` calls them directly
 * (tests/component/web/automation/render.tsx, component/reports).
 */

/** What a handler answers with: JSON (`body`), or raw `text` with its content type (SSE, CSS). */
export interface MockReply {
  status?: number;
  body?: unknown;
  text?: string;
  contentType?: string;
}

export interface MockRequest {
  method: string;
  path: string;
  url: URL;
  body: unknown;
  /** The X-AdminForge-CSRF header, when sent. */
  csrf?: string | null;
}

/** Feature mocks plug in here; the first handler that answers wins, before the defaults. */
export type MockHandler = (req: MockRequest) => MockReply | undefined;
