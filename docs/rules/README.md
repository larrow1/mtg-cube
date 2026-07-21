# MTG Comprehensive Rules corpus

Plain-text extraction of the official Magic: The Gathering Comprehensive Rules
(effective 2026-06-19), split by top-level section so rule lookups are a fast
`grep` instead of a 300-page PDF read. Source: `MagicCompRules 20260619.pdf`.

Use the `mtg-rules` subagent (`.claude/agents/mtg-rules.md`) to query this
corpus; it knows the layout below and returns exact rule numbers + text.

## File map (rule number → file)

| Rules | File | Highlights |
| --- | --- | --- |
| 100–122 | section-1-game-concepts.md | 104 ending the game, 106 mana, 107 numbers/symbols, 114 targets, 117 **priority**, 118 costs, 119 life, 120 damage, 121 drawing, 122 counters |
| 200–212 | section-2-parts-of-a-card.md | 202 **mana cost & color**, 203 illustration, 205 type line, 208 power/toughness |
| 300–315 | section-3-card-types.md | 302 creatures, 305 **lands**, 304 instants, 307 sorceries |
| 400–408 | section-4-zones.md | 401 library, 402 hand, 403 battlefield, 405 **stack** |
| 500–514 | section-5-turn-structure.md | 505 **main phase (land plays)**, 506–511 combat steps, 512 end step, 514 cleanup |
| 600–616 | section-6-spells-abilities-effects.md | 601 **casting spells**, 602 activated abilities, 603 triggered abilities, 605 mana abilities, 608 resolution, 614 replacement effects |
| 700–730 | section-7-additional-rules.md | 701 keyword actions, 702 **keyword abilities (702.8 flash, 702.20 haste…)**, 704 state-based actions, 716 shortcuts |
| 800–811 | section-8-multiplayer-rules.md | multiplayer variants |
| 900–905 | section-9-casual-variants.md | casual variants |
| Glossary | glossary.md | term definitions A–Z |

## Grep tips

- Rules are numbered like `601.2b` at line starts: `grep -n "^601\.2" section-6-*.md`
- The extraction keeps the PDF's hard line wraps — grab context with `-A 3`.
- Quotes/dashes were normalized to ASCII; the trademark char became `'`.
