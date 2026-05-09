type Predicate<A> = (input: A) => boolean;

export const fnStr = (f: unknown): string => {
  try {
    return (f as (...args: never) => unknown).toString();
  } catch {
    try {
      return Function.prototype.toString.call(f);
    } catch {
      return "";
    }
  }
};
export function findBy(...tests: Array<string | RegExp | Predicate<any>>) {
  const testFns = tests.map((test): Predicate<any> => {
    switch (typeof test) {
      case "string":
        return (x) => fnStr(x).includes(test);
      case "function":
        return (x) => test(x);
      default: // assume regex
        return (x) => test.test(fnStr(x));
    }
  });
  const testFn = (x: any) => testFns.map((t) => t(x)).every(Boolean);
  return <A>(xs: A[]) => xs.find(testFn) ?? (undefined as never);
}

// assumption: str[start] === pair[0]
export const findMatchingPos = (
  str: string,
  start: number,
  direction: 1 | -1,
  pair: [string, string],
  scopes: number,
) => {
  let l = scopes;
  let i = start + direction;

  while (l > 0 && i >= 0 && i < str.length) {
    const c = str[i];
    i += direction;
    if (c === pair[0]) l++;
    else if (c === pair[1]) l--;
  }

  return i;
};

export const matchLast = (str: string, pattern: RegExp) => {
  const matches = str.matchAll(pattern);
  return Array.from(matches).at(-1) ?? (undefined as never);
};

export function stringifyUrlSearchParams(params: Record<string, string | string[]>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        searchParams.append(key, v);
      }
    } else {
      searchParams.append(key, value);
    }
  }
  return searchParams.toString();
}
