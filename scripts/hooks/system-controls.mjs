import { PROJECTFU_HOOKS } from "../constants.mjs";
import { toggleActorDeck } from "../api.mjs";
import { reportDeckLaunchFailure } from "../services/deck-launch-feedback.mjs";

export function registerProjectFUSystemControl() {
  Hooks.on(PROJECTFU_HOOKS.GET_SYSTEM_CONTROL_TOOLS, (tools) => {
    tools.push({
      name: "ACEOC.Play.SystemControlHint",
      icon: "fa-solid fa-cards",
      onClick: () => {
        void Promise.resolve()
          .then(() => toggleActorDeck())
          .catch((error) => {
            reportDeckLaunchFailure(error, { source: "projectfu-system-control" });
          });
      },
    });
  });
}
