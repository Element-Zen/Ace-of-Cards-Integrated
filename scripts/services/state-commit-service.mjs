import {
  actorDeckStore,
  createConfiguredActorDeckState,
  mergeActorDeckEncounter,
  prepareActorDeckContainer,
  prepareActorDeckState,
  projectActorDeckState,
} from "./actor-deck-store.mjs";

export class AceStateCommitService {
  async commit({ actor, container, current, next, event, context = {} }) {
    let root = prepareActorDeckContainer(container);
    let state;

    if (event?.kind === "configuration") {
      root = createConfiguredActorDeckState(root, next?.configuration ?? current?.configuration);
      state = projectActorDeckState(root, context);
    } else if (["encounter-end", "conflict-end"].includes(event?.kind)) {
      if (root.configuration?.crossEncounterDeck) {
        state = projectActorDeckState(root, {});
      } else {
        const removalState = prepareActorDeckState({
          ...current,
          conflict: {
            active: true,
            id: current?.conflict?.id,
            combatUuid: current?.conflict?.combatUuid ?? context?.combatUuid,
            sceneUuid: current?.conflict?.sceneUuid ?? context?.sceneUuid,
          },
          status: "active",
        });
        root = mergeActorDeckEncounter(root, removalState, { remove: true });
        state = projectActorDeckState(root, context);
      }
    } else {
      const prepared = prepareActorDeckState(next);
      root = mergeActorDeckEncounter(root, prepared);
      state = projectActorDeckState(root, prepared.conflict);
    }

    await actorDeckStore.set(actor, root);
    return { state, container: root, event: structuredClone(event ?? {}) };
  }
}

export const stateCommitService = new AceStateCommitService();
