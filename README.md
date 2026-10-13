# Ace of Cards Integrated

**Ace of Cards Integrated** is a ProjectFU module for running the Fabula Ultima Ace of Cards class in Foundry Virtual Tabletop. It provides encounter-scoped or persistent Actor hands, card actions, Vanguard handling, reversible results, GM correction tools, and named personal Deck Styles with per-user artwork, saved presets, and GM assignment controls.

## Requirements

- Foundry Virtual Tabletop 13
- ProjectFU
- The official Fabula Ultima rules, including the Ace of Cards class material

Foundry V13 is the only supported and verified manifest generation (`minimum: 13`, `verified: 13`). V14 compatibility is not claimed. This manifest declaration is not a separate Foundry certification or a substitute for testing the module in Foundry.

## Features

### Deck play modes

- With **Cross-Encounter Deck** off, creates one independent Ace state for each started Foundry Encounter and removes it when that Encounter ends.
- With **Cross-Encounter Deck** on, creates one persistent deck per Ace Actor that is independent of Scenes and Encounters.
- Initializes either mode with a five-card opening hand and restores persisted state after a server restart.
- When persistent mode is enabled, the GM may optionally migrate one active Encounter deck by Scene or start fresh on first open.

### Player hand drawer

- Opens through ProjectFU controls or the Actor-sheet **Card Deck** control.
- Displays the selected Actor's active encounter or persistent hand, occupied Vanguard cards, and the face-down deck.
- Supports card selection, legal-set recognition, card-size settings, wheel navigation, and local drag reordering.
- Keeps hand ordering local to the viewing client; authoritative card contents and zones remain synchronized.

### Ace actions

- Supports Forbidden Monarch, Jackpot, Magic Flush, Blinding Flush, Full Status, Triple Support, Double Trouble, and Magic Pair. Magic Pair remains manual guidance and does not intercept later ProjectFU Checks.
- Supports Mulligan, Trap Card, High or Low, Black & White, Forbidden Rite, and Card Vanguard workflows. Affinity-bypassing damage uses ProjectFU's native inline damage control without a separate Ace damage request.
- Publishes ProjectFU-compatible results and provides reversible Ace zone changes when the authoritative deck revision still permits an exact reversal.

### Personal card styles

- Players open **My Deck Style** from ProjectFU → Utilities; GMs open **Edit Deck Styles** from Foundry → Configure Settings → Module Settings → Ace of Cards Integrated.
- Players choose only among GM-saved styles; changing the dropdown immediately sets that user's personal appearance across every Actor deck they view. Players cannot create, edit, rename, or delete artwork presets.
- **Save as New** allows GMs to create a preset from its 30 card faces and card back. Only GMs may edit or delete presets. **Flair by Zenfyre** is the built-in Standard and cannot be overwritten or deleted. **Pixel by Kami** (artwork by Kami Lucky) is an included alternate Style and is also read-only; either included Style can be copied with **Save as New**.
- Under Foundry **Configure Settings → Module Settings → Ace of Cards Integrated → Manage Player Deck Styles**, a GM can assign a different style to each user, including offline players. These assignments are defaults, not locks: a player can change their own selection at any time.
- A user without an individual assignment inherits **Set as Default Style**. Deleting a custom preset resets affected individual assignments to Flair by Zenfyre. Artwork source files are never deleted.
- Artwork in already-created chat messages is a historical snapshot; it does not dynamically restyle per viewer.

### GM tools

- **Piles** exposes Vanguard, Discards, and Hand for inspection.
- GMs can move visible cards between zones to correct state.
- In persistent mode, an Actor owner or GM may reset that deck; encounter-scoped resets remain GM-only.
- **Edit Deck Styles** (Configure Settings → Module Settings → Ace of Cards Integrated) opens the GM-only 31-image card/back editor. This is separate from the player-assignment submenu.
- **Save** updates a custom preset; **Save as New** creates a separate preset; **Set as Default Style** chooses the fallback for unassigned users; **Delete** removes a custom preset.
- **Manage Player Deck Styles** in Module Settings is GM-only; players may override their assignments through the read-only style selector. Personal selection does not alter Actor deck flags.

### Deliberate limits

The module does not forcibly spend MP, choose targets, apply optional effects, or reverse ProjectFU HP, MP, damage, status, targeting, or attacks. It automates the Ace card state and publishes the relevant ProjectFU-facing result and controls.

## Storage and authority

- Actor flags store compact, versioned encounter records or one link-free persistent Actor deck under `ace-of-cards-integrated`.
- A world setting stores saved card styles, user-ID keyed selections, and the world fallback style ID. Alpha.110/111 active world art is preserved during upgrade; offline user assignments remain persisted.
- Client settings store local presentation preferences such as card size and drawer direction.
- Mutations are executed by the active GM through the module socket namespace.
- Revision checks and per-Actor transaction queues reject stale or conflicting operations.

The Actor deck schema is version 11. The style library schema is version 5, and individual styles continue at schema version 3.

## Installation

The installed module path must be:

```text
{UserData}/Data/modules/ace-of-cards-integrated/module.json
```

Release ZIPs contain one top-level folder named `ace-of-cards-integrated`. Remove older `ace-of-cards-class-fu` installations before installing this package.

The previous alpha package ID and the current package ID are separate Foundry namespaces. Existing settings and Actor flags stored under `ace-of-cards-class-fu` are not automatically migrated.

## Distribution

Official source repository: https://github.com/Element-Zen/Ace-of-Cards-Integrated

Foundry manifest (latest published release): https://github.com/Element-Zen/Ace-of-Cards-Integrated/releases/latest/download/module.json

Version 1.0.0 installation ZIP: https://github.com/Element-Zen/Ace-of-Cards-Integrated/releases/download/v1.0.0/ace-of-cards.zip

The manifest also includes the repository issue-tracker and hosted changelog links. Upload `module.json` and `ace-of-cards.zip` as two separate assets to the GitHub release tagged `v1.0.0`. These links are not live until the GitHub release is published.

## Use

Use the native **Ace of Cards** control exposed through ProjectFU, the Actor-sheet **Card Deck** control, or the public API:

```js
const ace = game.modules.get("ace-of-cards-integrated").api;

await ace.openActorDeck();
await ace.toggleActorDeck();
await ace.macro.toggleDeck();
await ace.macro.openPiles();
```

The card style API is also available:

```js
const library = await ace.styles.list(); // { styles, activeStyleId }
const style = library.styles.find(s => s.styleId === "standard");
const saved = await ace.styles.create({
  name: "My Style",
  cardBack: "modules/example/cards/back.webp",
  faces: { ...style.faces, "fire-3": "modules/example/cards/fire-3.webp" }
});
await ace.styles.activate(saved.styleId); // Sets the fallback for users without an individual selection
// await ace.styles.delete(saved.styleId); // Reverts the fallback to Flair by Zenfyre when deleting the active custom Style
```

## Permissions

- Players with sufficient Actor permission may inspect the corresponding Ace hand.
- Owners and GMs may perform normal card actions for that Actor.
- GM authority controls shared mutations, Piles correction, encounter lifecycle synchronization, and card-style authoring.

## Current validation status

The development source for version 1.0.0 passes the automated Node regression suite and JavaScript syntax checks. Tests and developer tooling are intentionally excluded from the distribution ZIP but retained in the separate development source archive.

The module declares Foundry V13 compatibility only. Live Foundry V13 GM/player end-to-end verification has not been performed as part of this packaging pass, including ProjectFU controls, drawing/discard synchronization, Piles, and per-player Style selection. This verification is still needed before publicly advertising that the release was tested in a live V13 environment.


## License

See [LICENSE.md](LICENSE.md) for package usage terms and the required Fabula Ultima third-party notice.
