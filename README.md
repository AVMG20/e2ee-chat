# E2EE Chat

A small, self-hosted chat app for you and your friends, with **end-to-end encryption**.
Run the server on your own box. Chat in the browser or with the desktop app (Windows, macOS, Linux).

The server can never read your messages, files or group names. It only stores and relays
encrypted blobs.

- Open sign-up with a username and password. One account works in the browser and the desktop app, on as many devices as you like
- Add friends by their user ID (like `7K3Q-X9PA`), Discord style. Only friends can DM you or add you to a new group
- Usernames keep their capitals (`AVMG`) but are unique and signed in to regardless of case
- Direct messages and group chats (as many groups as you like)
- Rich text (bold, italic, lists, quotes, links) and Discord-style code blocks (```` ```js ````) with syntax highlighting
- Replies, reactions, editing and deleting your own messages, typing indicators, @mentions
- Quick switcher (Ctrl/Cmd+K), a friends list, desktop notifications, light and dark themes
- Encrypted file and image sharing (up to 10 MB)
- Message history on every device you sign in to (kept encrypted on the server for 180 days)
- Warnings if someone's key ever changes
- One small Rust server binary with SQLite. No other services needed.

MIT licensed. Built with Rust (axum, Tauri), Vue 3, shadcn-vue, Tiptap and the audited
[`@noble`](https://paulmillr.com/noble/) crypto libraries.

## How the encryption works

Your keys are created on your device when you sign up.

| Key | Algorithm | Used for |
|---|---|---|
| Signing key | Ed25519 | signing every message |
| Encryption key | X25519 | receiving message keys |

To use the same account on several devices, the private keys are stored on the server
**locked with your password**:

- Your password goes through **Argon2id** (64 MB, 3 passes) on your device. Two keys are derived from the result.
- The *login key* is sent to the server, which stores only its hash.
- The *lock key* never leaves your device. It encrypts your private keys (XChaCha20-Poly1305) before they're uploaded.
- Signing in on a new device downloads the locked keys and unlocks them with your password.

The server never sees your password, so it can't unlock your keys. Contact keys you've pinned,
"verified" marks and your groups are synced between your devices the same way, encrypted.

Sending a message (DM or group):

1. The payload (text, file, or group update) is encrypted with a fresh random key using **XChaCha20-Poly1305**.
2. That key is wrapped separately for each recipient using an ephemeral X25519 key exchange + **HKDF-SHA256**.
3. The whole envelope (sender, time, ciphertext, a hash commitment to the message key, recipient
   list) is **signed with Ed25519**.
4. Recipients check the signature against the sender's **pinned** key before decrypting, so the
   server can't forge, alter or re-route messages. Each device remembers which messages it has
   already processed and refuses repeats, so the server can't replay them either.

Edits, deletions, reactions and typing indicators are encrypted, signed messages too; only
the author can edit or delete a message. Typing indicators are relayed live and never stored.
A deleted message disappears on every device, but its encrypted copy stays on the server until
it expires.

Groups exist only inside encrypted messages. The server never learns a group's name or id.

**What the server *can* see:** usernames, user IDs, who is friends with whom, public keys, your IP
address and when you're online (and when you're typing to someone), and for every message: who sent it, who it
goes to, when, and how big it is. A group message is sent to all members at once, so the server
can see who tends to talk together (a likely member list), just not what the group is called or
what is said.

### Trusting your friends' keys

The first time you see someone's key, the app trusts it ("trust on first use") and remembers it
on all your devices, so the server can't swap it later. Keys don't change when someone reinstalls
or changes their password, so if a friend's key ever does change, the app holds their new messages
and warns you until you accept the new key. The one moment a malicious server could swap a key
unnoticed is when you first add someone; there is no manual fingerprint check.

### Known limitations

This is a hobby-scale app, not Signal. In particular:

- No forward secrecy. Your keys are the same on all your devices, and the server keeps encrypted
  messages for 180 days, so whoever gets your keys (or password plus the server's database) can
  read that history.
- Changing your password signs out your other devices and re-locks your keys, but it doesn't
  replace them. If you think your keys leaked, make a new account.
- **Your password protects your keys.** Whoever has the server's database can try to guess it
  offline (Argon2id makes each guess slow, but a weak password will still fall). Use a long one.
  There is no password reset: if you forget it, your account is gone.
- The server can't forge messages or settings, but it can withhold or delay them, serve an older
  copy of your synced settings, or give a new device a wrong password salt (sign-in then just fails).
- On a signed-in device, keys and history sit unencrypted in the browser/app storage (IndexedDB).
  Signing out deletes them from that device.
- The **web version** trusts the JavaScript served by your server. If you don't trust the server
  operator, use the **desktop app**, which ships its own copy of the UI.
- The crypto design hasn't been professionally audited (the libraries it uses have been).

## Self-hosting

### Docker

```bash
docker build -t e2ee-chat .
docker run -d --name e2ee-chat -p 127.0.0.1:8080:8080 -v e2ee-chat-data:/data e2ee-chat
```

Open `http://your-server:8080`, create an account, and send your user ID to your friends.
**Put it behind HTTPS** (e.g. Caddy: `chat.example.com { reverse_proxy localhost:8080 }`).

### Without Docker

```bash
cd web && bun install && bun run build && cd ..
cargo build --release -p e2ee-chat-server
WEB_DIR=web/dist ./target/release/e2ee-chat-server
```

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | port to listen on |
| `BIND` | `0.0.0.0` | address to listen on |
| `DATA_DIR` | `./data` | where `chat.db` lives |
| `WEB_DIR` | none | built web app (`web/dist`) to serve |
| `RETENTION_DAYS` | `180` | encrypted messages older than this are deleted from the server |
| `TRUST_PROXY` | `false` | set to `true` behind a reverse proxy, so rate limits use the client's IP from `X-Forwarded-For` (only honoured when the connection comes from a private or loopback address) |

Each user can store up to 512 MB of (encrypted) messages and files on the server. Sign-in and
sign-up are rate-limited per IP (per /64 for IPv6). An account can be signed in on up to 10
devices at once.

The server sends a strict Content-Security-Policy with the web app. If you put it behind a reverse
proxy, don't let the proxy strip or replace that header.

## Desktop app

Download it from [Releases](../../releases), or build it yourself:

```bash
cd web && bun install && bunx tauri build
```

On first start, enter your server's address (e.g. `https://chat.example.com`).
Links in messages open in your normal browser.
The macOS and Windows builds aren't code-signed, so you may need to allow them in your OS security settings.

## Development

```bash
# terminal 1: server (API only)
cargo run -p e2ee-chat-server
# terminal 2: web UI with hot reload (proxies /ws to :8080)
cd web && bun install && bun run dev
# desktop app with hot reload
cd web && bunx tauri dev
```

Tests: `cargo test -p e2ee-chat-server` and `cd web && bun test`.

## License

[MIT](LICENSE)
