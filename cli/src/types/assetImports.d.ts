// SPDX-License-Identifier: AGPL-3.0-only
declare module "*.cjs" {
  const path: string;
  export default path;
}

declare module "*.tar.gz" {
  const path: string;
  export default path;
}

declare module "*-LICENSE" {
  const path: string;
  export default path;
}
