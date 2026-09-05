/**
 * The single source of truth for the CLI's version.
 *
 * `__ROXY_VERSION__` is substituted by esbuild at build time from
 * package.json (see the `build` script), so a released binary can never
 * report a version that drifts from what was published. The fallback only
 * applies when running straight from source.
 */
declare const __ROXY_VERSION__: string | undefined

export const CLI_VERSION: string =
  typeof __ROXY_VERSION__ === 'string' ? __ROXY_VERSION__ : '0.0.0-dev'
