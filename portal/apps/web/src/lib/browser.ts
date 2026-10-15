/** Full-page navigations (sign-in, step-up, sign-out). One seam so tests can observe them. */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
