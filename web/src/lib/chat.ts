import * as engine from './engine'

export type { ChatState } from './engine'

/**
 * The chat engine API used by the UI. Every async function throws Error with a
 * user-facing message on failure.
 */
export const chat = {
  /**
   * Reactive state:
   *   status, error, account (null when signed out), contacts (Dict by user ID),
   *   requests { incoming, outgoing }, groups, conversations, active, messages,
   *   syncing (true while downloading history after sign-in).
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
  /** Changes the password (re-locks the keys). Other devices stay signed in. */
  changePassword: engine.changePassword,

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

  /** Opens a conversation, loads its messages into state.messages, clears unread. */
  open: engine.openConv,
  /** Sends a Tiptap doc to the active conversation. */
  sendText: engine.sendText,
  /** Sends a file/image to the active conversation. Throws if larger than MAX_FILE_BYTES. */
  sendFile: engine.sendFile,
  /** Object URL for a file message's content (cached), or null if unavailable. */
  fileUrl: engine.fileUrl,
  /** Creates a group with me + friends (user IDs) and opens it. Returns its conversation id. */
  createGroup: engine.createGroup,
  /** Adds friends (user IDs) to a group. */
  addMembers: engine.addMembers,
  leaveGroup: engine.leaveGroup,
  /** My own key fingerprint, formatted for display. */
  myFingerprint: engine.myFingerprint,
  setVerified: engine.setVerified,
  /** Accept a contact's changed key: trustNewKey(userId, contact.pendingFingerprint). */
  trustNewKey: engine.trustNewKey,
}
