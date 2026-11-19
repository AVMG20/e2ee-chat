import * as engine from './engine'

export type { ChatState, CropArea } from './engine'

/**
 * The chat engine API used by the UI. Every async function throws Error with a
 * user-facing message on failure.
 */
export const chat = {
  /**
   * Reactive state:
   *   status, error, account (null when signed out), contacts (Dict by user ID),
   *   requests { incoming, outgoing }, groups, conversations, active, messages,
   *   syncing (true while downloading history after sign-in),
   *   typing (conv → user IDs typing now), firstUnread (id of the first unread message when the active conv was opened),
   *   hasOlder (more messages before state.messages), highlight (message to scroll to), reads (active conv: user ID →
   *   ts of the newest message they've read; my message is "seen" by them if its ts <= that), blocked (users I blocked),
   *   settings { readReceipts }, starred ("<conv> <msg id>" → true; use isStarred). Conversations have muted (right now),
   *   mutedUntil, mentionsOnly, pinned, archived; contacts and account have avatar (URL or null).
   *   My messages with status 'sending' are queued (e.g. while offline) and go out after reconnecting;
   *   'failed' ones can be sent again with retryMessage.
   */
  state: engine.state,
  /** True inside the Tauri desktop app. */
  isDesktop: engine.isDesktop,
  /** Prefill for the server URL field: page origin in the browser, last used server on desktop. */
  defaultServer: engine.defaultServer,
  /** Last username used on this device (for prefill), or ''. */
  lastUsername: engine.lastUsername,

  /** Call once at startup: resumes the saved session if there is one. Resolves true if signed in. */
  restore: engine.restore,
  /** Creates an account (keys are made and locked with the password on this device). */
  register: engine.register,
  /** Signs in on this device. Downloads the locked keys and unlocks them with the password. Takes ~2 s. */
  login: engine.login,
  /** Signs out and deletes all local data on this device (everything is restored on next sign-in). */
  logout: engine.logout,
  /** Changes the password (re-locks the keys). Signs out all other devices. */
  changePassword: engine.changePassword,
  /** My signed-in devices (Device[]), most recently used first; `current` is this one. */
  listDevices: engine.listDevices,
  /** Signs out another device by Device.id. It deletes its local data when it next connects (right away if online). */
  signOutDevice: engine.signOutDevice,
  /** Deletes the account on the server and all data on this device, after checking the password. Can't be undone. */
  deleteAccount: engine.deleteAccount,
  /** All chats and files on this device as one encrypted file ({ blob, name }); only this account can import it. */
  exportBackup: engine.exportBackup,
  /** Adds the chats from a backup file made by this account. Resolves to counts of what was added (ImportResult). */
  importBackup: engine.importBackup,
  /** Readable name of this device ("Firefox on Linux"). */
  deviceName: engine.deviceName,

  /** "7K3QX9PA" → "7K3Q-X9PA" for display. */
  formatId: engine.formatId,
  /** Name for a user ID: "You" style is left to the UI; returns own username for own ID. */
  displayName: engine.displayName,
  /** Send a friend request to a user ID (dash/case/spaces ignored). Accepts automatically if they already asked you. */
  sendFriendRequest: engine.sendFriendRequest,
  acceptFriend: engine.acceptFriend,
  /** Declines an incoming request or cancels an outgoing one. */
  declineFriend: engine.declineFriend,
  removeFriend: engine.removeFriend,

  /**
   * Opens a conversation: puts its newest messages in state.messages (more via loadOlder) and
   * clears unread. With `focus` (a message id), also loads up to that message and sets state.highlight.
   */
  open: engine.openConv,
  /** Sends a Tiptap doc to the active conversation, optionally as a reply to a message. */
  sendText: engine.sendText,
  /** Sends a file/image to the active conversation (optionally as a reply). Throws if larger than MAX_FILE_BYTES. */
  sendFile: engine.sendFile,
  /** Replaces the text of one of my own text messages, for everyone. */
  editMessage: engine.editMessage,
  /** Deletes one of my own messages for everyone (it disappears from the chat). */
  deleteMessage: engine.deleteMessage,
  /** Toggles my reaction with this emoji on a message. */
  react: engine.react,
  /**
   * Calls `cb` for each new message from someone else that arrives while signed in
   * (not for history downloaded at sign-in). Returns an unsubscribe function.
   * Use it for desktop notifications / sounds.
   */
  onIncoming: engine.onIncoming,
  /** Call on composer input while there's text: tells the active conversation I'm typing (throttled). */
  typing: engine.typing,
  /** Plain-text preview of a message, as shown in the sidebar. */
  previewText: engine.previewText,
  /** Where the desktop app can be downloaded. */
  desktopDownloadUrl: engine.desktopDownloadUrl,
  /** Object URL for a file message's content (cached), or null if unavailable. */
  fileUrl: engine.fileUrl,
  /** Creates a group with me + friends (user IDs) and opens it. Returns its conversation id. */
  createGroup: engine.createGroup,
  /** Adds friends (user IDs) to a group. */
  addMembers: engine.addMembers,
  leaveGroup: engine.leaveGroup,
  /** Rename a group (admins only). */
  renameGroup: engine.renameGroup,
  /** Remove a member from a group (admins only). */
  removeMember: engine.removeMember,
  /** Make a member an admin or not (admins only). A group always keeps at least one admin. */
  setAdmin: engine.setAdmin,
  /** Is this user (default: me) an admin of the group? */
  isGroupAdmin: engine.isGroupAdmin,
  /** Block a user: ends the friendship; their requests and messages no longer reach me. Listed in state.blocked. */
  blockUser: engine.blockUser,
  unblockUser: engine.unblockUser,
  /**
   * Mute / pin / archive a conversation, synced to my devices: setConvPrefs(convId, { muted: true }).
   * Timed mute: { muted: true, mutedUntil: Date.now() + 3600_000 }. { mentionsOnly: true }: notify only for
   * @mentions of me and replies to me.
   */
  setConvPrefs: engine.setConvPrefs,
  /** Whether an incoming message should notify / play a sound (respects mute and mentions-only). */
  shouldNotify: engine.shouldNotify,
  /** Turn read receipts (others seeing that I read their messages) on or off. state.settings.readReceipts. */
  setReadReceipts: engine.setReadReceipts,
  /**
   * Set (File/Blob) or remove (null) my profile picture: setAvatar(file, { x, y, size }) with the square to keep,
   * in the image's own pixels (default: the middle). Sent encrypted to my contacts.
   */
  setAvatar: engine.setAvatar,
  /** Put the next page of older messages on screen (state.hasOlder says if there are any). */
  loadOlder: engine.loadOlder,
  /**
   * Search the history on this device: all words must match. Newest first. Open a hit with open(hit.conv, hit.msg.id).
   * search(query, { conv }) searches one conversation only; { limit } caps the hits (default 50).
   */
  search: engine.search,
  /** Send one of my failed messages again. */
  retryMessage: engine.retryMessage,
  /** Forward a text or file message to other conversations: forwardMessage(msg, [convId, ...]). Shown as "Forwarded". */
  forwardMessage: engine.forwardMessage,
  /** Star / unstar a message (private, synced to my devices). */
  toggleStar: engine.toggleStar,
  isStarred: engine.isStarred,
  /** My starred messages on this device as SearchHit[], newest first. */
  starredMessages: engine.starredMessages,
  /** File and image messages of a conversation, newest first. Show with fileUrl(msg). */
  mediaOf: engine.mediaOf,
  /** True for file messages that are images shown inline (png, jpeg, gif, webp, avif). */
  isImage: engine.isImage,
  setVerified: engine.setVerified,
  /** Accept a contact's changed key: trustNewKey(userId, contact.pendingFingerprint). */
  trustNewKey: engine.trustNewKey,
}
