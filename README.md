# E2EE Chat

A self-hosted, end-to-end encrypted chat app for you and your friends. Use it in the browser or in the desktop app (Windows, macOS, Linux). The server stores and relays only encrypted data. It can't read your messages, files or group names.

- Direct messages and group chats with admins
- Add friends by their user ID (`7K3Q-X9PA`), block anyone
- Rich text, code blocks with syntax highlighting, replies, reactions, edit and delete
- Read receipts (optional), typing indicators, profile pictures
- Encrypted files and images (up to 10 MB)
- Search (all chats or one), pinned, archived and muted chats (for a while, or mentions only)
- Forward and star messages, a media gallery per chat
- Messages written offline are sent when you're back online
- History on all your devices, and encrypted backups you can import again
- See and sign out your devices, or delete your account
- Installable as an app on phones (PWA); the desktop app updates itself
- One Rust binary with SQLite, nothing else to run

## Security

- Your keys are created on your device. They are stored on the server locked with your password, so you can sign in on other devices. Your password never leaves your device.
- Every message is encrypted for each recipient and signed by the sender. The server can't read, forge or alter messages.
- Each friend's key is remembered when you first add them. If it ever changes, you get a warning.

**The server can see:** usernames, IDs, friend and block lists, IP addresses, when you're online, and who messages whom, when, and how much.

**Limitations:**
- No forward secrecy. If your keys leak, so does your history.
- There is no password reset. A forgotten password means a lost account.
- The web version runs code served by the server. If you don't trust whoever runs the server, use the desktop app.
- The design hasn't been audited. The crypto libraries it uses ([@noble](https://paulmillr.com/noble/)) have been.

## Self-hosting

```bash
docker build -t e2ee-chat .
docker run -d -p 127.0.0.1:8080:8080 -v e2ee-chat-data:/data e2ee-chat
```

Put it behind HTTPS, for example with Caddy: `chat.example.com { reverse_proxy localhost:8080 }`. Don't let the proxy strip the server's Content-Security-Policy header.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `DATA_DIR` | `./data` | Where the database is stored |
| `RETENTION_DAYS` | `180` | Delete messages older than this from the server |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy, so rate limits use the real client IP |

## Desktop app

Download it from [Releases](../../releases) and enter your server's address on first start. The builds aren't code-signed, so your OS may warn you.

## Development

```bash
cargo run -p e2ee-chat-server          # server on :8080
cd web && bun install && bun run dev   # web UI with hot reload
cd web && bunx tauri dev               # desktop app
```

Tests: `cargo test -p e2ee-chat-server` and `cd web && bun test`.

## License

[MIT](LICENSE)
