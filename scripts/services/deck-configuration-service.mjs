import {
  createConfiguredActorDeckState,
  createDefaultActorDeckContainer,
  projectActorDeckState,
} from "./actor-deck-store.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import { normalizeDeckConfiguration, summarizeDeckState } from "./deck-configuration-helpers.mjs";
import { stateCommitService } from "./state-commit-service.mjs";
import { actorDeckStore } from "./actor-deck-store.mjs";
import { transactionService } from "./transaction-service.mjs";

export class AceDeckConfigurationService {
  async getSummaries(actorUuids, senderUserId) {
    const requester = game.users.get(senderUserId);
    if (!requester) throw new Error("The requesting user no longer exists.");
    const summaries = [];
    for (const actorUuid of [...new Set(actorUuids ?? [])]) {
      const actor = await projectFUAdapter.resolveActor(actorUuid);
      if (!actor || !projectFUAdapter.canUserManageActor(actor, requester)) continue;
      if (!projectFUAdapter.hasMagicCards(actor)) continue;
      const container = actorDeckStore.getContainer(actor) ?? createDefaultActorDeckContainer();
      summaries.push(summarizeDeckState(actor, projectActorDeckState(container), requester, container));
    }
    return summaries;
  }

  async configure(payload, senderUserId) {
    const { actor, requester } = await this.#resolveAuthorized(payload.actorUuid, senderUserId);
    const styleConfiguration = normalizeDeckConfiguration(payload.configuration);
    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.container;
      this.#assertRevision(current, payload.expectedRevision);
      if (current.status === "active") throw new Error("Card configuration cannot change during an active encounter.");
      const configuration = { ...current.configuration, ...styleConfiguration };
      const next = createConfiguredActorDeckState(current, configuration);
      const committed = await stateCommitService.commit({
        ...tx,
        current,
        next,
        userId: senderUserId,
        event: {
          kind: "configuration",
          summary: "Updated Ace card artwork configuration.",
          details: { previous: current.configuration, next: configuration },
        },
      });
      return summarizeDeckState(actor, projectActorDeckState(committed.container), requester, committed.container);
    });
  }

  async #resolveAuthorized(actorUuid, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the requesting user or Actor.");
    if (!projectFUAdapter.canUserManageActor(actor, requester)) throw new Error("You do not own this Actor.");
    if (!projectFUAdapter.hasMagicCards(actor)) throw new Error("This Actor does not possess Magic Cards.");
    return { actor, requester };
  }

  #assertRevision(current, expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null) return;
    if (Number(current.revision) !== Number(expectedRevision)) throw new Error("This Ace card state changed since the window was opened. Refresh and try again.");
  }
}

export const deckConfigurationService = new AceDeckConfigurationService();
