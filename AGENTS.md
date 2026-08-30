# AGENTS.md

Fork of [`@daytona/opencode`](https://github.com/daytona/integrations/tree/main/packages/opencode-plugin) (Apache-2.0). Apply the correct header when creating or editing source files:

- **Modified file** — keep Daytona's line, add yours:
  ```js
  /**
   * Copyright Daytona Platforms Inc.
   * Copyright 2026 mickeiik (modifications)
   * SPDX-License-Identifier: Apache-2.0
   */
  ```
- **Unmodified file** — leave the header untouched.
- **New file** — only your own notice (`Copyright 2026 mickeiik` + `SPDX-License-Identifier: Apache-2.0`).

Never remove Daytona's copyright or `SPDX-License-Identifier` lines from files with upstream code. Keep `LICENSE`, `package.json`, and README "Credits & License" consistent. Package name is `opencode-remote-ssh-plugin` — no Daytona branding.

Keep `CHANGELOG.md` up to date: add an entry for every user-visible change to the plugin (code behavior, packaging, usage) under the current version section, or open a new `[x.y.z]` section, in the [Keep a Changelog](https://keepachangelog.com) style — categories: Added / Changed / Fixed / Removed. Skip internal housekeeping (formatting, licensing headers).
