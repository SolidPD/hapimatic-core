# Hapimatic

**Hapimatic** is a local-first way to reach your Claude Code sessions from anywhere — a web/PWA
client plus a server you run on your own machine. This repository holds the **open-core** of
Hapimatic, released under the GNU Affero General Public License v3.0.

> Hapimatic is not affiliated with [tiann/hapi](https://github.com/tiann/hapi) or hapi.dev.

## What's in this repository

This is the AGPL-3.0 open core — the `hapi` command-line tool and the local-first server and web
client that let you run and resume Claude Code sessions from a browser or installed PWA.

**What is open core (in this repo):** the CLI, the session server, and the web/PWA client.

**What is not in this repo:** the hosted onboarding gateway, managed hosting, single sign-on, and
premium plugins are separate and are not part of this AGPL-3.0 core. Everything you need to build
and run Hapimatic yourself from source _is_ here.

## Build from source

Hapimatic builds from this repository alone, with no private dependency, token, or network
credential:

```bash
bun install --frozen-lockfile
bun run build:single-exe
```

The resulting single-file `hapi` executable is written under `cli/dist-exe/`.

## License

Hapimatic is licensed under the **GNU Affero General Public License v3.0** — see
[`LICENSE`](LICENSE). It is a fork of [tiann/hapi](https://github.com/tiann/hapi), which is itself
AGPL-3.0. The `cli` package additionally contains code derived from the MIT-licensed
[happy-cli](https://github.com/slopus/happy-cli) (© 2024 Kirill Dubovitskiy); that attribution is
carried in [`cli/NOTICE`](cli/NOTICE). Project-level attribution is in [`NOTICE`](NOTICE).

Under AGPL-3.0 §13, the complete, corresponding source for every released build is published here
and tagged `v<VERSION>` before or with that build.

## Contributing

Contributions are welcome under a Contributor License Agreement — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). This repository is a generated export; changes are reviewed
here and then integrated into the canonical source tree, so they appear in the next release export.

## Security

To report a vulnerability, see [`SECURITY.md`](SECURITY.md). Please do not open a public issue for
security reports.
