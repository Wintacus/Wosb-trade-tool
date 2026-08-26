/**
 * Values baked in at build time by vite.config.ts.
 *
 * `__BUILD_SHA__` is the short commit the running bundle was built from, or
 * "local" for a build outside Vercel. `__BUILD_TIME__` is when it was built.
 * Both are shown in the footer so the version on screen is never a guess.
 *
 * `declare global` rather than a bare `declare const`: this project sets
 * `moduleDetection: "force"`, which makes every file a module, so a top-level
 * declaration would be scoped to this file and invisible everywhere else.
 */
export {};

declare global {
  const __BUILD_SHA__: string;
  const __BUILD_TIME__: string;
}
