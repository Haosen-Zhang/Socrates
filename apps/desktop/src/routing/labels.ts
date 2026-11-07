type Translator = (key: string, variables?: Record<string, string | number>) => string;

export function routingMessage(t: Translator, code: string): string {
  if (code.startsWith("capability_missing:")) return t("route_capability_missing", { capability: t(`route_capability_${code.slice("capability_missing:".length)}`) });
  if (code.startsWith("routing_no_feasible_candidate:")) return t("route_no_feasible_hint");
  const key = `route_reason_${code}`;
  const translated = t(key);
  return translated === key ? t(code) : translated;
}
