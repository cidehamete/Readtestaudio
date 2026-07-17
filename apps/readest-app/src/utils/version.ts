import packageJson from '../../package.json';

export const getAppVersion = () => {
  return packageJson.version;
};

/** Short git SHA of the deployed build (baked in at build time on Vercel).
 *  Empty for local dev builds. */
export const getBuildSha = () => {
  return process.env['NEXT_PUBLIC_BUILD_SHA'] ?? '';
};
