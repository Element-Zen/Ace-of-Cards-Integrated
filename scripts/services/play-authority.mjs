import { deckPlayService } from "./deck-play-service.mjs";

export function registerPlayAuthorityOperations(socket) {
  socket.registerOperation("play.getState", (payload, context) => deckPlayService.getState(payload, context.senderUserId));
  socket.registerOperation("play.ensureDeck", (payload, context) => deckPlayService.ensureDeck(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.getActiveStates", (payload, context) => deckPlayService.getActiveStates(payload, context.senderUserId));
  socket.registerOperation("play.startEncounter", (payload, context) => deckPlayService.startEncounter(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.endEncounter", (payload, context) => deckPlayService.endEncounter(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.draw", (payload, context) => deckPlayService.draw(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.reverseDraw", (payload, context) => deckPlayService.reverseDraw(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.resetEncounter", (payload, context) => deckPlayService.resetEncounter(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.revealHand", (payload, context) => deckPlayService.revealHand(payload, context.senderUserId));
  socket.registerOperation("play.resolveMagicCards", (payload, context) => deckPlayService.resolveMagicCards(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.reverseMagicCards", (payload, context) => deckPlayService.reverseMagicCards(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.discard", (payload, context) => deckPlayService.discard(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("play.gmMoveCard", (payload, context) => deckPlayService.gmMoveCard(payload, context.senderUserId), { stateChange: true });
}
