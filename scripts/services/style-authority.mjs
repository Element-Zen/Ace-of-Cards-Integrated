import { styleService } from "./style-service.mjs";

let registered = false;
export function registerStyleAuthorityOperations(socketService) {
  if (registered) return;
  socketService.registerOperation("style.list", (payload, context) => styleService.list(payload, context.senderUserId));
  socketService.registerOperation("style.create", (payload, context) => styleService.create(payload, context.senderUserId), { styleChange: true });
  socketService.registerOperation("style.update", (payload, context) => styleService.update(payload, context.senderUserId), { styleChange: true });
  socketService.registerOperation("style.activate", (payload, context) => styleService.activate(payload, context.senderUserId), { styleChange: true });
  socketService.registerOperation("style.delete", (payload, context) => styleService.delete(payload, context.senderUserId), { styleChange: true });
  socketService.registerOperation("style.assign", (payload, context) => styleService.assign(payload, context.senderUserId), { styleChange: true });
  registered = true;
}
