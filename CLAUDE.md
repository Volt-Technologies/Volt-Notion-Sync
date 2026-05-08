# Volt-Notion-Sync — Claude notes

## Consumer projects

Every repo that consumes this CLI (via `npx github:Volt-Technologies/Volt-Notion-Sync`) lives under `C:\Users\GonzaloRios\Repositories\Projects`. Current set:

- `Kirsch-International-BC`
- `OnwardReserve`
- `RL-Williams-Company`
- `WhiteAndWarren`

Each has a `.volt/.volt-sync.yml` config and a GitHub Actions workflow that pulls/pushes on a webhook + cron + manual trigger. When making changes to the CLI that consumers need to opt into (new config keys, behavioral toggles), update all four `.volt-sync.yml` files in the same change.
