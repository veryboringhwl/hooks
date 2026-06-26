# Hooks

Runtime hooks injected into Spotify's desktop client. Handles module loading,
CSS/JS transforms, mixins, and the protocol handler.

## Build

```sh
bunx tsgo
```

Compiled output is written to `%LOCALAPPDATA%\Spicetify\hooks\`.

## Structure

```
hooks/
  index.ts          # Entry point — module initialization and Spotify lifecycle hooks
  module.ts         # Module loading engine (local + remote modules)
  mixins.ts         # Mixin support — CSS and JS injection
  transform.ts      # Transform engine — modify Spotify's shipped resources
  static.ts         # Static asset serving
  protocol.ts       # spicetify:// protocol handler
  util.ts           # Shared utilities
  std/              # Standard library
    assert.ts
    cache.ts
    collections.ts
    regexp.ts
    semver.ts
    text.ts
  util/             # Utility modules
    fetch.ts
    proxy.ts
    transition.ts
    type.ts
```

## Prerequisites

- [Bun](https://bun.sh/) (for `tsgo` — the native TypeScript compiler)

## License

GPLv3
