// @deno-types="./module.ts"
import { RootModule } from "./module.js";
// @deno-types="./protocol.ts"
import { handleProtocol } from "./protocol.js";
// @deno-types="./transform.ts"
import { SourceFile, type Transformer } from "./transform.js";

type CHUNKS = Record<string, PromiseWithResolvers<void>>;

declare global {
  var __applyTransforms: typeof applyTransforms;
  var __interceptNavigationControlMessage: typeof interceptNavigationControlMessage;
  var __onScriptLoaded: (path: string) => void;
  var CHUNKS: CHUNKS;
}

export const applyTransforms = (path: string) => {
  const source = SourceFile.from(path);
  console.debug("loadResource", source);
  return source.getObjectURL();
};
globalThis.__applyTransforms = applyTransforms;

const spotifyAppScheme = "spotify:app:";
function interceptNavigationControlMessage(e: Event): boolean {
  const uri: string = (e as any).data.data;
  if (!uri.startsWith(spotifyAppScheme)) {
    return false;
  }

  const url = new URL(uri.slice(spotifyAppScheme.length));
  if (url.protocol !== "rpc:") {
    return false;
  }

  if (url.pathname.startsWith("reload")) {
    const modules = url.searchParams.getAll("module");
    if (modules.length === 0) {
      document.location.reload();
    } else {
      (async () => {
        for (const identifier of modules) {
          const instance = RootModule.INSTANCE.getDescendant(identifier)?.getEnabledInstance();
          if (!instance) {
            continue;
          }

          if (await instance.unload()) {
            await instance.load();
          }
        }
      })();
    }
  } else if (url.pathname.startsWith("spicetify")) {
    handleProtocol(url.pathname);
  }

  return true;
}

globalThis.__interceptNavigationControlMessage = interceptNavigationControlMessage;

globalThis.CHUNKS = {};

export const CHUNKS: CHUNKS = globalThis.CHUNKS as CHUNKS;
globalThis.__onScriptLoaded = (path: string) => {
  CHUNKS[path] ??= Promise.withResolvers();
  setTimeout(CHUNKS[path].resolve);
};

export default async function (transformer: Transformer) {
  transformer(
    (emit) => (str) => {
      str = str.replace(
        /(=)(function\([\w$,]+\)\{)(?=(?:(?!function\()[\s\S])*?[\w$]+=Error\(\))/,
        "$1async $2",
      );

      str = str.replace(
        /(?<=[\w$]+=)([\w$.]+\+[\w$.]+\([^)]+\))(?=,[\w$]+=Error\(\))/,
        "await __applyTransforms($1)",
      );

      str = str.replace(
        /new Promise\(function(\([\w$,]+\)\{var [\w$]+=[\w$]+\.miniCssF\()/,
        "new Promise(async function$1",
      );

      str = str.replace(
        /(?<=\.miniCssF\([^)]+\),[\w$]+=)([\w$.]+\+[\w$]+)/,
        "await __applyTransforms($1)",
      );

      emit();
      return str;
    },
    {
      glob: /^\/xpui-snapshot\.js/,
    },
  );

  //  Fixes some components' displayNames not being available as they're forwarded by the React profiler.
  //  This patch assigns the displayName to the exported function, while still allowing the React profiler to function properly.
  transformer(
    (emit) => (str) => {
      emit();

      str = str.replace(
        /return (\w+)\.displayName=`profiler\(/,
        "$1.toString=arguments[0].toString.bind(arguments[0]);$&",
      );

      return str;
    },
    {
      glob: /^\/xpui-modules\.js/,
    },
  );

  // sentry works if spotif ver is <30 days so make it never
  transformer(
    (emit) => (str) => {
      str = str.replace("/864e5<30", "<0");
      emit();

      return str;
    },
    {
      glob: /^\/xpui-snapshot\.js/,
    },
  );

  // transformer(
  //   (emit) => (str) => {
  //     emit();

  //     str = str.replace(
  //       /("incognito-enabled":[a-zA-Z_\$][\w\$]*)/,
  //       '$1,employee:"1"',
  //     );
  //     str = str.replace(
  //       /([a-zA-Z_\$][\w\$]*)\("app\.enable-developer-mode",([a-zA-Z_\$][\w\$]*)\)/,
  //       '$1("app.enable-developer-mode",$2);$1("app-developer",$2?2:0)',
  //     );

  //     return str;
  //   },
  //   {
  //     glob: /^\/xpui\.js/,
  //   },
  // );

  transformer(
    (emit) => (str) => {
      emit();

      str = str.replace(
        /(([a-zA-Z_$][\w$]*)\.data\.type===(?:[a-zA-Z_$][\w$]*\.){2}NAVIGATION)\s*\?/,
        "$1&&!__interceptNavigationControlMessage($2)?",
      );

      return str;
    },
    {
      glob: /^\/xpui-snapshot\.js/,
    },
  );

  transformer(
    (emit) => (str, path) => {
      emit();

      str += `;\n__onScriptLoaded("${path}");`;

      return str;
    },
    {
      glob: /\.js$/,
      wait: false,
    },
  );
}
