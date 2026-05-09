// @ts-expect-error
const { Platform } = await import("/modules/stdlib/src/expose/Platform.js");

type TypeNode =
  | { kind: "primitive"; type: string }
  | { kind: "class"; name: string }
  | { kind: "reference"; id: string }
  | { kind: "union"; types: TypeNode[] };

interface PropertyDef {
  type: TypeNode;
  isOptional: boolean;
  isReadonly: boolean;
}

type StoreNode =
  | { kind: "array"; id: string; nameHints: string[]; elementType?: TypeNode }
  | { kind: "map"; id: string; nameHints: string[]; keyType?: TypeNode; valueType?: TypeNode }
  | { kind: "set"; id: string; nameHints: string[]; valueType?: TypeNode }
  | { kind: "object"; id: string; nameHints: string[]; props: Map<string, PropertyDef> }
  | {
      kind: "function";
      id: string;
      nameHints: string[];
      props: Map<string, PropertyDef>;
      arity: number;
      isAsync: boolean;
      returnType: TypeNode | null;
    };

interface ExtractContext {
  owner: any;
  key: string;
}

class TypeGenerator {
  private static readonly KNOWN_CONSTRUCTORS = new Map<new (...args: any[]) => any, string>([
    [Date, "Date"],
    [RegExp, "RegExp"],
    [Error, "Error"],
    [Promise, "Promise<unknown>"],
    [ArrayBuffer, "ArrayBuffer"],
    [Uint8Array, "Uint8Array"],
    [Int32Array, "Int32Array"],
    ...(typeof HTMLElement !== "undefined" ? [[HTMLElement, "HTMLElement"] as const] : []),
    ...(typeof Element !== "undefined" ? [[Element, "Element"] as const] : []),
  ] as [new (...args: any[]) => any, string][]);

  private static readonly IGNORED_ROOT_KEYS = new Set<string>(["getRegistry", "registry"]);
  private static readonly IGNORED_PROPERTIES = new Set<string>([
    "constructor",
    "caller",
    "callee",
    "arguments",
    "length",
    "name",
    "prototype",
  ]);

  private store = new Map<string, StoreNode>();
  private visited = new Map<any, { kind: "reference"; id: string }>();
  private namingMap = new Map<string, string>();

  private idCounter = 0;
  private invocationCount = 0;
  private readonly maxInvocations = 250;
  private readonly username: string | null;

  constructor(
    private rootObject: any,
    private rootName: string,
  ) {
    try {
      // Specifically target Platform.username
      this.username = Platform?.username ? String(Platform.username) : null;
    } catch {
      this.username = null;
    }
  }

  public generate(): string {
    this.extract(this.rootObject, this.rootName);
    this.assignNames();
    return this.emitTypeScript();
  }

  private sanitizeString(str: string): string {
    if (this.username && str.includes(this.username)) {
      return str.split(this.username).join("USERNAME");
    }
    return str;
  }

  private isMergeableObject(val: any): boolean {
    if (!val || typeof val !== "object") return false;
    if (Array.isArray(val) || val instanceof Map || val instanceof Set) return false;
    for (const [ctor] of TypeGenerator.KNOWN_CONSTRUCTORS) {
      if (val instanceof ctor) return false;
    }
    return true;
  }

  private extract(value: any, path: string, context: ExtractContext | null = null): TypeNode {
    if (value === null) return { kind: "primitive", type: "null" };
    const basicType = typeof value;
    if (basicType !== "object" && basicType !== "function") {
      return { kind: "primitive", type: basicType };
    }

    for (const [ctor, typeName] of TypeGenerator.KNOWN_CONSTRUCTORS.entries()) {
      try {
        if (value instanceof ctor) return { kind: "class", name: typeName };
      } catch {}
    }

    if (this.visited.has(value)) {
      const ref = this.visited.get(value);
      if (!ref) {
        return { kind: "primitive", type: "unknown" };
      }
      const node = this.store.get(ref.id);
      if (node) node.nameHints.push(this.sanitizeString(path));
      return ref;
    }

    const id = `__Node_${++this.idCounter}`;
    const ref: { kind: "reference"; id: string } = { kind: "reference", id };
    this.visited.set(value, ref);

    const safePath = this.sanitizeString(path);

    if (Array.isArray(value)) {
      const nodeDef: StoreNode = { kind: "array", id, nameHints: [safePath] };
      this.store.set(id, nodeDef);
      nodeDef.elementType = this.processCollectionElements(value, `${safePath}.Item`);
      return ref;
    }

    if (value instanceof Map) {
      const nodeDef: StoreNode = { kind: "map", id, nameHints: [safePath] };
      this.store.set(id, nodeDef);
      nodeDef.keyType = this.processCollectionElements(Array.from(value.keys()), `${safePath}.Key`);
      nodeDef.valueType = this.processCollectionElements(
        Array.from(value.values()),
        `${safePath}.Value`,
      );
      return ref;
    }

    if (value instanceof Set) {
      const nodeDef: StoreNode = { kind: "set", id, nameHints: [safePath] };
      this.store.set(id, nodeDef);
      nodeDef.valueType = this.processCollectionElements(
        Array.from(value.values()),
        `${safePath}.Item`,
      );
      return ref;
    }

    if (typeof value === "function") {
      const funcNodeDef = {
        kind: "function" as const,
        id,
        nameHints: [safePath],
        props: new Map<string, PropertyDef>(),
        arity: value.length,
        isAsync: this.isAsyncFunc(value),
        returnType: this.inferFunctionReturn(value, context, safePath),
      };
      this.store.set(id, funcNodeDef);
      this.extractProperties(value, funcNodeDef, safePath);
      return ref;
    }

    const objNodeDef = {
      kind: "object" as const,
      id,
      nameHints: [safePath],
      props: new Map<string, PropertyDef>(),
    };
    this.store.set(id, objNodeDef);
    this.extractProperties(value, objNodeDef, safePath);
    return ref;
  }

  private extractProperties(
    target: any,
    nodeDef: { props: Map<string, PropertyDef> },
    path: string,
  ): void {
    let currentProto = target;

    while (
      currentProto &&
      currentProto !== Object.prototype &&
      currentProto !== Function.prototype
    ) {
      let descriptors: PropertyDescriptorMap = {};
      try {
        descriptors = Object.getOwnPropertyDescriptors(currentProto);
      } catch {}

      for (const [key, desc] of Object.entries(descriptors)) {
        if (typeof key === "symbol" || TypeGenerator.IGNORED_PROPERTIES.has(key)) continue;
        if (target === this.rootObject && TypeGenerator.IGNORED_ROOT_KEYS.has(key)) continue;

        const cleanKey = this.sanitizeString(key);

        let propVal: any;
        const isGetter = !!desc.get;
        if (isGetter) {
          try {
            propVal = target[key];
          } catch {
            propVal = undefined;
          }
        } else {
          propVal = desc.value;
        }

        if (!nodeDef.props.has(cleanKey)) {
          let pType = this.extract(propVal, `${path}.${cleanKey}`, { owner: target, key });
          const isOpt = propVal === undefined;

          if (pType.kind === "primitive" && pType.type === "undefined") {
            pType = { kind: "primitive", type: "unknown" };
          }

          nodeDef.props.set(cleanKey, {
            type: pType,
            isOptional: isOpt,
            isReadonly: !desc.writable && !desc.set,
          });
        }
      }
      currentProto = Object.getPrototypeOf(currentProto);
    }
  }

  private getObjectSignature(obj: any): string {
    try {
      return Object.keys(obj).sort().join(",");
    } catch {
      return "unknown";
    }
  }

  private processCollectionElements(items: any[], subPath: string): TypeNode {
    const types: TypeNode[] = [];
    const mergeableGroups = new Map<string, any[]>();

    for (const item of items) {
      if (item === undefined || item === null) {
        types.push({ kind: "primitive", type: item === null ? "null" : "undefined" });
      } else if (this.visited.has(item)) {
        const ref = this.visited.get(item);
        if (ref) {
          types.push(ref);
        }
      } else if (this.isMergeableObject(item)) {
        const sig = this.getObjectSignature(item);
        if (!mergeableGroups.has(sig)) mergeableGroups.set(sig, []);

        const group = mergeableGroups.get(sig);
        if (group && group.length < 5) {
          group.push(item);
        }
      } else {
        types.push(this.extract(item, subPath));
      }
    }

    for (const objects of mergeableGroups.values()) {
      if (objects.length === 1) {
        types.push(this.extract(objects[0], subPath));
      } else {
        types.push(this.mergeObjects(objects, subPath));
      }
    }

    return this.collapseUnion(types);
  }

  private mergeObjects(objects: any[], path: string): TypeNode {
    const newId = `__Node_${++this.idCounter}`;
    const nodeDef = {
      kind: "object" as const,
      id: newId,
      nameHints: [path],
      props: new Map<string, PropertyDef>(),
    };
    this.store.set(newId, nodeDef);

    for (const obj of objects) {
      this.visited.set(obj, { kind: "reference", id: newId });
    }

    const allKeys = new Set<string>();
    const objKeyMaps = new Map<any, Map<string, { value: any; isReadonly: boolean }>>();

    for (const obj of objects) {
      const keyMap = new Map<string, { value: any; isReadonly: boolean }>();
      objKeyMaps.set(obj, keyMap);

      let currentProto = obj;
      while (
        currentProto &&
        currentProto !== Object.prototype &&
        currentProto !== Function.prototype
      ) {
        let descriptors: PropertyDescriptorMap = {};
        try {
          descriptors = Object.getOwnPropertyDescriptors(currentProto);
        } catch {}

        for (const [key, desc] of Object.entries(descriptors)) {
          if (typeof key === "symbol" || TypeGenerator.IGNORED_PROPERTIES.has(key)) continue;

          const cleanKey = this.sanitizeString(key);
          allKeys.add(cleanKey);

          if (!keyMap.has(cleanKey)) {
            let propVal: any;
            if (desc.get) {
              try {
                propVal = obj[key];
              } catch {
                propVal = undefined;
              }
            } else {
              propVal = desc.value;
            }
            keyMap.set(cleanKey, { value: propVal, isReadonly: !desc.writable && !desc.set });
          }
        }
        currentProto = Object.getPrototypeOf(currentProto);
      }
    }

    for (const key of allKeys) {
      let missingCount = 0;
      const valuesForKey: any[] = [];
      let isReadonly = true;

      for (const obj of objects) {
        const keyMap = objKeyMaps.get(obj);
        if (!keyMap) continue;
        if (keyMap.has(key)) {
          const data = keyMap.get(key);
          if (!data) continue;
          valuesForKey.push(data.value);
          if (!data.isReadonly) isReadonly = false;
        } else {
          missingCount++;
        }
      }

      const isOptional = missingCount > 0 || valuesForKey.some((v) => v === undefined);
      const definedValues = valuesForKey.filter((v) => v !== undefined);

      let mergedNestedType: TypeNode;
      if (definedValues.length === 0) {
        mergedNestedType = { kind: "primitive", type: "unknown" };
      } else {
        mergedNestedType = this.processCollectionElements(definedValues, `${path}.${key}`);
      }

      nodeDef.props.set(key, {
        type: mergedNestedType,
        isOptional,
        isReadonly,
      });
    }

    return { kind: "reference", id: newId };
  }

  private collapseUnion(types: TypeNode[]): TypeNode {
    const flat = new Map<string, TypeNode>();

    const addType = (t: TypeNode | undefined) => {
      if (!t) return;
      if (t.kind === "union") t.types.forEach(addType);
      else {
        const key =
          t.kind === "primitive"
            ? `prim:${t.type}`
            : t.kind === "class"
              ? `cls:${t.name}`
              : t.kind === "reference"
                ? `ref:${t.id}`
                : JSON.stringify(t);
        flat.set(key, t);
      }
    };

    types.forEach(addType);
    let unique = Array.from(flat.values());

    if (unique.length > 1) {
      unique = unique.filter(
        (t) => !(t.kind === "primitive" && (t.type === "unknown" || t.type === "any")),
      );
    }

    if (unique.length === 0) return { kind: "primitive", type: "unknown" };
    if (unique.length === 1) return unique[0] ?? (undefined as never);

    unique.sort((a, b) => {
      const getCmpName = (node: TypeNode) => {
        if (node.kind === "primitive") return node.type;
        if (node.kind === "class") return node.name;
        if (node.kind === "reference") return node.id;
        return "";
      };
      return getCmpName(a).localeCompare(getCmpName(b));
    });

    return { kind: "union", types: unique };
  }

  private isAsyncFunc(func: (...args: any[]) => any): boolean {
    try {
      const str = func.toString();
      return (
        func.constructor.name === "AsyncFunction" ||
        str.startsWith("async") ||
        str.includes("__awaiter") ||
        str.includes("return new Promise")
      );
    } catch {
      return false;
    }
  }

  private inferFunctionReturn(
    func: (...args: any[]) => any,
    context: ExtractContext | null,
    path: string,
  ): TypeNode | null {
    if (!context || context.owner !== this.rootObject) return null;
    if (func.length !== 0) return null;
    if (!/^get[A-Z0-9_]/.test(context.key)) return null;
    if (TypeGenerator.IGNORED_ROOT_KEYS.has(context.key)) return null;
    if (this.invocationCount++ > this.maxInvocations) return null;

    try {
      const ret = func.call(context.owner);
      return this.extract(ret, `${path}.Return`);
    } catch {
      return null;
    }
  }

  private assignNames(): void {
    const usedNames = new Set<string>();
    const rootEntry = Array.from(this.store.entries()).find(([_, node]) =>
      node.nameHints.includes(this.rootName),
    );

    for (const [id, node] of this.store.entries()) {
      if (id === rootEntry?.[0]) {
        this.namingMap.set(id, this.rootName);
        usedNames.add(this.rootName);
        continue;
      }

      const bestHint =
        [...node.nameHints].sort((a, b) => a.split(".").length - b.split(".").length)[0] || id;

      const cleanHint = bestHint.startsWith(`${this.rootName}.`)
        ? bestHint.slice(this.rootName.length + 1)
        : bestHint;

      let baseName = cleanHint
        .replace(/\[\d+\]/g, "")
        .split(/[._[\]]/)
        .filter(Boolean)
        .map((p) => p.replace(/[^a-zA-Z0-9_$]/g, ""))
        .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : ""))
        .join("");

      if (!baseName) baseName = `Unknown${node.kind.charAt(0).toUpperCase() + node.kind.slice(1)}`;

      let finalName = baseName;
      let counter = 2;
      while (usedNames.has(finalName)) finalName = `${baseName}${counter++}`;

      usedNames.add(finalName);
      this.namingMap.set(id, finalName);
    }
  }

  private resolveTypeString(typeNode: TypeNode | undefined): string {
    if (!typeNode) return "unknown";
    switch (typeNode.kind) {
      case "primitive":
        return typeNode.type;
      case "class":
        return typeNode.name;
      case "reference":
        return this.namingMap.get(typeNode.id) || "unknown";
      case "union": {
        const resolved = typeNode.types.map((t) => this.resolveTypeString(t));
        return Array.from(new Set(resolved)).join(" | ");
      }
      default:
        return "unknown";
    }
  }

  private emitTypeScript(): string {
    const definitions: { name: string; declaration: string }[] = [];

    for (const [id, node] of this.store.entries()) {
      const name = this.namingMap.get(id) || id;
      let declaration = "";

      const isRoot = name === this.rootName;
      const exportStr = isRoot ? "export " : "";

      if (node.kind === "array") {
        declaration = `${exportStr}type ${name} = Array<${this.resolveTypeString(node.elementType)}>;`;
      } else if (node.kind === "map") {
        declaration = `${exportStr}type ${name} = Map<${this.resolveTypeString(node.keyType)}, ${this.resolveTypeString(node.valueType)}>;`;
      } else if (node.kind === "set") {
        declaration = `${exportStr}type ${name} = Set<${this.resolveTypeString(node.valueType)}>;`;
      } else if (node.kind === "object" || node.kind === "function") {
        if (node.kind === "function" && node.props.size === 0) {
          const args = Array.from({ length: node.arity }, (_, i) => `arg${i}: any`).join(", ");
          const ret = node.returnType
            ? this.resolveTypeString(node.returnType)
            : node.isAsync
              ? "Promise<unknown>"
              : "unknown";
          declaration = `${exportStr}type ${name} = (${args}) => ${ret};`;
        } else {
          const propsOutput: string[] = [];

          if (node.kind === "function") {
            const args = Array.from({ length: node.arity }, (_, i) => `arg${i}: any`).join(", ");
            const ret = node.returnType
              ? this.resolveTypeString(node.returnType)
              : node.isAsync
                ? "Promise<unknown>"
                : "unknown";
            propsOutput.push(`  (${args}): ${ret};`);
          }

          const sortedKeys = Array.from(node.props.keys()).sort();
          for (const key of sortedKeys) {
            const prop = node.props.get(key);
            if (!prop) continue;
            const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
            const opt = prop.isOptional ? "?" : "";
            const ro = prop.isReadonly ? "readonly " : "";
            propsOutput.push(`  ${ro}${safeKey}${opt}: ${this.resolveTypeString(prop.type)};`);
          }

          if (propsOutput.length === 0) {
            declaration = `${exportStr}type ${name} = Record<string, unknown>;`;
          } else {
            declaration = `${exportStr}interface ${name} {\n${propsOutput.join("\n")}\n}`;
          }
        }
      }

      definitions.push({ name, declaration });
    }

    definitions.sort((a, b) =>
      a.name === this.rootName ? -1 : b.name === this.rootName ? 1 : a.name.localeCompare(b.name),
    );

    const header = `// Auto-generated at ${new Date().toISOString()} on Spotify Version: ${String(Platform?.version || "Unknown")}`;
    return [header, ...definitions.map((d) => d.declaration)].join("\n\n");
  }
}

const typesGenerator = new TypeGenerator(Platform, "PlatformAutoGen");
Platform.getClipboardAPI().copy(typesGenerator.generate());
console.log("Types copied to clipboard!");
