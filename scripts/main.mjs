import { ACTOR_DECK_SCHEMA_VERSION, MODULE_ID, MODULE_VERSION } from "./constants.mjs";
import { createPublicApi } from "./api.mjs";
import { assertCoreCompatibility } from "./compat/core-compatibility.mjs";
import { validateRuntimeContracts } from "./data/runtime-contracts.mjs";
import { registerProjectFUSidebarTool } from "./hooks/sidebar-tools.mjs";
import { registerProjectFUSystemControl } from "./hooks/system-controls.mjs";
import { registerAceChatActions } from "./hooks/chat-actions.mjs";
import { registerProjectFUTriggerHooks } from "./hooks/projectfu-triggers.mjs";
import { registerActorSheetAccess } from "./hooks/actor-sheet-access.mjs";
import { registerStyleRegistryHooks } from "./hooks/style-registry.mjs";
import { initializeEncounterLifecycle, registerEncounterLifecycleHooks } from "./hooks/encounter-lifecycle.mjs";
import { styleSettingsStore } from "./services/style-settings-store.mjs";
import { actorDeckStore } from "./services/actor-deck-store.mjs";
import { registerDeckAuthorityOperations } from "./services/deck-authority.mjs";
import { registerStyleAuthorityOperations } from "./services/style-authority.mjs";
import { registerPlayAuthorityOperations } from "./services/play-authority.mjs";
import { registerHeroicSkillAuthorityOperations } from "./services/heroic-skill-authority.mjs";
import { registerClassSkillAuthorityOperations } from "./services/class-skill-authority.mjs";
import { socketService } from "./services/socket-service.mjs";
import { normalizeClientSettings, registerSettings } from "./settings.mjs";
import { registerStyleConfigurationMenus } from "./hooks/player-style-menu.mjs";
import { Log } from "./util/log.mjs";
import { migrateLegacyInteractiveChatMessages } from "./services/elemental-suit-migration-service.mjs";
import { initializeCrossEncounterWorldSetting } from "./services/cross-encounter-world-service.mjs";

registerProjectFUSidebarTool();
registerProjectFUSystemControl();
registerProjectFUTriggerHooks();
registerAceChatActions();
registerActorSheetAccess();
registerStyleRegistryHooks();
registerEncounterLifecycleHooks();
registerDeckAuthorityOperations(socketService);
registerStyleAuthorityOperations(socketService);
registerPlayAuthorityOperations(socketService);
registerHeroicSkillAuthorityOperations(socketService);
registerClassSkillAuthorityOperations(socketService);

Hooks.once("init", () => {
  assertCoreCompatibility();
  registerSettings();
  registerStyleConfigurationMenus();

  const module = game.modules.get(MODULE_ID);
  if (module) module.api = createPublicApi();

  Log.info(`Initialized version ${MODULE_VERSION}.`);
});

Hooks.once("ready", async () => {
  socketService.initialize();

  try {
    await normalizeClientSettings();
  } catch (error) {
    Log.error("Unable to normalize the client card-size setting.", error);
  }

  try {
    validateRuntimeContracts();
  } catch (error) {
    Log.error("Runtime contract validation failed during startup.", error);
    ui.notifications.error("Ace of Cards Integrated failed its runtime contract validation. See the console.");
    return;
  }

  if (game.users.activeGM?.isSelf) {
    try {
      await styleSettingsStore.migrateLibrary();
    } catch (error) {
      Log.error("Unable to migrate the Ace card Style library.", error);
      ui.notifications.error("Ace of Cards could not migrate the Style library. Original data was retained.");
    }
  }

  if (game.users.activeGM?.isSelf) {
    try {
      const result = await styleSettingsStore.migrateLegacyLooks();
      if (result.migrated) Log.info(`Migrated ${result.migrated} card Style record(s) from the alpha.37 Look library.`);
    } catch (error) {
      Log.error("Unable to migrate the legacy card Look library to Styles.", error);
      ui.notifications.error("Ace of Cards Integrated could not migrate one or more card Styles. See the console.");
    }
  }

  if (game.users.activeGM?.isSelf) {
    try {
      const result = await styleSettingsStore.migrateElementalSuits();
      if (result.migrated) Log.info(`Migrated ${result.migrated} custom card Style record(s) to elemental card identities.`);
    } catch (error) {
      Log.error("Unable to migrate custom card Styles to elemental card identities.", error);
      ui.notifications.error("Ace of Cards Integrated could not migrate one or more card Styles. See the console.");
    }
  }

  if (game.users.activeGM?.isSelf) {
    try {
      const result = await styleSettingsStore.migrateCardBacks();
      if (result.migrated) Log.info(`Restored a card back for ${result.migrated} custom card Style record(s).`);
    } catch (error) {
      Log.error("Unable to restore custom Style card backs.", error);
      ui.notifications.error("Ace of Cards Integrated could not restore one or more Style card backs. See the console.");
    }
  }

  try {
    styleSettingsStore.hydrate();
  } catch (error) {
    Log.error("Unable to hydrate Ace card Styles.", error);
    ui.notifications.error("Ace of Cards Integrated could not hydrate its card Styles. See the console.");
  }

  if (game.users.activeGM?.isSelf) {
    try {
      const result = await actorDeckStore.migrateExisting();
      if (result.migrated) Log.info(`Migrated ${result.migrated} Actor card state flag(s) to schema ${ACTOR_DECK_SCHEMA_VERSION}.`);
      if (result.customMappingActors?.length) {
        const names = result.customMappingActors.join(", ");
        Log.warn(`Removed obsolete custom suit mappings from: ${names}. Cards now use Earth, Air, Fire, and Ice directly.`);
        ui.notifications.warn(`Ace of Cards removed obsolete custom suit mappings from ${result.customMappingActors.length} Actor deck(s). See the console for names.`);
      }
      if (result.reviewActors?.length) {
        Log.warn(`Preserved malformed Actor deck flags for GM review: ${result.reviewActors.join(", ")}.`);
        ui.notifications.warn(`${result.reviewActors.length} Ace deck state(s) still need GM review. Their original flags were preserved.`);
      }
    } catch (error) {
      Log.error("Unable to migrate existing Actor card state.", error);
      ui.notifications.error("Ace of Cards Integrated could not migrate one or more Actor card states. See the console.");
    }
  }

  try {
    await initializeCrossEncounterWorldSetting();
  } catch (error) {
    Log.error("Unable to initialize the world-wide Cross-Encounter Deck setting.", error);
    ui.notifications.error("Ace of Cards Integrated could not initialize Cross-Encounter Deck mode. See the console.");
  }

  if (game.users.activeGM?.isSelf) {
    try {
      const result = await migrateLegacyInteractiveChatMessages();
      if (result.migrated) Log.info(`Migrated ${result.migrated} historical Ace chat message(s); ${result.closed} interactive result surface(s) were closed.`);
      if (result.failed.length) Log.warn("Some historical Ace chat messages could not be migrated.", result.failed);
    } catch (error) {
      Log.error("Unable to migrate historical Ace chat messages to elemental card identities.", error);
      ui.notifications.warn("Some historical Ace chat messages could not be migrated. See the console.");
    }
  }

  try {
    initializeEncounterLifecycle();
  } catch (error) {
    Log.error("Unable to initialize Encounter-bound Ace state.", error);
    ui.notifications.error("Ace of Cards Integrated could not synchronize the current Encounter. See the console.");
  }

});
