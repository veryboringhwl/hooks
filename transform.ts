import type { MixinLoader } from "./module.ts";

// @deno-types="./util/fetch.ts"
import { fetchText } from "./util/fetch.js";

const MimeTypes = {
  ".js": "application/javascript",
  ".css": "text/css",
} as const;

export class SourceFile {
  objectURL?: string;
  transforms = [] as ((input: string) => string)[];

  static SOURCES = new Map<string, SourceFile>();

  private constructor(private path: string) {}

  static from(path: string) {
    return SourceFile.SOURCES.get(path) ?? new SourceFile(path);
  }

  async getObjectURL() {
    if (this.objectURL) return this.objectURL;
    const trs = transforms.filter(([glob]) => glob.test(this.path));
    if (!trs.length) {
      return this.path;
    }
    const content = await fetchText(this.path);
    if (content == null) {
      throw new Error(`Failed to fetch transform source: ${this.path}`);
    }
    const modifiedContent = trs.reduce((p, [, transform]) => transform(p, this.path), content);
    const ext = this.path.slice(this.path.lastIndexOf("."));
    // @ts-expect-error
    const type: string | undefined = MimeTypes[ext];
    if (!type) {
      return this.path;
    }
    const withSourceURL =
      ext === ".js"
        ? `${modifiedContent}\n//# sourceURL=${new URL(this.path, location.origin).href}`
        : modifiedContent;
    const blob = new Blob([withSourceURL], { type });
    this.objectURL = URL.createObjectURL(blob);
    return this.objectURL;
  }
}

export type Thunk<A> = (value: A) => void;

export type MixinProps = {
  glob?: RegExp;
  wait?: boolean;
};

export type Transformer = ReturnType<typeof createTransformer>;

export const createTransformer =
  (module: MixinLoader) =>
  <A = void>(
    transform: (emit: Thunk<A>) => (input: string, path: string) => string,
    { glob = /(?:)/, wait = true }: MixinProps,
  ) => {
    const { promise, resolve } = Promise.withResolvers<A>();

    transforms.push([glob, transform(resolve)]);

    // @ts-expect-error
    promise.transform = transform;

    if (wait) {
      module.awaitedMixins.push(promise as Promise<void>);
    }

    return promise;
  };

export const transforms: [RegExp, (input: string, path: string) => string][] = [];
