import { classSkillService } from "./class-skill-service.mjs";

export function registerClassSkillAuthorityOperations(socket) {
  socket.registerOperation("skill.mulligan", (payload, context) => classSkillService.mulligan(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("skill.trapCard", (payload, context) => classSkillService.trapCard(payload, context.senderUserId), { stateChange: true });
  socket.registerOperation("skill.reverseDiscardAction", (payload, context) => classSkillService.reverseDiscardAction(payload, context.senderUserId), { stateChange: true });
}
