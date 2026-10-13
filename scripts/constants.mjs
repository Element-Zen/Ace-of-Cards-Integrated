export const MODULE_ID = "ace-of-cards-integrated";
export const MODULE_TITLE = "Ace of Cards Integrated";
export const MODULE_VERSION = "1.0.1";
export const ACTOR_DECK_SCHEMA_VERSION = 11;
export const STYLE_LIBRARY_SCHEMA_VERSION = 5;
export const STYLE_SCHEMA_VERSION = 3;
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;
export const PLAY_STATE_CHANGED_HOOK = `${MODULE_ID}.playStateChanged`;
export const PLAY_ACTOR_CHANGED_HOOK = `${MODULE_ID}.playActorChanged`;
export const PLAY_CARD_SCALE_CHANGED_HOOK = `${MODULE_ID}.playCardScaleChanged`;
export const FORBIDDEN_RITE_EXPLANATION = "Because Magic Cards discarded a Joker, you may choose any number of eligible non-Joker cards from your discard pile and shuffle them into your deck.";
export const STYLES_CHANGED_HOOK = `${MODULE_ID}.stylesChanged`;
export const SOCKET_EVENTS = Object.freeze({ STATE_CHANGED: "play.stateChanged", STYLES_CHANGED: "style.changed" });

export const SETTINGS = Object.freeze({
  CUSTOM_STYLES: "customStyles",
  LEGACY_CUSTOM_LOOKS: "customLooks",
  DEBUG: "debugLogging",
  AUTHORITY_TIMEOUT: "authorityTimeout",
  PLAY_CARD_SCALE: "playCardScale",
  CARD_SCALE_MIGRATED: "cardScaleMigrated",
  GM_CARD_SCALE: "gmCardScale",
  PLAYER_CARD_SCALE: "playerCardScale",
  CROSS_ENCOUNTER_DECK: "crossEncounterDeck",
  ENCOUNTER_AUTO_OPEN_ACTOR: "encounterAutoOpenActor",
  PLAY_DRAWER_DIRECTION: "playDrawerDirection",
  PLAY_EXTRAS_WINDOW_RECT: "playExtrasWindowRect",
});

export const ACTOR_FLAGS = Object.freeze({ DECK: "deck" });

export const DECK_STATUS = Object.freeze({
  READY: "ready",
  ACTIVE: "active",
  CORRUPT: "corrupt",
  MIGRATION_PENDING: "migration-pending",
});

export const CARD_ZONES = Object.freeze(["hand", "discard", "vanguard"]);
export const SUITS = Object.freeze(["earth", "air", "fire", "ice"]);
export const DAMAGE_TYPES = Object.freeze(["air", "earth", "fire", "ice"]);

export const PROJECTFU_HOOKS = Object.freeze({
  GET_SIDEBAR_TOOLS: "projectfu.getSidebarTools",
  GET_SYSTEM_CONTROL_TOOLS: "projectfu.getSystemControlTools",
});

export const PROJECTFU_FUIDS = Object.freeze({
  CLASS: "ace-of-cards",
  MAGIC_CARDS: "magic-cards",
  HIGH_OR_LOW: "high-or-low",
  MULLIGAN: "mulligan",
  TRAP_CARD: "trap-card",
  BLACK_WHITE: "black-white",
  CARD_VANGUARD: "card-vanguard",
  DUEL_MASTER: "duel-master",
  FORBIDDEN_RITE: "forbidden-rite",
});
