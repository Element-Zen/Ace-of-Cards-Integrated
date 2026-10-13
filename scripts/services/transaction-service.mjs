import { actorDeckStore, projectActorDeckState } from "./actor-deck-store.mjs";
import { resolveEncounterContext } from "./encounter-context-service.mjs";

export class AceTransactionService {
  #queues = new Map();

  async run(actor, holderUserId, callback, context = {}) {
    const previous = this.#queues.get(actor.uuid) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.finally(() => gate);
    this.#queues.set(actor.uuid, tail);
    await previous.catch(() => undefined);

    try {
      const container = await actorDeckStore.ensure(actor);
      const encounterContext = container.configuration?.crossEncounterDeck
        ? { combatUuid: "", sceneUuid: "", conflictId: "persistent" }
        : resolveEncounterContext(context);
      const source = projectActorDeckState(container, encounterContext);
      return await callback({
        actor,
        holderUserId,
        transactionId: foundry.utils.randomID(),
        container,
        context: encounterContext,
        source,
      });
    } finally {
      release();
      if (this.#queues.get(actor.uuid) === tail) this.#queues.delete(actor.uuid);
    }
  }
}

export const transactionService = new AceTransactionService();
