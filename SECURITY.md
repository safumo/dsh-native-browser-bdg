# Security

`deepseek-native-browser` starts a loopback-only browser debugging endpoint and
registers tools that can execute arbitrary JavaScript in the Sidebar browser.
Treat it as a local debugging capability.

- Do not expose the CDP port to a network or a shared host.
- Do not store secrets in persistent userscripts; `browser-cdp-scripts.json` is
  plain JSON.
- `allowPageTargets` is off by default so the DSH UI page cannot be driven.
- Report vulnerabilities privately to the repository owner rather than in a
  public issue.
