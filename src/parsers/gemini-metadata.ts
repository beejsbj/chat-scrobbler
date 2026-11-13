/** Fixture-backed metadata shapes. A changed shape stays unknown, even at a known slot. */
export function isGeminiMetadata(scope: string, index: number, value: unknown): boolean {
  const vector = (length: number, type: string) => Array.isArray(value) && value.length === length && value.every(item => typeof item === type);
  if (scope === "gemini.user") {
    if ([1, 3, 5].includes(index)) return typeof value === "number";
    if (index === 4) return typeof value === "string" && /^[a-f0-9]{16}$/i.test(value);
    if (index === 8) return typeof value === "boolean";
  }
  if (scope === "gemini.response") {
    if (index === 1) return Array.isArray(value) && value.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === "string" && typeof row[1] === "number");
    if (index === 8) return typeof value === "string" && /^[A-Z]{2}$/.test(value);
    if ([14, 17].includes(index)) return typeof value === "string" && /^[a-f0-9]{16}$/i.test(value);
    if ([24, 25].includes(index)) return typeof value === "number";
    // The model id string. The display name that fills `Message.model` is slot 21.
    if (index === 31) return typeof value === "string" && /^[\w.\- ]{1,48}$/.test(value);
    if ([4, 5].includes(index)) return Array.isArray(value) && value.length > 0 && value.every(isToolLabel);
  }
  if (scope === "gemini.candidate") {
    if ([6, 15, 27].includes(index)) return typeof value === "boolean";
    if (index === 8) return vector(1, "number");
    if (index === 9) return typeof value === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(value);
    if (index === 21) return vector(1, "boolean");
    if (index === 44) return vector(3, "number");
    if (index === 12) return Array.isArray(value) && value.length === 22 && value.every((item, i) =>
      i === 6 ? Array.isArray(item) && item.length === 1 && item[0] === 0
        : i === 7 ? Array.isArray(item) && !item.length : item === null);
    if (index === 37) return isSearchBranding(value);
  }
  return false;
}

function isSearchBranding(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2 || JSON.stringify(value[0]) !== '[""]' || !Array.isArray(value[1])) return false;
  return value[1].every(row => Array.isArray(row) && row.length === 5 && JSON.stringify(row[0]) === '[""]'
    && row[1] === "" && row[2] === "Google Search" && row[4] === "search"
    && row[3] === "https://www.gstatic.com/images/branding/productlogos/googleg/v6/192px.svg");
}

/** Tool activity row `[null, [tool key, [null, null, display name, icon, ...], n, ...]]`: a label the interface draws, no content. */
function isToolLabel(row: unknown): boolean {
  if (!Array.isArray(row) || row.length !== 2 || row[0] !== null || !Array.isArray(row[1])) return false;
  const [key, display, order] = row[1];
  return typeof key === "string" && Array.isArray(display) && display[0] === null && display[1] === null
    && typeof display[2] === "string" && typeof display[3] === "string" && typeof order === "number";
}
