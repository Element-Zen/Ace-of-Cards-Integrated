import { deckConfigurationService } from "./deck-configuration-service.mjs";

let registered = false;

export function registerDeckAuthorityOperations(socketService) {
  if (registered) return;
  socketService.registerOperation("deck.getSummaries", (payload, context) =>
    deckConfigurationService.getSummaries(payload.actorUuids, context.senderUserId),
  );
  socketService.registerOperation("deck.configure", (payload, context) =>
    deckConfigurationService.configure(payload, context.senderUserId),
    { stateChange: true },
  );
  registered = true;
}
