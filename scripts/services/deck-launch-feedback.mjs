import { Log } from "../util/log.mjs";

export class AceDeckLaunchError extends Error {
  constructor(message, code = "launch-unavailable") {
    super(message);
    this.name = "AceDeckLaunchError";
    this.code = code;
    this.expected = true;
  }
}

export function reportDeckLaunchFailure(error, { source = "unknown" } = {}) {
  const message = String(error?.message ?? "Ace of Cards could not open the deck.");
  if (error?.expected === true || error?.name === "AceDeckLaunchError") {
    Log.warn("Ace of Cards deck launch was unavailable.", {
      source,
      code: String(error?.code ?? "launch-unavailable"),
      message,
    });
    ui.notifications.warn(message);
    return;
  }
  Log.error(`Ace of Cards deck launch failed unexpectedly (${source}).`, error);
  ui.notifications.error(message || "Ace of Cards could not open the deck. See the console for details.");
}
