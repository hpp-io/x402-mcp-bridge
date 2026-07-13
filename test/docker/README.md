# Docker CLI smoke test

A clean-container, **post-release** smoke test: it installs the **published**
`@hpp-io/x402-mcp-bridge` via the public one-line installer
(`hpp-io/x402-tools`) and exercises every CLI command from the README, plus a
zero-config MCP-server boot.

Use it to verify a release is healthy for real users (fresh machine, no prior
config, real OS keychain via gnome-keyring).

## Run

```bash
cd test/docker
docker build -t hpp-x402-clitest .
docker run --rm hpp-x402-clitest
```

Exit code = number of failed checks (0 = all pass).

## What it covers (30 checks)

install · `--version` · wallet generate/address/balance/import/remove (real
keychain) · setup · fund · status · install cursor/windsurf/openclaw/claude(+
claude-code graceful) · discover browse/search (live) · policy · channel · safe
usage · serve (402 + healthz) · call (graceful error) · zero-config server boot.

## Notes / scope

- **Post-release, not pre-merge**: it installs the *latest published* package,
  not the local working tree. A pre-merge variant would `npm pack` the local
  build and install that tarball instead — follow-up.
- Network is required (live discovery + on-chain balance reads).
- On-chain / funded-key paths (real `call` payment, `safe setup/revoke`,
  `install claude-code` needing the `claude` CLI) are verified via their
  graceful error / usage paths, not full execution.
- No secrets: uses public addresses, a well-known anvil test key, and public
  endpoints only.
