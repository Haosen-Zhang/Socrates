const SENSITIVE_NAME = String.raw`(?:api[_-]?key|authorization|token|access[_-]?token|secret|client[_-]?secret|password|credential|cookie|private[_-]?key|proxy[_-]?password|aws_(?:access_key_id|secret_access_key|session_token))`;
const SENSITIVE_ASSIGNMENT = new RegExp(String.raw`\b(${SENSITIVE_NAME})\b\s*[:=]\s*([^\s,;]+)`, "giu");
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const CREDENTIAL_MATERIAL = new RegExp(
  String.raw`(?:\b${SENSITIVE_NAME}\b\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-[A-Za-z0-9_-]{8,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\b(?:npm|hf)_[A-Za-z0-9_-]{20,}\b|\bAIza[A-Za-z0-9_-]{30,}\b|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----)`,
  "iu",
);

export function containsCredentialMaterial(value: string): boolean {
  return CREDENTIAL_MATERIAL.test(value);
}

export function redactDiagnostic(value: unknown, exactSecrets: readonly string[] = []): string {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  for (const secret of exactSecrets.filter((item) => item.length >= 4).sort((left, right) => right.length - left.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(BEARER, "Bearer [REDACTED]").replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]").slice(0, 2_000);
}

export function redactObject(value: unknown, exactSecrets: readonly string[] = []): unknown {
  if (typeof value === "string") return redactDiagnostic(value, exactSecrets);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, exactSecrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key, new RegExp(SENSITIVE_NAME, "iu").test(key) ? "[REDACTED]" : redactObject(item, exactSecrets),
  ]));
}
