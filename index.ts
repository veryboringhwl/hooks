// @deno-types="./mixins.ts"
import mixin, { applyTransforms } from "./mixins.js";
// @deno-types="./module.ts"
import {
  enableAllLoadable,
  enableAllLoadableMixins,
  INTERNAL_MIXIN_LOADER,
  INTERNAL_TRANSFORMER,
  loadLocalModules,
  loadRemoteModules,
} from "./module.js";

await Promise.all([mixin(INTERNAL_TRANSFORMER), loadLocalModules()]);
console.time("onSpotifyPreInit");
await enableAllLoadableMixins();
console.timeEnd("onSpotifyPreInit");

console.time("onSpotifyInit");
const [modulesPath, snapshotPath] = await Promise.all([
  applyTransforms("/xpui-modules.js"),
  applyTransforms("/xpui-snapshot.js"),
]);

// must load modules before snapshot
await import(modulesPath);
await import(snapshotPath);
console.timeEnd("onSpotifyInit");

console.time("onSpotifyPostInit");
await Promise.all(INTERNAL_MIXIN_LOADER.awaitedMixins);
await enableAllLoadable();
console.timeEnd("onSpotifyPostInit");
requestIdleCallback(loadRemoteModules);
