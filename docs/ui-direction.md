# UI Direction

Popcorn Queue should follow QUI's default light utility style, not the optional
dark themes. The baseline visual language is a dense web app for repeated
operator work: white content canvas, very light gray sidebar, thin borders,
low shadows, compact controls, icon-led navigation, and a table-first queue.

## QUI References

- Default theme: `minimal`, with white background, neutral foreground, light
  muted surfaces, subtle borders, and black primary actions.
- App shell: collapsible desktop sidebar, sticky header, mobile footer
  navigation, instance scope controls, and a content area built around tables.
- Components: compact buttons, search input in the header, small status badges,
  filter sidebars, persistent layout controls, and right-side detail panels.
- Art direction: restrained and utilitarian. Use status colors as small signals
  only; avoid neon, hero sections, big gradients, decorative cards, and dark
  dashboard chrome as the default.

## Popcorn Queue Application

The first screen is the upload queue, because this is an operational tool. It
shows browser-bridge checks, backend PTP cache state, upload phases, and review
gates in one place. The desktop layout keeps high-frequency controls visible:
navigation and instances on the left, search and actions in the top bar, filters
beside the table, and an inspector on the right.

Mobile should keep the same work surface but reduce chrome: the sidebar and
inspector collapse away, search remains prominent, actions wrap without overlap,
and the footer navigation mirrors QUI's mobile pattern.

## Palette

Use neutral light surfaces as the default:

- Background: white.
- Sidebar and filter surfaces: near-white gray.
- Borders: subtle neutral gray.
- Primary action and active navigation: near-black.
- Status accents: green for running/clean, amber for review, blue for queued or
  cache signals, red for failures, and purple for ready/manual review.

This keeps the app visually close to QUI while giving upload state enough color
to scan quickly.
