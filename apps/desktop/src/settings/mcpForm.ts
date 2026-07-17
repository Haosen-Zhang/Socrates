export function parseSecretLines(value: string): { keys: string[]; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const keys: string[] = [];
  for (const line of value.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const separator = line.indexOf("=");
    const key = (separator < 0 ? line : line.slice(0, separator)).trim();
    if (!key || keys.includes(key)) continue;
    keys.push(key);
    if (separator >= 0 && line.slice(separator + 1)) values[key] = line.slice(separator + 1);
  }
  return { keys, values };
}
