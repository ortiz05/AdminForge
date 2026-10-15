// One lazy chunk per Phosphor glyph (Vite/Rolldown expand this glob at build time; nothing loads until asked).
// Kept in a .js file so the type of `import.meta.glob` doesn't depend on the consumer's Vite types.
export const iconModules = import.meta.glob('../../node_modules/@phosphor-icons/react/dist/csr/*.es.js');
