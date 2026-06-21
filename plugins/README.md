# `plugins/` — external plug-in drop-in directory

OmniVoice Manager loads external plug-ins from this directory. It's a **drop-in
folder**: the host discovers any subfolder that contains a valid `plugin.json`,
regardless of how it got there.

Only two things are tracked in the core repo here:

- **`_sdk/`** — the pure-stdlib plug-in SDK the host injects onto each sidecar's
  `PYTHONPATH` (`from omnivoice_plugin import run`). This is the host contract;
  plug-ins do **not** bundle it.
- **`README.md`** — this file.

Everything else in `plugins/` is **git-ignored**. Installed plug-ins live in their
own repositories (with their own licenses) and stay untracked here, as do the
isolated `.venv` environments each one builds.

## Installing a plug-in

```bash
# From the app (clone + build the sidecar env):
omnivoice-plugin install <git-url> [--name <folder>] [--no-bootstrap]

# …or from the running manager:
curl -X POST http://localhost:8200/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"git_url":"<git-url>","bootstrap":true}'

# …or by hand:
cd plugins && git clone <git-url> <name> && cd <name> && ./bootstrap.sh
```

A plain copy or a platform installer that lays a correctly-shaped folder in here
works too — discovery doesn't care how the files arrived.

## Plug-in package shape

```
plugins/<name>/
  plugin.json      # manifest (required): identity, isolation, capabilities, needs, ui
  sidecar.py       # entrypoint (required for sidecar plug-ins)
  bootstrap.sh     # builds the isolated .venv (referenced by needs.bootstrap)
  …                # any plug-in-private helpers / assets
  .venv/           # built locally by bootstrap — never committed
```

See [`docs/plugins.md`](../docs/plugins.md) for the full authoring guide, the
manifest schema, the host hooks, and the wire protocol.

## Reference plug-in

**Stable Audio 3** (text-to-audio foley/SFX/music/instrument) is maintained as a
standalone example plug-in:
<https://github.com/SanDiegoDude/omnivoice-manager-plugin-stable-audio-3>
