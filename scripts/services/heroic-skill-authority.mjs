import { heroicSkillService } from "./heroic-skill-service.mjs";

export function registerHeroicSkillAuthorityOperations(socket) {
  socket.registerOperation("hero.getForbiddenRiteOptions", (payload, context) => heroicSkillService.getForbiddenRiteOptions(payload, context.senderUserId));
  socket.registerOperation("hero.forbiddenRiteRecycle", (payload, context) => heroicSkillService.forbiddenRiteRecycle(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("hero.reassignResolutionVanguard", (payload, context) => heroicSkillService.reassignResolutionVanguard(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("hero.revealVanguard", (payload, context) => heroicSkillService.revealVanguard(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("hero.reverseVanguard", (payload, context) => heroicSkillService.reverseVanguard(payload, context.senderUserId), { stateChange: true });
}
