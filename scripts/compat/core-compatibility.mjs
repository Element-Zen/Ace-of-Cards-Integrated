const SUPPORTED_GENERATIONS = Object.freeze([13, 14]);

function generationFromVersion(version = globalThis.game?.version ?? "0") {
  const generation = Number.parseInt(String(version).split(".")[0], 10);
  return Number.isInteger(generation) ? generation : 0;
}

function hasFunction(value) {
  return typeof value === "function";
}

export function inspectCoreCompatibility() {
  const generation = generationFromVersion();
  const checks = [
    {
      key: "generation",
      label: "Foundry generation",
      ok: SUPPORTED_GENERATIONS.includes(generation),
      detail: generation ? `v${generation}` : "unknown",
    },
    {
      key: "actorFlags",
      label: "Actor module flags",
      ok: hasFunction(globalThis.Actor?.prototype?.getFlag) && hasFunction(globalThis.Actor?.prototype?.setFlag),
      detail: hasFunction(globalThis.Actor?.prototype?.getFlag) && hasFunction(globalThis.Actor?.prototype?.setFlag) ? "available" : "runtime check pending",
      soft: !globalThis.Actor,
    },
    {
      key: "worldSettings",
      label: "World settings",
      ok: hasFunction(globalThis.game?.settings?.get) && hasFunction(globalThis.game?.settings?.set),
      detail: hasFunction(globalThis.game?.settings?.get) && hasFunction(globalThis.game?.settings?.set) ? "available" : "runtime check pending",
      soft: !globalThis.game,
    },
    {
      key: "applicationV2",
      label: "ApplicationV2",
      ok: hasFunction(globalThis.foundry?.applications?.api?.ApplicationV2),
      detail: hasFunction(globalThis.foundry?.applications?.api?.ApplicationV2) ? "available" : "missing",
    },
    {
      key: "handlebarsMixin",
      label: "HandlebarsApplicationMixin",
      ok: hasFunction(globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin),
      detail: hasFunction(globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin) ? "available" : "missing",
    },
    {
      key: "dialogV2",
      label: "DialogV2",
      ok: hasFunction(globalThis.foundry?.applications?.api?.DialogV2?.confirm),
      detail: hasFunction(globalThis.foundry?.applications?.api?.DialogV2?.confirm) ? "available" : "missing",
    },
  ];

  const hardFailures = checks.filter((check) => !check.ok && !check.soft);
  return {
    generation,
    supported: hardFailures.length === 0,
    checks,
    hardFailures,
  };
}

export function assertCoreCompatibility() {
  const report = inspectCoreCompatibility();
  if (report.supported) return report;
  const details = report.hardFailures.map((check) => `${check.label}: ${check.detail}`).join(", ");
  throw new Error(`Unsupported Foundry core environment (${details}).`);
}

export const CoreCompatibility = Object.freeze({
  supportedGenerations: SUPPORTED_GENERATIONS,
  inspect: inspectCoreCompatibility,
  assert: assertCoreCompatibility,
});
