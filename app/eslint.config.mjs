import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// react-hooks v6 arrived with the Next 16 upgrade and promoted a family of rules
// from advisory to error, flagging 32 real patterns. They ran as warnings for one
// commit so `npm run lint` could gate everything else; all five are now at zero
// and back at their default severity, so there is no override block here.
//
// What they were, and what fixing them found:
//   purity                       Math.random() during render re-rolled the fleet
//                                animation timings on every unrelated re-render.
//   refs                         a ref read during render duplicated a piece of
//                                state the renderer could already see.
//   set-state-in-effect          25 sites. The fix is an async IIFE: the body
//                                runs synchronously to its first await, so the
//                                updates keep their tick and their order and
//                                merely leave the effect's own path.
//   exhaustive-deps              two pollers depended on a derived key while
//                                closing over the array it came from, so a prime
//                                swapped for another with the same count kept
//                                being polled at its old id.
//   preserve-manual-memoization  a `?? []` fallback built a new array each
//                                render, defeating the useCallbacks below it.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
