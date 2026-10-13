/** Split an already validated JSON array without reserializing its entries. */
export function captureJsonEntries(serialized: string): string[] {
  if (!serialized.trimStart().startsWith("[")) return [serialized];
  const entries: string[] = [];
  let depth = 0, quoted = false, escaped = false, start = -1;
  for (let i = serialized.indexOf("[") + 1; i < serialized.length; i++) {
    const char = serialized[i];
    if (start < 0 && !/\s/.test(char) && char !== "]") start = i;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || (char === "]" && depth > 0)) depth--;
    else if ((char === "," || char === "]") && depth === 0) {
      if (start >= 0) entries.push(serialized.slice(start, i).trimEnd());
      start = -1;
      if (char === "]") break;
    }
  }
  return entries;
}
